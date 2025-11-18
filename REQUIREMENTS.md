# Project: Synodrive (Synology Drive sync for Obsidian)

## Goal

Deliver an Obsidian plugin that securely syncs a single vault with Synology Drive (DSM 7+/Drive Server 3.5+) over HTTPS using the official REST API (`/api/SynologyDrive/default/v1`, see `openapi_v1.json`). Support one-way up and two-way sync for large vaults (10k files / 50 GB) with reliable error handling and conflict safety.

---

## Functional Requirements

### 1. Auth & Sessions

* Auth flow:

	* Use DSM **username/password** (+ optional OTP) against `/login` to obtain a `sid`.
	* Do **not** support Synology application passwords.
* Session handling:

	* Attach `cookie: id=<sid>` to all Drive API requests.
	* Cache a “remembered” session and **reuse a valid SID** after Obsidian restarts until it expires.
	* On expiry or 401, prompt again for credentials and OTP if needed.
* Storage:

	* No plain credential storage.
	* Persist only:

		* `sid`
		* `serverBaseUrl`
		* `username` (optional)
		* session metadata (expiry timestamp if available)
	* Encrypt stored auth (secure store or AES-GCM fallback).
* Disconnect:

	* Call the appropriate logout / session-revoke endpoint if available, then clear stored `sid`.
	* Preserve cached indices and mappings for faster reconnection (do **not** wipe them).
* Logging:

	* Mask `sid` and any credential-related values in logs.

### 2. Remote Selection

* Scope:

	* Remote browsing is **restricted to `/mydrive`** only. No Team Folder (`/teamfolder`) support in this version.
* Features:

	* UI browser that:

		* Lists folders: `POST /files/list` with `path`, sorting, and `filter.type=["dir"]`.
		* Allows navigation up/down the folder tree.
		* Can create new folders using `POST /files` with `type=folder`, `conflict_action=stop`, and ignore “exists” errors.
	* User selects exactly one folder as “remote root”.
	* Persist the selected path as `remoteRoot`.

### 3. Sync Modes

* Modes:

	* **One-way up**: local → remote only (no remote → local downloads, no local deletions from remote).
	* **Two-way**: full bidirectional sync, including deletes.
* Exclusions:

	* Default excludes:

		* `.obsidian/**`
		* `.git/**`
		* Common system files (e.g. `.DS_Store`, `Thumbs.db`).
	* Patterns are **not case-sensitive**.
	* Hidden files (dotfiles like `.env`) are excluded by default.
	* User-editable exclusions string array (glob-like patterns).
* Path normalization:

	* Normalize all paths to POSIX (`/`) for both local and remote.

### 4. File Operations (Drive API)

Use the official `/api/SynologyDrive/default/v1` endpoints with these semantics:

* List:

	* `POST /files/list`
	* Request: `path`, sorting options, `filter.type=["dir"]` for folder lists; for files, adjust filter accordingly.
* Create folder:

	* `POST /files`
	* Body: `type=folder`, `conflict_action=stop`
	* Ignore “already exists” error codes.
* Upload:

	* `PUT /files/upload` (multipart)
	* Params: `conflict_action=overwrite`, `path`, required Drive metadata.
	* For files > `chunkMb` (default 8 MB), perform **chunked upload**, restarting from zero if interrupted (no resume).
* Download:

	* `POST /files/download`
	* Body: `files:[{id:<fileId>}]`, `force_download=true`.
* Move/Rename:

	* Prefer **single atomic rename/move** if API supports it:

		* Use `POST /files/move` to move and rename in one operation when possible.
	* Only fall back to split move+rename (move then `PUT /files` to change `name`) if the API requires two steps.

### 5. Diff, Renames & Conflicts

* Indexing:

	* Local index: `{ path, size, mtime, hash? }`.
	* Remote index: `{ path, size, mtime, etagOrHash, fileId, version? }`.
	* Treat markdown and non-markdown attachments identically.
* Rename detection (best-effort):

	* If a file appears deleted at path A and created at path B:

		* Same size.
		* Mtime within a small window.
		* If ambiguous, compute SHA-256 hash to verify.
	* If matched, treat as `renameLocal` / `renameRemote` instead of delete+create.
