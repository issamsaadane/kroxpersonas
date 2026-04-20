use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl,
};
use tauri::webview::WebviewBuilder;

// ─── Config types (mirror src/App.tsx) ──────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default)]
    projects: Vec<Project>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    server_url: String,
    #[serde(default)]
    personas: Vec<Persona>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persona {
    id: String,
    name: String,
    email: String,
    password: String,
    label: String,
}

// ─── Pane state (child webviews we manage per label) ───────────────────────

#[derive(Default)]
struct PaneState {
    webviews: Mutex<HashMap<String, Webview>>,
}

// ─── Paths ──────────────────────────────────────────────────────────────────

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("config.json"))
}

// ─── Commands: config ───────────────────────────────────────────────────────

#[tauri::command]
fn load_config(app: AppHandle) -> Result<Config, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(Config::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {path:?}: {e}"))?;
    let cfg: Config = serde_json::from_str(&raw).map_err(|e| format!("parse config: {e}"))?;
    Ok(cfg)
}

#[tauri::command]
fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let path = config_path(&app)?;
    let raw = serde_json::to_string_pretty(&config).map_err(|e| format!("serialise: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| format!("write {tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?}→{path:?}: {e}"))?;
    Ok(())
}

// ─── Auto-login + Tauri-globals-strip init script ──────────────────────────

fn init_script(email: &str, password: &str) -> String {
    let email_js = serde_json::to_string(email).unwrap_or_else(|_| "\"\"".into());
    let pwd_js   = serde_json::to_string(password).unwrap_or_else(|_| "\"\"".into());

    format!(
        r#"
(() => {{
  const TAURI_KEYS = ['__TAURI__','__TAURI_INTERNALS__','__TAURI_INVOKE__','__TAURI_METADATA__','__TAURI_IPC__','__TAURI_POST_MESSAGE__','__TAURI_PATTERN__','__TAURI_EVENT_PLUGIN_INTERNALS__'];
  for (const k of TAURI_KEYS) {{
    try {{ delete window[k]; }} catch (e) {{}}
    try {{ Object.defineProperty(window, k, {{ value: undefined, writable: false, configurable: false }}); }} catch (e) {{}}
  }}

  if (window.__kroxPersonasInstalled) return;
  window.__kroxPersonasInstalled = true;
  const EMAIL = {email};
  const PWD   = {pwd};
  const MAX_TRIES = 60;
  let tries = 0;
  let submitted = false;

  const setVal = (el, v) => {{
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input',  {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }};

  const tryFill = () => {{
    tries++;
    if (submitted) return;
    const emailEl = document.querySelector(
      'input[type="email"], input[name="email"], input[autocomplete*="email"], input[name="username"]'
    );
    const pwdEl = document.querySelector('input[type="password"]');
    if (emailEl && pwdEl) {{
      setVal(emailEl, EMAIL);
      setVal(pwdEl, PWD);
      const btn = document.querySelector(
        'button[type="submit"], input[type="submit"], form button:not([type="button"])'
      );
      submitted = true;
      if (btn) setTimeout(() => btn.click(), 250);
      return;
    }}
    if (tries < MAX_TRIES) setTimeout(tryFill, 200);
  }};

  const kick = () => {{ tries = 0; submitted = false; tryFill(); }};

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', kick);
  }} else {{
    kick();
  }}
  const push = history.pushState;
  history.pushState = function(...a) {{ push.apply(this, a); setTimeout(kick, 100); }};
  window.addEventListener('popstate', () => setTimeout(kick, 100));
}})();
"#,
        email = email_js,
        pwd = pwd_js
    )
}

// ─── URL normalisation ─────────────────────────────────────────────────────

fn normalise_url(raw: &str) -> Result<tauri::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Server URL is empty — set one on the project first.".into());
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    with_scheme
        .parse::<tauri::Url>()
        .map_err(|e| format!("invalid URL '{with_scheme}': {e}"))
}

