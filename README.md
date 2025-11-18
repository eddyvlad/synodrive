# Synodrive

Synodrive keeps a single Obsidian vault in sync with a Synology Drive server (DSM 7+/Drive Server 3.5+) over HTTPS using the official `/api/SynologyDrive/default/v1` REST API. It supports one-way uploads and full two-way sync with conflict-safe handling for large vaults.

## Features
- Username/password (+ optional OTP) authentication with encrypted SID storage and session reuse after restart.
- Remote folder browser restricted to `/mydrive`, with folder creation and one-click selection of a remote root.
- Sync modes: one-way up (local → remote only) or two-way (bidirectional, including deletes with a safety cap).
- Exclusions with case-insensitive glob patterns and default ignores for dotfiles, `.obsidian/**`, `.git/**`, and common system files.
- Background sync on a schedule, event-driven sync with a 2 s debounce, and manual "Sync now" command/ribbon menu.
- Conflict copies named `<file> (conflict YYYY-MM-DD-HHmmss)` and logged diagnostics with export.
- Chunked uploads, retry/backoff for 429/5xx, and HTTPS-only enforcement.

## Authentication flow
1. Open **Settings → Synodrive** and select **Connect**.
2. Enter the DSM HTTPS base URL, username, password, and OTP (if enabled). Application passwords are **not** supported.
3. On success, the plugin stores the encrypted SID plus server URL and optional username. Plain passwords are never stored.
4. Sessions are reused until the server expires them; a 401 triggers a fresh login prompt. **Disconnect** clears the SID but keeps cached indices for faster reconnects.

## Installation
1. Install dependencies: `npm install`.
2. Build the plugin: `npm run build`.
3. Copy `dist/main.js`, `dist/styles.css`, and `manifest.json` into your vault at `<Vault>/.obsidian/plugins/synodrive/`.
4. Reload Obsidian and enable **Synodrive** under **Settings → Community plugins**.

## Development
- Dev/watch: `npm run dev`
- Type check: `npm run typecheck`
- Lint: `npm run lint`
- Tests (Vitest): `npm test`
- Production build: `npm run build`

### Project layout
- `src/api/` – Drive client and API definition (`openapi_v1.json`).
- `src/auth/` – Secure session storage helpers.
- `src/sync/` – Indexing, diffing, and sync engine.
- `src/ui/` – Settings tab and modals.
- `styles.css` – UI styling for modals, logs, and ribbon icon.

## Settings overview
- Connection: Connect/Disconnect and status indicator.
- Remote root: Browse `/mydrive` folders and create new ones before selecting a root.
- Sync behavior: Mode (one-way up/two-way), exclusion patterns, background interval (minutes), conflict handling description.
- Advanced: Max concurrent requests, chunk upload size (MB), network timeout (s).
- Diagnostics: View last 200 log lines and export them; show the last sync report.

## Release artifacts
`npm run build` produces `dist/main.js`, `dist/styles.css`, and a copy of `manifest.json`. These files are the only ones required for manual installation or release bundles.