* Diff rules (per mode):

	* New local only: upload (both modes).
	* New remote only:

		* Two-way: download.
		* One-way up: ignore.
	* Changed local only: upload.
	* Changed remote only:

		* Two-way: download.
		* One-way up: ignore.
	* Both changed: conflict.
* Conflicts:

	* Do not open UI prompts.
	* Create **background conflict copies** with naming:

		* `<filename> (conflict YYYY-MM-DD-HHmmss).ext`
	* Log each conflict in Diagnostics.

### 6. Delete Propagation

* Two-way deletes:

	* If a file is deleted locally and still exists remotely, delete it remotely (prefer Drive’s recycle bin if the API supports it).
	* If a file is deleted remotely and still exists locally, delete it locally.
* One-way up:

	* Local deletions do not delete remote files.
	* Remote deletions do not delete local files.
* Safety cap:

	* Never apply more than **20 deletions** in a single sync run automatically.
	* If a diff would exceed 20 deletions, skip delete operations for that run and log a warning; optionally mark the run as “needs manual review”.

### 7. Scheduling & Events

* Manual:

	* “Sync Now” command runs a full diff & sync.
* Background:

	* Background sync interval in minutes (`intervalMinutes`, 0 disables).
	* Background sync should run even if Obsidian is minimized, as long as the plugin is enabled and the vault is loaded.
* Event-driven:

	* Listen to create/modify/delete/rename events for vault files.
	* Maintain a fixed **2-second debounce** window to coalesce rapid edits.
	* Event-driven sync schedules a “quick” run that only considers changed paths since the last sync (but it still uses the normal diff engine).

---

## Non-Functional Requirements

### Security

* Force **HTTPS** for `serverBaseUrl`. Reject `http://` URIs.
* Encrypt stored auth (e.g., `sid`) using:

	1. Obsidian / Electron secure storage if available; or
	2. AES-GCM with a locally generated key stored via OS keychain / secure storage if feasible; or
	3. Plain storage **only if absolutely necessary**, with a clear warning in UI.
* Never log:

	* Username/password.
	* SID or other session identifiers in full (mask them).
* Do not log file contents.

### Performance

* Target vault: up to 10,000 files, 50 GB.
* Full remote+local index for a warm cache should complete in **<60 seconds** on LAN.
* Achieve sustained sync throughput ≥ 5 MB/s LAN when not limited by chunking or NAS hardware.

### Reliability

* Rate limits:

	* Detect HTTP 429.
	* Respect `Retry-After` header if present.
	* Implement exponential backoff with jitter:

		* Base: 500 ms.
		* Max: 30 s.
* Benign errors:

	* Ignore “folder exists” errors on create.
* Retry network/5xx errors with backoff; surface failures in Diagnostics.

### Compatibility

* Target:

	* Obsidian desktop (Electron) as primary.
	* Mobile: **best-effort** using browser `fetch`, but gracefully degrade if APIs (e.g., secure storage) are missing (disable sync with a clear message instead of crashing).

---

## UI / UX Requirements

### Settings Tab

Sections (one plugin settings view):

1. **Connection**

	* Status field: “Not connected” / “Connected as <username>”.
	* Button:

		* If not connected: “Connect”.
		* If connected: “Disconnect”.
	* On Connect:

		* Open a small form to input:

			* `serverBaseUrl` (HTTPS URL to DSM)
			* `username`
			* `password`
			* optional OTP code (if 2FA enabled)
		* On success:

			* Persist server URL, username (if desired), and encrypted SID.
			* Immediately start initial full sync.

2. **Remote Root**

	* Read-only text showing current remote path under `/mydrive`.
	* “Browse…” button:

		* Opens folder browser using `/files/list` for directories.
		* Allows folder creation via `POST /files` with `type=folder`.
		* Only paths under `/mydrive` are allowed.
	* “Use this folder” to confirm selection.