fn webview_label(persona_id: &str) -> String {
    format!(
        "persona-{}",
        persona_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect::<String>()
    )
}

// ─── Commands: persona panes ───────────────────────────────────────────────

#[tauri::command]
fn open_pane(
    app: AppHandle,
    state: State<'_, PaneState>,
    persona_id: String,
    url: String,
    email: String,
    password: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = normalise_url(&url)?;
    let label = webview_label(&persona_id);

    // If a pane for this persona already exists, just move/resize.
    {
        let map = state.webviews.lock().map_err(|e| format!("lock: {e}"))?;
        if let Some(existing) = map.get(&label) {
            let _ = existing.set_position(LogicalPosition::new(x, y));
            let _ = existing.set_size(LogicalSize::new(width, height));
            return Ok(());
        }
    }

    let webview_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview window not found".to_string())?;

    let script = init_script(&email, &password);
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .incognito(true)
        .initialization_script(&script);

    // In Tauri 2's unstable API, the raw Window exposes `add_child` for
    // spawning additional webviews inside itself. WebviewWindow derefs to
    // Window so `.window()` gives us the underlying handle.
    let window = webview_window.window();
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| format!("add_child: {e}"))?;

    state
        .webviews
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .insert(label, webview);

    Ok(())
}

#[tauri::command]
fn set_pane_bounds(
    state: State<'_, PaneState>,
    persona_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = webview_label(&persona_id);
    let map = state.webviews.lock().map_err(|e| format!("lock: {e}"))?;
    let webview = map
        .get(&label)
        .ok_or_else(|| format!("pane {label} not open"))?;
    let _ = webview.set_position(LogicalPosition::new(x, y));
    let _ = webview.set_size(LogicalSize::new(width, height));
    Ok(())
}

#[tauri::command]
fn close_pane(state: State<'_, PaneState>, persona_id: String) -> Result<(), String> {
    let label = webview_label(&persona_id);
    let mut map = state.webviews.lock().map_err(|e| format!("lock: {e}"))?;
    if let Some(webview) = map.remove(&label) {
        // Best-effort; ignore the result — a closed webview is all we care about.
        let _ = webview.close();
    }
    Ok(())
}

#[tauri::command]
fn close_all_panes(state: State<'_, PaneState>) -> Result<(), String> {
    let mut map = state.webviews.lock().map_err(|e| format!("lock: {e}"))?;
    for (_label, webview) in map.drain() {
        let _ = webview.close();
    }
    Ok(())
}

// ─── Clipboard (manual fallback) ────────────────────────────────────────────

#[tauri::command]
fn copy_creds(email: String, password: String) -> Result<(), String> {
    copy_to_clipboard(&format!("{email}\t{password}"))
}

#[allow(unused_variables)]
fn copy_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        let mut child = Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn pbcopy: {e}"))?;
        child
            .stdin
            .as_mut()
            .ok_or("pbcopy stdin unavailable")?
            .write_all(text.as_bytes())
            .map_err(|e| format!("write pbcopy: {e}"))?;
        child.wait().map_err(|e| format!("pbcopy wait: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        let mut child = Command::new("xclip")
            .arg("-selection")
            .arg("clipboard")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn xclip: {e}"))?;
        child
            .stdin
            .as_mut()
            .ok_or("xclip stdin unavailable")?
            .write_all(text.as_bytes())
            .map_err(|e| format!("write xclip: {e}"))?;
        child.wait().map_err(|e| format!("xclip wait: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        let mut child = Command::new("clip")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn clip: {e}"))?;
        child
            .stdin
            .as_mut()
            .ok_or("clip stdin unavailable")?
            .write_all(text.as_bytes())
            .map_err(|e| format!("write clip: {e}"))?;
        child.wait().map_err(|e| format!("clip wait: {e}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

// ─── Entry ──────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PaneState::default())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            open_pane,
            set_pane_bounds,
            close_pane,
            close_all_panes,
            copy_creds,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
