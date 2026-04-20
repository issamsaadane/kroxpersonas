import { useEffect, useMemo, useRef, useState, FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FramedPane, TITLE_H, Viewport, VIEWPORT_PRESETS } from "./FramedPane";
import { FrameRect, tileLayout } from "./layout";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Persona {
  id: string;
  name: string;
  email: string;
  password: string;
  label: string;
  viewport?: Viewport;
}

interface Project {
  id: string;
  name: string;
  serverUrl: string;
  personas: Persona[];
}

interface UiState {
  sidebarCollapsed: boolean;
  openPersonaIds: string[];                  // restored on next launch
  paneViewport: Record<string, Viewport>;    // per persona
}

interface Config {
  projects: Project[];
  ui?: UiState;
}

interface OpenPane {
  personaId: string;
  projectId: string;
  viewport: Viewport;
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
async function openPaneRust(
  personaId: string,
  url: string,
  email: string,
  password: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  await invoke("open_pane", { personaId, url, email, password, x, y, width, height });
}
async function setPaneBoundsRust(
  personaId: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  await invoke("set_pane_bounds", { personaId, x, y, width, height });
}
async function closePaneRust(personaId: string) {
  await invoke("close_pane", { personaId });
}
async function closeAllPanesRust() {
  await invoke("close_all_panes");
}
async function copyCreds(email: string, password: string) {
  await invoke("copy_creds", { email, password });
}

/**
 * Given a tile (local to workspace) and a viewport preset, compute the
 * webview rect IN ABSOLUTE main-window coords (what Rust expects).
 */
function webviewRectForTile(
  tile: FrameRect,
  viewport: Viewport,
  workspaceAbsolute: { left: number; top: number },
): { x: number; y: number; width: number; height: number } {
  const innerW = tile.width;
  const innerH = tile.height - TITLE_H;
  let wvW = innerW;
  let wvH = innerH;
  if (viewport !== "fit") {
    const p = VIEWPORT_PRESETS[viewport];
    wvW = Math.min(p.w, innerW);
    wvH = Math.min(p.h, innerH);
  }
  const offX = Math.round((innerW - wvW) / 2);
  const offY = Math.round((innerH - wvH) / 2);
  return {
    x: Math.round(workspaceAbsolute.left + tile.x + offX),
    y: Math.round(workspaceAbsolute.top  + tile.y + TITLE_H + offY),
    width:  Math.max(1, Math.round(wvW)),
    height: Math.max(1, Math.round(wvH)),
  };
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

  const [panes, setPanes]               = useState<OpenPane[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workspaceBounds, setWorkspaceBounds]   = useState({ width: 800, height: 600 });
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  // Snapshot for sync handlers
  const panesRef = useRef<OpenPane[]>(panes);
  useEffect(() => { panesRef.current = panes; }, [panes]);

  // Load config + restore previously open panes
  useEffect(() => {
    let cancelled = false;
    loadConfig().then((c) => {
      if (cancelled) return;
      setConfig(c);
      if (c.projects.length && !activeId) setActiveId(c.projects[0].id);
      setSidebarCollapsed(c.ui?.sidebarCollapsed ?? false);

      // Restore previously-open personas (one-shot, then mark ready).
      const restore = (c.ui?.openPersonaIds ?? []).flatMap((pid) => {
        for (const proj of c.projects) {
          const u = proj.personas.find((x) => x.id === pid);
          if (u) return [{ persona: u, project: proj }];
        }
        return [];
      });

      // Defer restoration until workspace has real bounds.
      const ws = workspaceRef.current?.getBoundingClientRect();
      const vp = (c.ui?.paneViewport ?? {}) as Record<string, Viewport>;
      if (restore.length && ws) {
        const initial: OpenPane[] = restore.map(({ persona, project }) => ({
          personaId: persona.id,
          projectId: project.id,
          viewport: vp[persona.id] ?? persona.viewport ?? "fit",
        }));
        setPanes(initial);
        openRestoredPanes(initial, c).catch(console.error);
      }
    }).finally(() => setReady(true));

    return () => { cancelled = true; closeAllPanesRust().catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist config on change (after initial load)
  useEffect(() => {
    if (!ready) return;
    const ui: UiState = {
      sidebarCollapsed,
      openPersonaIds: panes.map((p) => p.personaId),
      paneViewport: panes.reduce<Record<string, Viewport>>((acc, p) => {
        acc[p.personaId] = p.viewport;
        return acc;
      }, {}),
    };
    const next: Config = { ...config, ui };
    saveConfig(next).catch(console.error);
  }, [config, panes, sidebarCollapsed, ready]);

  // Workspace ResizeObserver → re-tile every pane whenever dimensions change.
  useEffect(() => {
    const recalc = () => {
      const el = workspaceRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setWorkspaceBounds({ width: r.width, height: r.height });
      applyTiling(panesRef.current, r);
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    if (workspaceRef.current) ro.observe(workspaceRef.current);
    window.addEventListener("resize", recalc);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recalc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-tile whenever the set of open panes or their viewports change.
  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    applyTiling(panes, el.getBoundingClientRect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes]);

  const applyTiling = (currentPanes: OpenPane[], ws: DOMRect) => {
    const tiles = tileLayout(currentPanes.length, ws.width, ws.height);
    currentPanes.forEach((p, i) => {
      const tile = tiles[i];
      if (!tile) return;
      const rect = webviewRectForTile(tile, p.viewport, { left: ws.left, top: ws.top });
      setPaneBoundsRust(p.personaId, rect.x, rect.y, rect.width, rect.height).catch(() => {});
    });
  };

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
    setPanes((prev) => {
      const drop = prev.filter((p) => p.projectId === id);
      drop.forEach((p) => closePaneRust(p.personaId).catch(() => {}));
      return prev.filter((p) => p.projectId !== id);
    });
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
    closePaneRust(id).catch(() => {});
    setPanes((prev) => prev.filter((p) => p.personaId !== id));
    setConfig((c) => ({
      ...c,
      projects: c.projects.map((p) =>
        p.id === activeProject.id ? { ...p, personas: p.personas.filter((u) => u.id !== id) } : p,
      ),
    }));
  };

  // ── pane lifecycle ────────────────────────────────────────────────────────

  async function openRestoredPanes(initial: OpenPane[], cfg: Config) {
    const ws = workspaceRef.current?.getBoundingClientRect();
    if (!ws) return;
    const tiles = tileLayout(initial.length, ws.width, ws.height);
    for (let i = 0; i < initial.length; i++) {
      const pane = initial[i];
      const proj = cfg.projects.find((p) => p.id === pane.projectId);
      const persona = proj?.personas.find((u) => u.id === pane.personaId);
      if (!proj || !persona) continue;
      const rect = webviewRectForTile(tiles[i], pane.viewport, { left: ws.left, top: ws.top });
      try {
        await openPaneRust(persona.id, proj.serverUrl, persona.email, persona.password,
          rect.x, rect.y, rect.width, rect.height);
      } catch {/* ignore */}
    }
  }

  const handleLaunch = async (u: Persona) => {
    if (!activeProject) return;
    if (panes.some((p) => p.personaId === u.id)) {
      pushToast(`${u.name} is already open`);
      return;
    }
    const ws = workspaceRef.current?.getBoundingClientRect();
    if (!ws) return;

    // Add to list first (this drives the grid layout), then Rust-open, then re-tile.
    const nextPanes: OpenPane[] = [
      ...panes,
      { personaId: u.id, projectId: activeProject.id, viewport: u.viewport ?? "fit" },
    ];
    setPanes(nextPanes);

    const tiles = tileLayout(nextPanes.length, ws.width, ws.height);
    const newIdx = nextPanes.length - 1;
    const rect = webviewRectForTile(tiles[newIdx], "fit", { left: ws.left, top: ws.top });
    try {
      await openPaneRust(
        u.id,
        activeProject.serverUrl,
        u.email,
        u.password,
        rect.x, rect.y, rect.width, rect.height,
      );
      // After the webview exists, apply tiling for everyone (in case other tile sizes changed).
      applyTiling(nextPanes, ws);
      pushToast(`Launching ${u.name}…`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast(`Launch failed: ${msg}`);
      setPanes((prev) => prev.filter((p) => p.personaId !== u.id));
    }
  };

  const handleCopy = async (u: Persona) => {
    try {
      await copyCreds(u.email, u.password);
      pushToast(`Copied ${u.email} creds`);
    } catch {
      pushToast("Copy failed");
    }
  };

  const handlePaneClose = (personaId: string) => {
    closePaneRust(personaId).catch(() => {});
    setPanes((prev) => prev.filter((p) => p.personaId !== personaId));
  };

  const handleSetViewport = (personaId: string, viewport: Viewport) => {
    setPanes((prev) => prev.map((p) => (p.personaId === personaId ? { ...p, viewport } : p)));
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

  const isOpen = (id: string) => panes.some((p) => p.personaId === id);

  const paneInfo = (personaId: string) => {
    for (const proj of config.projects) {
      const u = proj.personas.find((x) => x.id === personaId);
      if (u) return { user: u, project: proj };
    }
    return null;
  };

  // ── tile geometry for render (must mirror Rust-side placement) ────────────

  const tiles = useMemo(
    () => tileLayout(panes.length, workspaceBounds.width, workspaceBounds.height),
    [panes.length, workspaceBounds.width, workspaceBounds.height],
  );

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {/* Sidebar */}
      <aside className="sidebar">
        <header>
          <div className="logo">K</div>
          {!sidebarCollapsed && <h1>KroxPersonas</h1>}
          <button
            className="collapse-btn"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        </header>

        {!sidebarCollapsed && (
          <>
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
          </>
        )}
      </aside>

      {/* Main */}
      <main className="main">
        {!activeProject && (
          <div className="workspace-empty">
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
              <aside className="persona-rail">
                {activeProject.personas.length === 0 && (
                  <div className="empty">No personas yet.</div>
                )}
                {grouped.map(({ label, users }) => (
                  <section key={label} className="group">
                    <div className="group-head">
                      <div className="label">{label}</div>
                    </div>
                    <div className="persona-list">
                      {users.map((u) => {
                        const open = isOpen(u.id);
                        return (
                          <div className={`persona-row ${open ? "open" : ""}`} key={u.id}>
                            <div className="avatar">{initials(u.name)}</div>
                            <div className="who">
                              <div className="name">{u.name}</div>
                              <div className="email">{u.email}</div>
                            </div>
                            <div className="row-actions">
                              {open ? (
                                <button className="btn danger-text small" onClick={() => handlePaneClose(u.id)} title="Close pane">
                                  Close
                                </button>
                              ) : (
                                <button className="btn primary small" onClick={() => handleLaunch(u)} title="Open pane">
                                  Launch
                                </button>
                              )}
                              <button className="btn small" onClick={() => handleCopy(u)} title="Copy credentials">
                                ⧉
                              </button>
                              <button className="btn small" onClick={() => setUserModal({ mode: "edit", u })} title="Edit persona">
                                …
                              </button>
                              <button className="btn danger-text small" onClick={() => deletePersona(u.id)} title="Delete persona">
                                ×
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </aside>

              <section className="workspace" ref={workspaceRef}>
                {panes.length === 0 && (
                  <div className="workspace-empty">
                    Click <strong>Launch</strong> on any persona to open it here.
                  </div>
                )}
                {panes.map((p, i) => {
                  const info = paneInfo(p.personaId);
                  const tile = tiles[i];
                  if (!info || !tile) return null;
                  return (
                    <FramedPane
                      key={p.personaId}
                      title={info.user.name}
                      subtitle={p.viewport === "fit" ? info.user.label : p.viewport}
                      frame={tile}
                      viewport={p.viewport}
                      onClose={() => handlePaneClose(p.personaId)}
                      onSetViewport={(v) => handleSetViewport(p.personaId, v)}
                    />
                  );
                })}
              </section>
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
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">{initial ? "Save" : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}
