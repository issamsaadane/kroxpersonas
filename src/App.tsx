import { useEffect, useMemo, useRef, useState, FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FramedPane,
  TITLE_H,
  BOTTOM_H,
  MIN_W,
  MIN_H,
  Viewport,
  VIEWPORT_PRESETS,
} from "./FramedPane";
import { FrameRect, tileLayout } from "./layout";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Persona {
  id: string;
  name: string;
  email: string;
  password: string;
  label: string;
}

interface Project {
  id: string;
  name: string;
  serverUrl: string;
  personas: Persona[];
}

interface SavedPane {
  personaId: string;
  projectId: string;
  frame: FrameRect;
  viewport: Viewport;
  zIndex: number;
}

interface UiState {
  sidebarCollapsed: boolean;
  railCollapsed: boolean;
  openPanes: SavedPane[];
}

interface Config {
  projects: Project[];
  ui?: UiState;
}

interface OpenPane {
  personaId: string;
  projectId: string;
  frame: FrameRect;
  viewport: Viewport;
  zIndex: number;
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

async function saveConfig(c: Config)                { await invoke("save_config", { config: c }); }
async function loadConfig(): Promise<Config>        { return await invoke<Config>("load_config"); }
async function openPaneRust(personaId: string, url: string, email: string, password: string, x: number, y: number, width: number, height: number) {
  await invoke("open_pane", { personaId, url, email, password, x, y, width, height });
}
async function setPaneBoundsRust(personaId: string, x: number, y: number, width: number, height: number) {
  await invoke("set_pane_bounds", { personaId, x, y, width, height });
}
async function closePaneRust(personaId: string)     { await invoke("close_pane", { personaId }); }
async function closeAllPanesRust()                  { await invoke("close_all_panes"); }
async function copyCreds(email: string, password: string) { await invoke("copy_creds", { email, password }); }

/**
 * Given a local-to-workspace frame and a viewport preset, compute the
 * webview rect IN ABSOLUTE main-window coords. For non-fit presets, the
 * webview is centred inside the frame at preset dimensions.
 */
function webviewRect(
  frame: FrameRect,
  viewport: Viewport,
  ws: { left: number; top: number },
): { x: number; y: number; width: number; height: number } {
  const innerW = frame.width;
  const innerH = Math.max(1, frame.height - TITLE_H - BOTTOM_H);
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
    x: Math.round(ws.left + frame.x + offX),
    y: Math.round(ws.top  + frame.y + TITLE_H + offY),
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
  const [config, setConfig]       = useState<Config>({ projects: [] });
  const [activeId, setActiveId]   = useState<string | null>(null);
  const [projModal, setProjModal] = useState<{ mode: "new" } | { mode: "edit"; p: Project } | null>(null);
  const [userModal, setUserModal] = useState<{ mode: "new" } | { mode: "edit"; u: Persona } | null>(null);
  const [toast, setToast]         = useState<string | null>(null);
  const [ready, setReady]         = useState(false);

  const [panes, setPanes]                   = useState<OpenPane[]>([]);
  const [zTop, setZTop]                     = useState(10);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [railCollapsed, setRailCollapsed]       = useState(false);
  const [workspaceBounds, setWorkspaceBounds]   = useState({ width: 800, height: 600 });
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  // Snapshots for use inside resize / restore handlers.
  const panesRef = useRef<OpenPane[]>(panes);
  useEffect(() => { panesRef.current = panes; }, [panes]);

  // ── boot ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    loadConfig().then((c) => {
      if (cancelled) return;
      setConfig(c);
      if (c.projects.length) setActiveId(c.projects[0].id);
      setSidebarCollapsed(c.ui?.sidebarCollapsed ?? false);
      setRailCollapsed(c.ui?.railCollapsed ?? false);

      const saved = c.ui?.openPanes ?? [];
      if (saved.length) {
        // Push to state first — tiles render as HTML frames on next paint.
        setPanes(saved.map((s) => ({ ...s })));
        setZTop(Math.max(10, ...saved.map((s) => s.zIndex)) + 1);
        // Defer Rust-side opens until workspace has real bounds.
        requestAnimationFrame(() => requestAnimationFrame(async () => {
          const ws = workspaceRef.current?.getBoundingClientRect();
          if (!ws) return;
          for (const pane of saved) {
            const proj = c.projects.find((p) => p.id === pane.projectId);
            const persona = proj?.personas.find((u) => u.id === pane.personaId);
            if (!proj || !persona) continue;
            const rect = webviewRect(pane.frame, pane.viewport, { left: ws.left, top: ws.top });
            await openPaneRust(
              persona.id, proj.serverUrl, persona.email, persona.password,
              rect.x, rect.y, rect.width, rect.height,
            ).catch(() => {});
          }
        }));
      }
    }).finally(() => setReady(true));

    return () => { cancelled = true; closeAllPanesRust().catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on change (post-boot).
  useEffect(() => {
    if (!ready) return;
    const ui: UiState = {
      sidebarCollapsed,
      railCollapsed,
      openPanes: panes.map((p) => ({
        personaId: p.personaId,
        projectId: p.projectId,
        frame: p.frame,
        viewport: p.viewport,
        zIndex: p.zIndex,
      })),
    };
    saveConfig({ ...config, ui }).catch(console.error);
  }, [config, panes, sidebarCollapsed, railCollapsed, ready]);

  // Workspace-size observer → keeps webviews aligned with HTML frames when the
  // host window (or either sidebar) resizes. Also clamps pane frames to the
  // new workspace size so panes never hang off the edge (which would cause
  // a scrollbar, i.e. the "double scrolling" bug).
  useEffect(() => {
    const recalc = () => {
      const el = workspaceRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setWorkspaceBounds({ width: r.width, height: r.height });

      let needsUpdate = false;
      const clamped = panesRef.current.map((p) => {
        const maxW = Math.max(MIN_W, r.width);
        const maxH = Math.max(MIN_H, r.height);
        const width  = Math.min(Math.max(MIN_W, p.frame.width),  maxW);
        const height = Math.min(Math.max(MIN_H, p.frame.height), maxH);
        const x = Math.max(0, Math.min(p.frame.x, r.width  - width));
        const y = Math.max(0, Math.min(p.frame.y, r.height - height));
        const frame = { x, y, width, height };
        if (frame.x !== p.frame.x || frame.y !== p.frame.y ||
            frame.width !== p.frame.width || frame.height !== p.frame.height) {
          needsUpdate = true;
        }
        return { ...p, frame };
      });
      if (needsUpdate) setPanes(clamped);

      for (const p of clamped) {
        const rect = webviewRect(p.frame, p.viewport, { left: r.left, top: r.top });
        setPaneBoundsRust(p.personaId, rect.x, rect.y, rect.width, rect.height).catch(() => {});
      }
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    if (workspaceRef.current) ro.observe(workspaceRef.current);
    window.addEventListener("resize", recalc);
    return () => { ro.disconnect(); window.removeEventListener("resize", recalc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeProject = useMemo(
    () => config.projects.find((p) => p.id === activeId) ?? null,
    [config, activeId],
  );

  const pushToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  // ── Rect for a new pane: pick a free tile-slot so it doesn't overlap ──────

  const framesIntersect = (a: FrameRect, b: FrameRect): boolean =>
    !(a.x + a.width  <= b.x ||
      b.x + b.width  <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y);

  const nextFrame = (): FrameRect => {
    const ws = workspaceRef.current?.getBoundingClientRect();
    const w = Math.max(400, ws?.width  ?? workspaceBounds.width);
    const h = Math.max(300, ws?.height ?? workspaceBounds.height);
    const existing = panes.map((p) => p.frame);

    // 1) Try the tile slot for N+1 panes — probably free on open 2, 3, 4 …
    const tiles = tileLayout(panes.length + 1, w, h);
    for (const tile of tiles) {
      const cand: FrameRect = {
        x: Math.max(0, tile.x),
        y: Math.max(0, tile.y),
        width:  Math.max(MIN_W, tile.width),
        height: Math.max(MIN_H, tile.height),
      };
      if (!existing.some((e) => framesIntersect(cand, e))) return cand;
    }

    // 2) Fall back to a cascade offset in the free area.
    for (let i = 0; i < 20; i++) {
      const cand: FrameRect = {
        x: 40 + i * 32,
        y: 40 + i * 32,
        width:  Math.min(900, w - 80),
        height: Math.min(600, h - 80),
      };
      if (cand.x + cand.width >= w || cand.y + cand.height >= h) break;
      if (!existing.some((e) => framesIntersect(cand, e))) return cand;
    }

    // 3) No free spot; just place at origin. User can drag.
    return {
      x: 0, y: 0,
      width:  Math.min(900, w),
      height: Math.min(600, h),
    };
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

  const handleLaunch = async (u: Persona) => {
    if (!activeProject) return;
    if (panes.some((p) => p.personaId === u.id)) {
      // Already open — just bring to front.
      setZTop((z) => {
        const next = z + 1;
        setPanes((prev) => prev.map((p) => p.personaId === u.id ? { ...p, zIndex: next } : p));
        return next;
      });
      pushToast(`${u.name} is already open`);
      return;
    }
    const ws = workspaceRef.current?.getBoundingClientRect();
    if (!ws) return;

    const frame = nextFrame();
    const newZ = zTop + 1;
    const rect = webviewRect(frame, "fit", { left: ws.left, top: ws.top });

    try {
      await openPaneRust(
        u.id, activeProject.serverUrl, u.email, u.password,
        rect.x, rect.y, rect.width, rect.height,
      );
      setZTop(newZ);
      setPanes((prev) => [...prev, {
        personaId: u.id,
        projectId: activeProject.id,
        frame,
        viewport: "fit",
        zIndex: newZ,
      }]);
      pushToast(`Launching ${u.name}…`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast(`Launch failed: ${msg}`);
    }
  };

  const handleCopy = async (u: Persona) => {
    try { await copyCreds(u.email, u.password); pushToast(`Copied ${u.email} creds`); }
    catch { pushToast("Copy failed"); }
  };

  const handlePaneMove = (personaId: string, frame: FrameRect) => {
    setPanes((prev) => prev.map((p) => (p.personaId === personaId ? { ...p, frame } : p)));
    const ws = workspaceRef.current?.getBoundingClientRect();
    if (!ws) return;
    const p = panesRef.current.find((x) => x.personaId === personaId);
    const vp = p?.viewport ?? "fit";
    const rect = webviewRect(frame, vp, { left: ws.left, top: ws.top });
    setPaneBoundsRust(personaId, rect.x, rect.y, rect.width, rect.height).catch(() => {});
  };

  const handlePaneFocus = (personaId: string) => {
    setZTop((z) => {
      const next = z + 1;
      setPanes((prev) => prev.map((p) => (p.personaId === personaId ? { ...p, zIndex: next } : p)));
      return next;
    });
  };

  const handlePaneClose = (personaId: string) => {
    closePaneRust(personaId).catch(() => {});
    setPanes((prev) => prev.filter((p) => p.personaId !== personaId));
  };

  const handleSetViewport = (personaId: string, viewport: Viewport) => {
    setPanes((prev) => prev.map((p) => {
      if (p.personaId !== personaId) return p;
      const next: OpenPane = { ...p, viewport };
      // For non-fit presets, resize the pane to match the preset so the whole
      // frame (including chrome) matches the device size. Fit keeps whatever
      // size the user has dragged it to.
      if (viewport !== "fit") {
        const preset = VIEWPORT_PRESETS[viewport];
        next.frame = {
          ...p.frame,
          width:  preset.w,
          height: preset.h + TITLE_H + BOTTOM_H,
        };
      }
      return next;
    }));

    // Push the new webview rect right away — the effect below also re-syncs,
    // but this keeps the user's click snappy.
    const ws = workspaceRef.current?.getBoundingClientRect();
    if (!ws) return;
    setTimeout(() => {
      const p = panesRef.current.find((x) => x.personaId === personaId);
      if (!p) return;
      const rect = webviewRect(p.frame, p.viewport, { left: ws.left, top: ws.top });
      setPaneBoundsRust(personaId, rect.x, rect.y, rect.width, rect.height).catch(() => {});
    }, 0);
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

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${railCollapsed ? "rail-collapsed" : ""}`}>
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
                <button
                  className="btn"
                  onClick={() => setRailCollapsed((v) => !v)}
                  title={railCollapsed ? "Show persona rail" : "Hide persona rail"}
                >
                  {railCollapsed ? "Show personas" : "Hide personas"}
                </button>
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
              {!railCollapsed && (
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
                                  <button className="btn danger-text small" onClick={() => handlePaneClose(u.id)}>Close</button>
                                ) : (
                                  <button className="btn primary small" onClick={() => handleLaunch(u)}>Launch</button>
                                )}
                                <button className="btn small" onClick={() => handleCopy(u)} title="Copy credentials">⧉</button>
                                <button className="btn small" onClick={() => setUserModal({ mode: "edit", u })} title="Edit persona">…</button>
                                <button className="btn danger-text small" onClick={() => deletePersona(u.id)} title="Delete persona">×</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </aside>
              )}

              <section className="workspace" ref={workspaceRef}>
                {panes.length === 0 && (
                  <div className="workspace-empty">
                    Click <strong>Launch</strong> on any persona to open it here.
                  </div>
                )}
                {panes.map((p) => {
                  const info = paneInfo(p.personaId);
                  if (!info) return null;
                  const others = panes
                    .filter((q) => q.personaId !== p.personaId)
                    .map((q) => q.frame);
                  return (
                    <FramedPane
                      key={p.personaId}
                      title={info.user.name}
                      subtitle={p.viewport === "fit" ? info.user.label : p.viewport}
                      frame={p.frame}
                      zIndex={p.zIndex}
                      viewport={p.viewport}
                      workspaceBounds={workspaceBounds}
                      otherFrames={others}
                      onMove={(frame) => handlePaneMove(p.personaId, frame)}
                      onFocus={() => handlePaneFocus(p.personaId)}
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
