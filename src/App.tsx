import { useEffect, useMemo, useRef, useState, FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FramedPane,
  TITLE_H,
  EDGE,
  MIN_W,
  MIN_H,
  Viewport,
  VIEWPORT_PRESETS,
  viewportLabel,
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
  instanceId: string;
  personaId: string;
  projectId: string;
  frame: FrameRect;
  viewport: Viewport;
  zIndex: number;
}

interface UiState {
  activeProjectId?: string | null;
  openPanes: SavedPane[];
}

interface Config {
  projects: Project[];
  ui?: UiState;
}

interface OpenPane {
  instanceId: string;
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
async function openPaneRust(instanceId: string, url: string, email: string, password: string, x: number, y: number, width: number, height: number) {
  await invoke("open_pane", { personaId: instanceId, url, email, password, x, y, width, height });
}
async function setPaneBoundsRust(instanceId: string, x: number, y: number, width: number, height: number) {
  await invoke("set_pane_bounds", { personaId: instanceId, x, y, width, height });
}
async function closePaneRust(instanceId: string)    { await invoke("close_pane", { personaId: instanceId }); }
async function closeAllPanesRust()                  { await invoke("close_all_panes"); }
async function setPanesVisibleRust(visible: boolean){ await invoke("set_panes_visible", { visible }); }
async function copyCreds(email: string, password: string) { await invoke("copy_creds", { email, password }); }

function webviewRect(
  frame: FrameRect,
  viewport: Viewport,
  ws: { left: number; top: number },
): { x: number; y: number; width: number; height: number } {
  const innerW = Math.max(1, frame.width  - EDGE);
  const innerH = Math.max(1, frame.height - TITLE_H - EDGE);
  let wvW = innerW;
  let wvH = innerH;
  if (viewport !== "fit") {
    const p = VIEWPORT_PRESETS[viewport];
    if (p) {
      wvW = Math.min(p.w, innerW);
      wvH = Math.min(p.h, innerH);
    }
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

function framesIntersect(a: FrameRect, b: FrameRect): boolean {
  return !(a.x + a.width  <= b.x ||
           b.x + b.width  <= a.x ||
           a.y + a.height <= b.y ||
           b.y + b.height <= a.y);
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [config, setConfig]     = useState<Config>({ projects: [] });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady]       = useState(false);
  const [toast, setToast]       = useState<string | null>(null);

  const [panes, setPanes]       = useState<OpenPane[]>([]);
  const [zTop, setZTop]         = useState(10);
  const [workspaceBounds, setWorkspaceBounds] = useState({ width: 800, height: 600 });
  const workspaceRef            = useRef<HTMLDivElement | null>(null);

  const [managerOpen, setManagerOpen] = useState(false);

  const panesRef = useRef<OpenPane[]>(panes);
  useEffect(() => { panesRef.current = panes; }, [panes]);

  // Boot
  useEffect(() => {
    let cancelled = false;
    loadConfig().then((c) => {
      if (cancelled) return;
      setConfig(c);
      setActiveId(c.ui?.activeProjectId ?? (c.projects[0]?.id ?? null));

      const saved = c.ui?.openPanes ?? [];
      if (saved.length) {
        const filled = saved.map((s) => ({ ...s, instanceId: s.instanceId ?? uid() }));
        setPanes(filled);
        setZTop(Math.max(10, ...filled.map((s) => s.zIndex)) + 1);
        requestAnimationFrame(() => requestAnimationFrame(async () => {
          const ws = workspaceRef.current?.getBoundingClientRect();
          if (!ws) return;
          for (const pane of filled) {
            const proj = c.projects.find((p) => p.id === pane.projectId);
            const persona = proj?.personas.find((u) => u.id === pane.personaId);
            if (!proj || !persona) continue;
            const rect = webviewRect(pane.frame, pane.viewport, { left: ws.left, top: ws.top });
            await openPaneRust(
              pane.instanceId, proj.serverUrl, persona.email, persona.password,
              rect.x, rect.y, rect.width, rect.height,
            ).catch(() => {});
          }
        }));
      }
    }).finally(() => setReady(true));

    return () => { cancelled = true; closeAllPanesRust().catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist
  useEffect(() => {
    if (!ready) return;
    const ui: UiState = {
      activeProjectId: activeId,
      openPanes: panes.map((p) => ({
        instanceId: p.instanceId,
        personaId: p.personaId,
        projectId: p.projectId,
        frame: p.frame,
        viewport: p.viewport,
        zIndex: p.zIndex,
      })),
    };
    saveConfig({ ...config, ui }).catch(console.error);
  }, [config, panes, activeId, ready]);

  // Workspace resize observer
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
            frame.width !== p.frame.width || frame.height !== p.frame.height) needsUpdate = true;
        return { ...p, frame };
      });
      if (needsUpdate) setPanes(clamped);

      for (const p of clamped) {
        const rect = webviewRect(p.frame, p.viewport, { left: r.left, top: r.top });
        setPaneBoundsRust(p.instanceId, rect.x, rect.y, rect.width, rect.height).catch(() => {});
      }
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    if (workspaceRef.current) ro.observe(workspaceRef.current);
    window.addEventListener("resize", recalc);
    return () => { ro.disconnect(); window.removeEventListener("resize", recalc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle native pane visibility when manager opens/closes.
  useEffect(() => {
    if (!ready) return;
    setPanesVisibleRust(!managerOpen).catch(() => {});
  }, [managerOpen, ready]);

  const activeProject = useMemo(
    () => config.projects.find((p) => p.id === activeId) ?? null,
    [config, activeId],
  );

  const pushToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  // ── Placement for new panes (avoids existing) ────────────────────────────

  const nextFrame = (): FrameRect => {
    const ws = workspaceRef.current?.getBoundingClientRect();
    const w = Math.max(400, ws?.width  ?? workspaceBounds.width);
    const h = Math.max(300, ws?.height ?? workspaceBounds.height);
    const existing = panes.map((p) => p.frame);
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
    return { x: 0, y: 0, width: Math.min(900, w), height: Math.min(600, h) };
  };

  // ── project CRUD ──────────────────────────────────────────────────────────

  const addProject = (name: string, serverUrl: string) => {
    const p: Project = { id: uid(), name: name.trim(), serverUrl: serverUrl.trim(), personas: [] };
    setConfig((c) => ({ ...c, projects: [...c.projects, p] }));
    setActiveId(p.id);
  };
  const updateProject = (id: string, patch: Partial<Project>) => {
    setConfig((c) => ({ ...c, projects: c.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  };
  const deleteProject = (id: string) => {
    if (!confirm("Delete this project and all its personas? This cannot be undone.")) return;
    setPanes((prev) => {
      const drop = prev.filter((p) => p.projectId === id);
      drop.forEach((p) => closePaneRust(p.instanceId).catch(() => {}));
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
  };
  const deletePersona = (id: string) => {
    if (!activeProject) return;
    if (!confirm("Delete this persona?")) return;
    setPanes((prev) => {
      const drop = prev.filter((p) => p.personaId === id);
      drop.forEach((p) => closePaneRust(p.instanceId).catch(() => {}));
      return prev.filter((p) => p.personaId !== id);
    });
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
    const ws = workspaceRef.current?.getBoundingClientRect();
    if (!ws) return;
    const instanceId = uid();
    const frame = nextFrame();
    const newZ = zTop + 1;
    const rect = webviewRect(frame, "fit", { left: ws.left, top: ws.top });
    try {
      await openPaneRust(instanceId, activeProject.serverUrl, u.email, u.password,
        rect.x, rect.y, rect.width, rect.height);
      setZTop(newZ);
      setPanes((prev) => [...prev, {
        instanceId, personaId: u.id, projectId: activeProject.id,
        frame, viewport: "fit", zIndex: newZ,
      }]);
      const existingCount = panes.filter((p) => p.personaId === u.id).length;
      pushToast(existingCount > 0 ? `Cloned ${u.name} (${existingCount + 1})` : `Launching ${u.name}…`);
    } catch (err: unknown) {
      pushToast(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCloseAll = (personaId: string) => {
    setPanes((prev) => {
      const drop = prev.filter((p) => p.personaId === personaId);
      drop.forEach((p) => closePaneRust(p.instanceId).catch(() => {}));
      return prev.filter((p) => p.personaId !== personaId);
    });
  };

  const handlePaneMove = (instanceId: string, frame: FrameRect) => {
    setPanes((prev) => prev.map((p) => (p.instanceId === instanceId ? { ...p, frame } : p)));
    const ws = workspaceRef.current?.getBoundingClientRect();
    if (!ws) return;
    const p = panesRef.current.find((x) => x.instanceId === instanceId);
    const vp = p?.viewport ?? "fit";
    const rect = webviewRect(frame, vp, { left: ws.left, top: ws.top });
    setPaneBoundsRust(instanceId, rect.x, rect.y, rect.width, rect.height).catch(() => {});
  };

  const handlePaneFocus = (instanceId: string) => {
    setZTop((z) => {
      const next = z + 1;
      setPanes((prev) => prev.map((p) => (p.instanceId === instanceId ? { ...p, zIndex: next } : p)));
      return next;
    });
  };

  const handlePaneClose = (instanceId: string) => {
    closePaneRust(instanceId).catch(() => {});
    setPanes((prev) => prev.filter((p) => p.instanceId !== instanceId));
  };

  const handleSetViewport = (instanceId: string, viewport: Viewport) => {
    setPanes((prev) => prev.map((p) => {
      if (p.instanceId !== instanceId) return p;
      const next: OpenPane = { ...p, viewport };
      if (viewport !== "fit") {
        const preset = VIEWPORT_PRESETS[viewport];
        if (preset) {
          next.frame = {
            ...p.frame,
            width:  preset.w + EDGE,
            height: preset.h + TITLE_H + EDGE,
          };
        }
      }
      return next;
    }));
    const ws = workspaceRef.current?.getBoundingClientRect();
    if (!ws) return;
    setTimeout(() => {
      const p = panesRef.current.find((x) => x.instanceId === instanceId);
      if (!p) return;
      const rect = webviewRect(p.frame, p.viewport, { left: ws.left, top: ws.top });
      setPaneBoundsRust(instanceId, rect.x, rect.y, rect.width, rect.height).catch(() => {});
    }, 0);
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const paneInfo = (personaId: string) => {
    for (const proj of config.projects) {
      const u = proj.personas.find((x) => x.id === personaId);
      if (u) return { user: u, project: proj };
    }
    return null;
  };
  const openCount = (personaId: string) => panes.filter((p) => p.personaId === personaId).length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app-slim">
      {/* Top bar — always visible above the workspace, so panes can't cover the
          K button (native webviews render on top of HTML). */}
      <header className="topbar">
        <button
          className="logo-btn"
          onClick={() => setManagerOpen(true)}
          title="Open manager"
        >
          K
        </button>
        <span className="hint">
          {panes.length === 0
            ? "Click the K button to open the manager →"
            : `${panes.length} persona${panes.length === 1 ? "" : "s"} open`}
        </span>
      </header>

      <section className="workspace" ref={workspaceRef}>
        {panes.length === 0 && !managerOpen && (
          <div className="workspace-empty">
            Click the <strong>K</strong> button in the top bar to open the manager.
          </div>
        )}
        {panes.map((p) => {
          const info = paneInfo(p.personaId);
          if (!info) return null;
          const others = panes.filter((q) => q.instanceId !== p.instanceId).map((q) => q.frame);
          const sameCount = panes.filter((q) => q.personaId === p.personaId).length;
          const cloneIdx  = panes.filter((q) => q.personaId === p.personaId).findIndex((q) => q.instanceId === p.instanceId);
          const suffix    = sameCount > 1 ? ` · #${cloneIdx + 1}` : "";
          return (
            <FramedPane
              key={p.instanceId}
              title={`${info.user.name}${suffix}`}
              subtitle={p.viewport === "fit" ? info.user.label : viewportLabel(p.viewport)}
              frame={p.frame}
              zIndex={p.zIndex}
              workspaceBounds={workspaceBounds}
              otherFrames={others}
              onMove={(frame) => handlePaneMove(p.instanceId, frame)}
              onFocus={() => handlePaneFocus(p.instanceId)}
              onClose={() => handlePaneClose(p.instanceId)}
            />
          );
        })}
      </section>

      {managerOpen && (
        <Manager
          config={config}
          activeId={activeId}
          panes={panes}
          setActiveId={setActiveId}
          addProject={addProject}
          updateProject={updateProject}
          deleteProject={deleteProject}
          addPersona={addPersona}
          updatePersona={updatePersona}
          deletePersona={deletePersona}
          handleLaunch={handleLaunch}
          handleCloseAll={handleCloseAll}
          handlePaneClose={handlePaneClose}
          handleSetViewport={handleSetViewport}
          handleCopy={(u) => copyCreds(u.email, u.password).then(() => pushToast(`Copied ${u.email}`)).catch(() => pushToast("Copy failed"))}
          openCount={openCount}
          paneInfo={paneInfo}
          onClose={() => setManagerOpen(false)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ─── Manager overlay ─────────────────────────────────────────────────────────

function Manager(props: {
  config: Config;
  activeId: string | null;
  panes: OpenPane[];
  setActiveId: (id: string | null) => void;
  addProject: (name: string, url: string) => void;
  updateProject: (id: string, patch: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  addPersona: (u: Omit<Persona, "id">) => void;
  updatePersona: (id: string, patch: Partial<Persona>) => void;
  deletePersona: (id: string) => void;
  handleLaunch: (u: Persona) => void;
  handleCloseAll: (personaId: string) => void;
  handlePaneClose: (instanceId: string) => void;
  handleSetViewport: (instanceId: string, v: Viewport) => void;
  handleCopy: (u: Persona) => void;
  openCount: (personaId: string) => number;
  paneInfo: (personaId: string) => { user: Persona; project: Project } | null;
  onClose: () => void;
}) {
  const {
    config, activeId, panes, setActiveId,
    addProject, updateProject, deleteProject,
    addPersona, updatePersona, deletePersona,
    handleLaunch, handleCloseAll, handlePaneClose, handleSetViewport, handleCopy,
    openCount, paneInfo, onClose,
  } = props;

  const [projModal, setProjModal] = useState<{ mode: "new" } | { mode: "edit"; p: Project } | null>(null);
  const [userModal, setUserModal] = useState<{ mode: "new" } | { mode: "edit"; u: Persona } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeProject = config.projects.find((p) => p.id === activeId) ?? null;

  const grouped = useMemo(() => {
    if (!activeProject) return [] as { label: string; users: Persona[] }[];
    const bucket: Record<string, Persona[]> = {};
    for (const u of activeProject.personas) {
      const key = (u.label || "Uncategorised").trim();
      (bucket[key] ??= []).push(u);
    }
    return Object.entries(bucket).sort(([a], [b]) => a.localeCompare(b)).map(([label, users]) => ({ label, users }));
  }, [activeProject]);

  const openPanesForPersona = (personaId: string) =>
    panes.filter((p) => p.personaId === personaId);

  return (
    <div className="manager-backdrop" onMouseDown={onClose}>
      <div className="manager" onMouseDown={(e) => e.stopPropagation()}>
        <header className="manager-head">
          <div className="logo">K</div>
          <h1>KroxPersonas</h1>
          <button className="btn" onClick={onClose} title="Close (Esc)">Close ✕</button>
        </header>

        <div className="manager-body">
          <aside className="manager-sidebar">
            <div className="sidebar-title">Projects</div>
            <div className="project-list">
              {config.projects.length === 0 && (
                <div className="empty" style={{ padding: "16px 10px" }}>No projects yet.</div>
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

          <main className="manager-main">
            {!activeProject && (
              <div className="workspace-empty" style={{ margin: "auto" }}>
                {config.projects.length === 0
                  ? "Create a project to get started."
                  : "Select a project on the left."}
              </div>
            )}

            {activeProject && (
              <>
                <header className="manager-main-head">
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

                <div className="manager-body-scroll">
                  {activeProject.personas.length === 0 && (
                    <div className="empty">No personas yet. Add one to start launching.</div>
                  )}

                  {grouped.map(({ label, users }) => (
                    <section key={label} className="group">
                      <div className="group-head">
                        <div className="label">{label}</div>
                      </div>

                      <div className="manager-persona-list">
                        {users.map((u) => {
                          const count = openCount(u.id);
                          const clones = openPanesForPersona(u.id);
                          return (
                            <div className={`manager-persona ${count > 0 ? "open" : ""}`} key={u.id}>
                              <div className="persona-head">
                                <div className="avatar">
                                  {initials(u.name)}
                                  {count > 0 && <span className="clone-badge">{count}</span>}
                                </div>
                                <div className="who">
                                  <div className="name">{u.name}</div>
                                  <div className="email">{u.email}</div>
                                </div>
                                <div className="row-actions">
                                  <button
                                    className="btn primary small"
                                    onClick={() => handleLaunch(u)}
                                    title={count > 0 ? "Open another clone" : "Open pane"}
                                  >
                                    {count > 0 ? "+ Clone" : "Launch"}
                                  </button>
                                  {count > 0 && (
                                    <button
                                      className="btn danger-text small"
                                      onClick={() => handleCloseAll(u.id)}
                                      title={`Close all ${count} open panes`}
                                    >
                                      Close all
                                    </button>
                                  )}
                                  <button className="btn small" onClick={() => handleCopy(u)} title="Copy credentials">⧉</button>
                                  <button className="btn small" onClick={() => setUserModal({ mode: "edit", u })}>Edit</button>
                                  <button className="btn danger-text small" onClick={() => deletePersona(u.id)}>Delete</button>
                                </div>
                              </div>

                              {clones.length > 0 && (
                                <div className="clone-list">
                                  {clones.map((p, i) => {
                                    const info = paneInfo(p.personaId);
                                    if (!info) return null;
                                    return (
                                      <div className="clone-row" key={p.instanceId}>
                                        <div className="clone-tag">#{i + 1}</div>
                                        <DevicePicker
                                          current={p.viewport}
                                          onPick={(v) => handleSetViewport(p.instanceId, v)}
                                        />
                                        <div className="clone-dims">
                                          {Math.round(p.frame.width)} × {Math.round(p.frame.height)}
                                        </div>
                                        <button
                                          className="btn danger-text small"
                                          onClick={() => handlePaneClose(p.instanceId)}
                                          title="Close this clone"
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            )}
          </main>
        </div>
      </div>

      {projModal && (
        <ProjectForm
          initial={projModal.mode === "edit" ? projModal.p : undefined}
          onSubmit={(name, url) => {
            projModal.mode === "edit"
              ? updateProject(projModal.p.id, { name, serverUrl: url })
              : addProject(name, url);
            setProjModal(null);
          }}
          onClose={() => setProjModal(null)}
        />
      )}
      {userModal && activeProject && (
        <PersonaForm
          initial={userModal.mode === "edit" ? userModal.u : undefined}
          onSubmit={(u) => {
            userModal.mode === "edit" ? updatePersona(userModal.u.id, u) : addPersona(u);
            setUserModal(null);
          }}
          onClose={() => setUserModal(null)}
        />
      )}
    </div>
  );
}

// ─── Device picker (in-manager, free to open downward without webview conflict) ──

function DevicePicker({ current, onPick }: { current: Viewport; onPick: (v: Viewport) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const categories: Array<{ title: string; items: Array<{ key: Viewport; label: string; w?: number; h?: number }> }> = [
    {
      title: "Any",
      items: [{ key: "fit", label: "Fit pane" }],
    },
    {
      title: "Desktop",
      items: Object.entries(VIEWPORT_PRESETS)
        .filter(([, p]) => p.category === "desktop")
        .map(([k, p]) => ({ key: k, label: p.label, w: p.w, h: p.h })),
    },
    {
      title: "Tablet",
      items: Object.entries(VIEWPORT_PRESETS)
        .filter(([, p]) => p.category === "tablet")
        .map(([k, p]) => ({ key: k, label: p.label, w: p.w, h: p.h })),
    },
    {
      title: "Mobile",
      items: Object.entries(VIEWPORT_PRESETS)
        .filter(([, p]) => p.category === "mobile")
        .map(([k, p]) => ({ key: k, label: p.label, w: p.w, h: p.h })),
    },
  ];

  return (
    <div className="pane-viewport" ref={ref} style={{ position: "relative" }}>
      <button className="vp-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="vp-label">{viewportLabel(current)}</span>
        <span className="vp-caret">▾</span>
      </button>
      {open && (
        <div className="vp-menu">
          {categories.map((cat) => (
            <div key={cat.title} className="vp-group">
              <div className="vp-group-head">{cat.title}</div>
              {cat.items.map((p) => (
                <button
                  key={p.key}
                  className={`vp-item ${current === p.key ? "on" : ""}`}
                  onClick={() => { onPick(p.key); setOpen(false); }}
                >
                  <span className="vp-item-label">{p.label}</span>
                  {p.w && p.h && <span className="vp-item-dims">{p.w}×{p.h}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Forms (small modals on top of the Manager) ──────────────────────────────

function ProjectForm({
  initial, onSubmit, onClose,
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
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{initial ? "Edit project" : "New project"}</h2>
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
      </div>
    </div>
  );
}

function PersonaForm({
  initial, onSubmit, onClose,
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
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{initial ? "Edit persona" : "New persona"}</h2>
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
      </div>
    </div>
  );
}
