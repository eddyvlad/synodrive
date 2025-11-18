# Synodrive agent guide

## How we work
- Target: Obsidian community plugin compiled with TypeScript + esbuild. Entry point `src/main.ts`, bundle to `dist/main.js` with `manifest.json` and `styles.css` alongside.
- Package manager: npm.
- Keep `main.ts` small; put logic under `src/api`, `src/auth`, `src/sync`, `src/ui`, and `src/utils`.
- Externalize `obsidian` when bundling; everything else is bundled.
- Use Lucide icon names with `setIcon`/`addRibbonIcon`.

## Checklist before final handoff/commit
- Run `npm run lint`, `npm run typecheck`, and `npm run build`.
- Run `npm test` (Vitest) to verify diff/rename/conflict/delete/backoff coverage.
- Confirm `dist/` contains `main.js`, `styles.css`, and `manifest.json` after build.
- Only create commits when explicitly asked to do so; otherwise leave the worktree dirty.
- Commit messages must follow Conventional Commits (https://www.conventionalcommits.org/en/v1.0.0/#specification).

## Security and UX
- Enforce HTTPS for the Synology base URL; reject plain HTTP.
- Never store passwords; persist only encrypted SID + minimal session metadata.
- Mask SIDs in logs; do not log vault contents.
- Restrict remote browsing to `/mydrive`; ignore benign "exists" errors when creating folders.
- Conflicts must create background copies named `<file> (conflict YYYY-MM-DD-HHmmss)` with no blocking dialogs.

## Sync rules
- Modes: one-way up (local → remote only) and two-way (bidirectional, includes deletes with safety cap 20).
- Default exclusions are case-insensitive and include dotfiles, `.obsidian/**`, `.git/**`, and system junk.
- Event-driven sync uses a fixed 2 s debounce; background sync honors the configured interval.
- Respect retry/backoff for 429/5xx; chunk uploads above the configured size.
