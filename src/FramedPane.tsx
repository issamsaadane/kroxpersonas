import { useEffect, useRef } from "react";
import { FrameRect } from "./layout";

export const TITLE_H  = 36;
export const BOTTOM_H = 16;
export const MIN_W    = 320;
export const MIN_H    = 220;

export type Viewport = "fit" | "desktop" | "tablet" | "mobile";

export const VIEWPORT_PRESETS: Record<Exclude<Viewport, "fit">, { w: number; h: number; label: string }> = {
  desktop: { w: 1280, h: 800,  label: "Desktop" },
  tablet:  { w: 768,  h: 1024, label: "Tablet"  },
  mobile:  { w: 375,  h: 812,  label: "Mobile"  },
};

interface Props {
  title: string;
  subtitle?: string;
  frame: FrameRect;
  zIndex: number;
  viewport: Viewport;
  workspaceBounds: { width: number; height: number };
  onMove: (rect: FrameRect) => void;
  onFocus: () => void;
  onClose: () => void;
  onSetViewport: (v: Viewport) => void;
}

/**
 * Movable + resizable "window" frame. Title bar drags; bottom-right
 * corner resizes. Both via pointer events + rAF throttling so we don't
 * spam IPC on every pointermove.
 *
 * The native Tauri webview is rendered on top of the `.pane-slot` div
 * by the Rust side; this component never contains a real webview element.
 */
export function FramedPane({
  title,
  subtitle,
  frame,
  zIndex,
  viewport,
  workspaceBounds,
  onMove,
  onFocus,
  onClose,
  onSetViewport,
}: Props) {
  const dragRef = useRef<null | {
    mode: "move" | "resize";
    startX: number;
    startY: number;
    startFrame: FrameRect;
  }>(null);

  const clamp = (r: FrameRect): FrameRect => {
    // Keep size within workspace bounds (never larger than the container) so
    // a pane can't force the workspace to scroll.
    const maxW = Math.max(MIN_W, workspaceBounds.width);
    const maxH = Math.max(MIN_H, workspaceBounds.height);
    const width  = Math.min(Math.max(MIN_W, r.width),  maxW);
    const height = Math.min(Math.max(MIN_H, r.height), maxH);
    const x = Math.max(0, Math.min(r.x, workspaceBounds.width  - width));
    const y = Math.max(0, Math.min(r.y, workspaceBounds.height - height));
    return { x, y, width, height };
  };

  const onTitleDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Don't start a drag from the viewport toggle / close button.
    const target = e.target as HTMLElement;
    if (target.closest(".pane-viewport, .pane-close")) return;
    e.preventDefault();
    onFocus();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      startFrame: { ...frame },
    };
  };

  const onResizeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      startFrame: { ...frame },
    };
  };

  useEffect(() => {
    let rafId = 0;
    let pending: FrameRect | null = null;

    const flush = () => {
      if (pending) { onMove(pending); pending = null; }
      rafId = 0;
    };
    const schedule = (r: FrameRect) => {
      pending = r;
      if (!rafId) rafId = requestAnimationFrame(flush);
    };

    const onMoveWin = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === "move") {
        schedule(clamp({
          ...d.startFrame,
          x: d.startFrame.x + dx,
          y: d.startFrame.y + dy,
        }));
      } else {
        schedule(clamp({
          ...d.startFrame,
          width:  d.startFrame.width  + dx,
          height: d.startFrame.height + dy,
        }));
      }
    };
    const onUpWin = () => {
      dragRef.current = null;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (pending) { onMove(pending); pending = null; }
    };

    window.addEventListener("pointermove", onMoveWin);
    window.addEventListener("pointerup",   onUpWin);
    window.addEventListener("pointercancel", onUpWin);
    return () => {
      window.removeEventListener("pointermove", onMoveWin);
      window.removeEventListener("pointerup",   onUpWin);
      window.removeEventListener("pointercancel", onUpWin);
      if (rafId) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.x, frame.y, frame.width, frame.height, workspaceBounds.width, workspaceBounds.height]);

  return (
    <div
      className="pane"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        zIndex,
      }}
      onMouseDown={onFocus}
    >
      <div className="pane-title" onPointerDown={onTitleDown}>
        <span className="pane-title-name">{title}</span>
        {subtitle && <span className="pane-title-sub">{subtitle}</span>}

        <div className="pane-viewport" title="Viewport">
          {(["fit", "desktop", "tablet", "mobile"] as Viewport[]).map((v) => (
            <button
              key={v}
              className={`vp-btn ${viewport === v ? "on" : ""}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onSetViewport(v); }}
              title={v === "fit" ? "Fit pane" : VIEWPORT_PRESETS[v].label}
            >
              {v === "fit"
                ? "⤢"
                : v === "desktop"
                  ? "🖥"
                  : v === "tablet"
                    ? "📱"
                    : "📱"}
              <span className="vp-label">
                {v === "fit" ? "Fit" : VIEWPORT_PRESETS[v].label}
              </span>
            </button>
          ))}
        </div>

        <button
          className="pane-close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="Close persona"
        >
          ×
        </button>
      </div>

      {/* Placeholder for the native webview — painted on top by Rust. */}
      <div className="pane-slot" />

      <div className="pane-bottom">
        <div className="pane-resize" onPointerDown={onResizeDown} title="Resize" />
      </div>
    </div>
  );
}
