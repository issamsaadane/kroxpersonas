# KroxPersonas

Standalone multi-account test launcher. One app, many projects, many test users per project. Click **Launch** on any persona → a new native window opens **inside KroxPersonas** pointed at the project's URL, with its own isolated cookie jar, and the login form is auto-filled and submitted.

## Stack
- Tauri 2 (controller app + persona webviews — both native OS windows owned by the same KroxPersonas process)
- React + TypeScript (controller UI)
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

## How launching works
1. Click **Launch** on a persona card.
2. Tauri spawns a new `WebviewWindow` — a native OS window **owned by KroxPersonas**, using the platform webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux).
3. The window is created in **incognito mode**, so its cookie jar is isolated from every other persona and from any Chrome profile on the system.
4. An `initialization_script` runs on every page load inside the window. It polls for `input[type="email"]` + `input[type="password"]`, fills them with the persona's credentials, and clicks the submit button.
5. Cookies are ephemeral — when you close the window, the session is gone. Next launch auto-logs-in again. That's the point: predictable, repeatable per-persona sessions.

## Why native WebviewWindow instead of spawning Chrome?
- **Owned by the app** — windows show up under the KroxPersonas app group, not in a separate Chrome process.
- **Isolation without directory juggling** — `incognito(true)` gives each window a fresh session; no stale profile dirs to clean up.
- **Auto-login is trivial** — injected `initialization_script` controls every page load in the webview.
- **Works with apps that send `X-Frame-Options: DENY`** (e.g., KroxFlow) — this is a native webview, not an iframe.

## Limitations
- Auto-login assumes a standard `input[type="email"]` + `input[type="password"]` + submit-button login form. Magic-link / OAuth-only flows will need per-project custom scripts (roadmap).
- Passwords are stored in plaintext in `config.json`. Use only for non-production test accounts.
- macOS primary target; Linux/Windows paths are best-effort.

## Roadmap
- Per-project custom auto-login script override (for unusual auth flows).
- Optional OS-keychain credential storage.
- Persona tagging, search, bulk launch-all.
- Side-by-side grid mode (arrange N persona windows in a preset layout).
- Export/import config between machines.
