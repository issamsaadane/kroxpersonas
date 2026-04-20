use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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

// ─── Commands: launch persona (native webview inside KroxPersonas) ─────────

/// Build the auto-login initialisation script. Runs on every page load in the
/// persona's webview — polls for an email + password field and submits.
/// Quietly no-ops on pages without a login form, so subsequent navigation is unaffected.
fn auto_login_script(email: &str, password: &str) -> String {
    // Escape the creds safely for embedding in a JS string literal.
    let email_js = serde_json::to_string(email).unwrap_or_else(|_| "\"\"".into());
    let pwd_js   = serde_json::to_string(password).unwrap_or_else(|_| "\"\"".into());

    format!(
        r#"
(() => {{
  if (window.__kroxPersonasInstalled) return;
  window.__kroxPersonasInstalled = true;
  const EMAIL = {email};
  const PWD   = {pwd};
  const MAX_TRIES = 60;       // ~12s at 200ms interval
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

  const kick = () => {{
    tries = 0;
    submitted = false;
    tryFill();
  }};

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', kick);
  }} else {{
    kick();
  }}
  // SPA route changes — re-run in case the login form mounts later.
  const push = history.pushState;
  history.pushState = function(...a) {{ push.apply(this, a); setTimeout(kick, 100); }};
  window.addEventListener('popstate', () => setTimeout(kick, 100));
}})();
"#,
        email = email_js,
        pwd = pwd_js
    )
}

#[tauri::command]
fn launch_persona(
    app: AppHandle,
    persona_id: String,
    persona_name: String,
    url: String,
    email: String,
    password: String,
) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Server URL is empty — set one on the project first.".into());
    }
    // Allow bare hostnames like "localhost:3000" or "app.example.com" by
    // defaulting to http:// when no scheme is present.
    let normalised = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        format!("http://{url}")
    };
    let parsed = normalised
        .parse::<tauri::Url>()
        .map_err(|e| format!("invalid URL '{normalised}': {e}"))?;

    // Unique window label per persona — relaunch replaces the previous window.
    let label = format!("persona-{}", sanitize_label(&persona_id));
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }

    let script = auto_login_script(&email, &password);

    // `incognito(true)` gives each persona its own ephemeral cookie jar / web
    // storage. Cookies are dropped when the window closes, so the auto-login
    // script re-authenticates on every launch — which is exactly what we want
    // for side-by-side persona testing.
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(format!("{persona_name} — {}", persona_id_short(&persona_id)))
        .inner_size(1200.0, 800.0)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .incognito(true)
        .initialization_script(&script)
        .build()
        .map_err(|e| format!("build persona window: {e}"))?;

    Ok(())
}

/// Close an open persona window (by id). No-op if it isn't open.
#[tauri::command]
fn close_persona(app: AppHandle, persona_id: String) -> Result<(), String> {
    let label = format!("persona-{}", sanitize_label(&persona_id));
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| format!("close: {e}"))?;
    }
    Ok(())
}

// ─── Clipboard (fallback "Copy creds" button) ───────────────────────────────

#[tauri::command]
fn copy_creds(email: String, password: String) -> Result<(), String> {
    copy_to_clipboard(&format!("{email}\t{password}"))
}

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
        Ok(())
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
        Ok(())
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
        Ok(())
    }
}

// ─── Small helpers ──────────────────────────────────────────────────────────

fn sanitize_label(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn persona_id_short(s: &str) -> String {
    s.chars().take(6).collect()
}

// ─── Entry ──────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            launch_persona,
            close_persona,
            copy_creds,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
