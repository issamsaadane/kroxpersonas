import { useEffect, useState, useMemo, FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Persona {
  id: string;
  name: string;
  email: string;
  password: string;
  label: string; // user type label, e.g. "admin" | "editor"
}

interface Project {
  id: string;
  name: string;
  serverUrl: string;
  personas: Persona[];
}

interface Config {
  projects: Project[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = () =>
  (globalThis.crypto && "randomUUID" in globalThis.crypto
    ? (globalThis.crypto as Crypto).randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36));

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("") || "?";

async function saveConfig(c: Config) {
  await invoke("save_config", { config: c });
}

async function loadConfig(): Promise<Config> {
  return await invoke<Config>("load_config");
}

async function launchPersona(
  personaId: string,
  personaName: string,
  url: string,
  email: string,
  password: string,
) {
  await invoke("launch_persona", { personaId, personaName, url, email, password });
}

async function copyCredentials(email: string, password: string) {
  await invoke("copy_creds", { email, password });
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [config, setConfig]             = useState<Config>({ projects: [] });
  const [activeId, setActiveId]         = useState<string | null>(null);
  const [projModal, setProjModal]       = useState<{ mode: "new" } | { mode: "edit"; p: Project } | null>(null);
  const [userModal, setUserModal]       = useState<{ mode: "new" } | { mode: "edit"; u: Persona } | null>(null);
  const [toast, setToast]               = useState<string | null>(null);
  const [ready, setReady]               = useState(false);

  // Load config on boot
  useEffect(() => {
    loadConfig()
      .then((c) => {
        setConfig(c);
        if (c.projects.length && !activeId) setActiveId(c.projects[0].id);
      })
      .finally(() => setReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on change (after initial load)
  useEffect(() => {
    if (!ready) return;
    saveConfig(config).catch(console.error);
  }, [config, ready]);

  const activeProject = useMemo(
    () => config.projects.find((p) => p.id === activeId) ?? null,
    [config, activeId],
  );

  const pushToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  // ── project CRUD ──────────────────────────────────────────────────────────

  const addProject = (name: string, serverUrl: string) => {
    const p: Project = { id: uid(), name: name.trim(), serverUrl: serverUrl.trim(), personas: [] };
    setConfig((c) => ({ ...c, projects: [...c.projects, p] }));
    setActiveId(p.id);
    setProjModal(null);
  };
  const updateProject = (id: string, patch: Partial<Project>) => {
    setConfig((c) => ({
      ...c,
      projects: c.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    setProjModal(null);
  };
  const deleteProject = (id: string) => {
    if (!confirm("Delete this project and all its personas? This cannot be undone.")) return;
    setConfig((c) => ({ ...c, projects: c.projects.filter((p) => p.id !== id) }));
    if (activeId === id) setActiveId(null);
  };

  // ── persona CRUD ──────────────────────────────────────────────────────────

  const addPersona = (u: Omit<Persona, "id">) => {
    if (!activeProject) return;
    const persona: Persona = { id: uid(), ...u };
    setConfig((c) => ({
      ...c,
      projects: c.projects.map((p) =>
        p.id === activeProject.id ? { ...p, personas: [...p.personas, persona] } : p,
      ),
    }));
    setUserModal(null);
  };
  const updatePersona = (id: string, patch: Partial<Persona>) => {
    if (!activeProject) return;
    setConfig((c) => ({
      ...c,
      projects: c.projects.map((p) =>
        p.id === activeProject.id
          ? { ...p, personas: p.personas.map((u) => (u.id === id ? { ...u, ...patch } : u)) }
          : p,
      ),
    }));
    setUserModal(null);
  };
  const deletePersona = (id: string) => {
    if (!activeProject) return;
    if (!confirm("Delete this persona?")) return;
    setConfig((c) => ({
      ...c,
      projects: c.projects.map((p) =>
        p.id === activeProject.id ? { ...p, personas: p.personas.filter((u) => u.id !== id) } : p,
      ),
    }));
  };

  // ── launch ────────────────────────────────────────────────────────────────

  const handleLaunch = async (u: Persona) => {
    if (!activeProject) return;
    try {
      await launchPersona(u.id, u.name, activeProject.serverUrl, u.email, u.password);
      pushToast(`Launching ${u.name}…`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast(`Launch failed: ${msg}`);
    }
  };

  const handleCopy = async (u: Persona) => {
    try {
      await copyCredentials(u.email, u.password);
      pushToast(`Copied ${u.email} creds to clipboard`);
    } catch {
      pushToast("Copy failed");
    }
  };

  // ── grouping for active project ───────────────────────────────────────────

  const grouped = useMemo(() => {
    if (!activeProject) return [] as { label: string; users: Persona[] }[];
    const bucket: Record<string, Persona[]> = {};
    for (const u of activeProject.personas) {
      const key = (u.label || "Uncategorised").trim();
      (bucket[key] ??= []).push(u);
    }
    return Object.entries(bucket)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, users]) => ({ label, users }));
  }, [activeProject]);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        <header>
          <div className="logo">K</div>
          <h1>KroxPersonas</h1>
        </header>

        <div className="project-list">
          {config.projects.length === 0 && (
            <div className="empty" style={{ padding: "20px 10px" }}>No projects yet.</div>
          )}
          {config.projects.map((p) => (
            <button
              key={p.id}
              className={`project-row ${activeId === p.id ? "active" : ""}`}
              onClick={() => setActiveId(p.id)}
            >
              <span className="name">{p.name}</span>
              <span className="count">{p.personas.length}</span>
            </button>
          ))}
        </div>

        <footer>
          <button className="btn primary full" onClick={() => setProjModal({ mode: "new" })}>
            + New project
          </button>
        </footer>
      </aside>

      {/* Main */}
      <main className="main">
        {!activeProject && (
          <div className="empty" style={{ margin: "auto" }}>
            {config.projects.length === 0
              ? "Create a project to get started."
              : "Select a project on the left."}
          </div>
        )}

        {activeProject && (
          <>
            <header className="main-header">
              <div>
                <div className="title">{activeProject.name}</div>
                <div className="url">{activeProject.serverUrl || "(no URL set)"}</div>
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setProjModal({ mode: "edit", p: activeProject })}>
                  Edit project
                </button>
                <button className="btn danger-text" onClick={() => deleteProject(activeProject.id)}>
                  Delete
                </button>
                <button className="btn primary" onClick={() => setUserModal({ mode: "new" })}>
                  + Add persona
                </button>
              </div>
            </header>

            <div className="main-body">
              {activeProject.personas.length === 0 && (
                <div className="empty">No personas yet. Add one to start launching.</div>
              )}
              {grouped.map(({ label, users }) => (
                <section key={label} className="group">
                  <div className="group-head">
                    <div className="label">{label}</div>
                    <div className="divider" />
                  </div>
                  <div className="user-grid">
                    {users.map((u) => (
                      <div className="user-card" key={u.id}>
                        <div className="head">
                          <div className="avatar">{initials(u.name)}</div>
                          <div className="who">
                            <div className="name">{u.name}</div>
                            <div className="email">{u.email}</div>
                          </div>
                        </div>
                        <div className="actions">
                          <button className="btn primary" onClick={() => handleLaunch(u)}>
                            Launch
                          </button>
                          <button className="btn" onClick={() => handleCopy(u)}>
                            Copy
                          </button>
                          <button className="btn" onClick={() => setUserModal({ mode: "edit", u })}>
                            Edit
                          </button>
                          <button className="btn danger-text" onClick={() => deletePersona(u.id)}>
                            Del
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </main>

      {/* Modals */}
      {projModal && (
        <ProjectForm
          initial={projModal.mode === "edit" ? projModal.p : undefined}
          onSubmit={(name, url) =>
            projModal.mode === "edit"
              ? updateProject(projModal.p.id, { name, serverUrl: url })
              : addProject(name, url)
          }
          onClose={() => setProjModal(null)}
        />
      )}
      {userModal && activeProject && (
        <PersonaForm
          initial={userModal.mode === "edit" ? userModal.u : undefined}
          onSubmit={(u) =>
            userModal.mode === "edit" ? updatePersona(userModal.u.id, u) : addPersona(u)
          }
          onClose={() => setUserModal(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ─── Project Form ────────────────────────────────────────────────────────────

function ProjectForm({
  initial,
  onSubmit,
  onClose,
}: {
  initial?: Project;
  onSubmit: (name: string, url: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl]   = useState(initial?.serverUrl ?? "http://localhost:3000");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name, url);
  };

  return (
    <Modal title={initial ? "Edit project" : "New project"} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label>Name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="KroxFlow staging" />
        </div>
        <div className="field">
          <label>Server URL</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000" />
          <p className="hint">Personas launch relative to this URL (e.g. /login).</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">{initial ? "Save" : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Persona Form ────────────────────────────────────────────────────────────

function PersonaForm({
  initial,
  onSubmit,
  onClose,
}: {
  initial?: Persona;
  onSubmit: (u: Omit<Persona, "id">) => void;
  onClose: () => void;
}) {
  const [name, setName]         = useState(initial?.name ?? "");
  const [email, setEmail]       = useState(initial?.email ?? "");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [label, setLabel]       = useState(initial?.label ?? "admin");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    onSubmit({ name: name.trim(), email: email.trim(), password, label: label.trim() || "Uncategorised" });
  };

  return (
    <Modal title={initial ? "Edit persona" : "New persona"} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label>Display name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Sam Admin" />
        </div>
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sam@example.com" />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          <p className="hint">Stored locally in plain JSON — use only for non-production test accounts.</p>
        </div>
        <div className="field">
          <label>User type / label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="admin / editor / viewer" />
          <p className="hint">Free-form label used only to group personas in the dashboard.</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">{initial ? "Save" : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}
