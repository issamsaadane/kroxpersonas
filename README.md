# KroxPersonas

Standalone multi-account test launcher. One app, many projects, many test users per project. Click **Launch** on any persona → a new Chrome window opens to that project's URL with an isolated cookie jar per persona. First login is manual (creds auto-copied to clipboard); subsequent launches resume the session automatically because cookies persist in per-persona Chrome profiles.

## Stack
- Tauri 2 (controller app shell)
- React + TypeScript (UI)
- System Chrome / Chromium / Edge / Brave (persona windows, isolated via `--user-data-dir`)
- Local JSON config — no cloud, no keychain

## Run (dev)
```bash
npm install
npm run tauri dev
```
First-time compile of the Rust side takes a few minutes.

## Build
```bash
npm run tauri build
```
Produces a `.app` on macOS, `.msi/.exe` on Windows, `.deb/.AppImage` on Linux.

## Data locations
- **Config:** `~/Library/Application Support/com.kroxpersonas.app/config.json` (macOS; equivalent on Linux/Windows)
- **Per-persona Chrome profile:** `~/Library/Application Support/com.kroxpersonas.app/profiles/<persona-id>/`

## How launching works
1. Click **Launch** on a persona card.
2. Tauri spawns the system browser with `--user-data-dir=<profile>` + `--new-window <serverUrl>`.
3. Credentials (`email\tpassword`) land on the clipboard — paste into the login form on first launch.
4. Chrome stores cookies inside the profile dir. Next launch goes straight to the app, already authenticated.
5. Each persona's profile is completely isolated from the others (and from your normal Chrome).

## Limitations (v1)
- Form-fill auto-login is not implemented yet — first login is manual paste.
- Requires Chrome / Chromium / Edge / Brave installed.
- Passwords are stored in plaintext in `config.json`. Use only for non-production test accounts.
- macOS primary target; Linux/Windows paths are best-effort.

## Roadmap
- Auto-fill login forms via Chrome DevTools Protocol.
- Optional OS-keychain credential storage.
- Persona tagging, search, bulk launch.
- Shell via Tauri's own multi-webview for an all-in-one app surface (upgrade path from the Chrome-spawn model).