3. **Sync Behavior**

	* Sync Mode: radio buttons:

		* One-way up
		* Two-way
	* Exclusions:

		* Multiline text box with one pattern per line.
		* Defaults applied if empty:

			* `.obsidian/**`
			* `.git/**`
			* dotfiles and system files.
	* Background sync:

		* Interval (minutes) numeric input. 0 = disabled.
	* Conflict handling:

		* Read-only description explaining conflict strategy:

			* “Conflicts create '<filename> (conflict YYYY-MM-DD-HHmmss).ext' copies and are logged. No prompts.”

4. **Advanced**

	* Max concurrent requests (default: 4).
	* Chunk upload size MB (default: 8).
	* Network timeout seconds (default: 30).

5. **Diagnostics**

	* Shows the last 200 log lines in a scrollable area (include timestamp and level).
	* “Export logs” button: saves logs to a file in the plugin folder.

### Commands & Ribbon

* Commands:

	* Connect to Synology Drive
	* Disconnect from Synology Drive
	* Sync Now
	* Toggle Background Sync
	* Show Last Sync Report
* Ribbon:

	* Single icon; clicking opens a quick menu:

		* Sync Now
		* Toggle Background Sync
		* Open Settings

### Error UI

* All user-visible errors (login failed, network down, permission denied, etc.) show as **notice toasts**.
* For severe or repeated errors, also append a clear entry in Diagnostics.

---

## Build & Test Requirements

### Tooling

* Language: TypeScript.
* Bundler: esbuild.
* Output:

	* `dist/main.js`
	* `dist/styles.css`
	* `manifest.json`
* Externalize `obsidian` from the bundle.

### npm Scripts

* `npm run build` – production build.
* `npm run dev` – watch mode with rebuild.
* `npm run typecheck` – TypeScript `--noEmit` check.
* `npm test` – run tests.

### Tests (Comprehensive)

Use Vitest for unit and integration-style tests with mocked HTTP:

* Unit tests:

	* Diff logic (new/changed/deleted/renamed for both modes).
	* Rename detection (hash-based) under various scenarios.
	* Delete safety cap behavior.
	* Conflict copy naming and creation.
	* Exclusion handling with case-insensitivity and dotfiles.
	* Event debounce logic.
* Integration-style tests:

	* Mock Synology Drive server (HTTP mock or local test server) for:

		* `login` and cookie-based SID session.
		* `/files/list`, `/files`, `/files/upload`, `/files/download`, `/files/move`.
		* 429 with `Retry-After`.
		* 5xx errors, timeouts.
	* Simulate:

		* Initial full sync.
		* Subsequent incremental sync.
		* Two-way deletes and conflicts.
		* Obsidian restart reusing valid SID.

---

## Acceptance Criteria

1. **Auth & Session**

	* User can connect with DSM username/password and optional OTP; `sid` is obtained and stored securely.
	* Session persists across Obsidian restart, reusing valid SID.
	* Disconnect revokes session and clears SID but keeps indices; reconnect is faster.

2. **Remote Root**

	* User can browse only `/mydrive` directories, create folders, and select one as remote root.
	* Sync consistently targets that folder, without unexpected renames or duplicate folder creation.

3. **Sync Behavior**

	* One-way up:

		* New/changed local files upload.
		* Remote changes are not pulled.
		* Local deletes do not delete remote.
	* Two-way:

		* New/changed local and remote files sync both ways.
		* Deletes propagate both ways within safety constraints.
	* Conflict copies are created with correct filename format and logged.
	* Exclusions, dotfile/system file ignores, and case-insensitive patterns work.

4. **Scheduling & Events**

	* Manual “Sync Now” works.
	* Background sync runs at configured interval, even if Obsidian is minimized, while the vault is open.
	* Event-driven sync responds to file changes with fixed 2 s debounce.

5. **Security & Reliability**

	* No plain HTTP.
	* No unmasked `sid` or credentials in logs.
	* Handles 429 with backoff and `Retry-After`.
	* Ignores benign “exists” folder errors.

6. **Build & Tests**

	* `npm run build`, `npm run typecheck`, and `npm test` all pass without errors.
	* Tests cover diff, rename, conflict, delete safety, rate limiting, and basic auth behavior.
