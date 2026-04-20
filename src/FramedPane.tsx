import { useEffect, useRef } from "react";

// Sizes match the ones the Rust side uses when computing the webview rect.
export const TITLE_H  = 36;
export const BOTTOM_H = 16;
export const MIN_W    = 320;
export const MIN_H    = 220;

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Props {
  title: string;
  subtitle?: string;
  accent?: string;
  frame: FrameRect;
  zIndex: number;
  workspaceBounds: { width: number; height: number };
  onMove: (rect: FrameRect) => void;
  onFocus: () => void;
  onClose: () => void;
}

/**
 * A movable/resizable "window" frame inside the workspace.
 *
 * - Title bar at the top is the drag handle.
 * - A thin bottom strip hosts the diagonal resize grip at the right.
 * - The middle is a transparent "slot" where the native Tauri webview is
 *   rendered on top (by Rust). Nothing inside the slot receives HTML
 *   pointer events — the webview owns them.
 */
export function FramedPane({
  title,
  subtitle,
  accent = "#7c5cff",
  frame,
  zIndex,
  workspaceBounds,
  onMove,
  onFocus,
  onClose,
}: Props) {
  const dragRef = useRef<null | {
    mode: "move" | "resize";
    startX: number;
    startY: number;
    startFrame: FrameRect;
  }>(null);

  const clamp = (r: FrameRect): FrameRect => {
    const width  = Math.max(MIN_W, r.width);
    const height = Math.max(MIN_H, r.height);
    const x = Math.max(0, Math.min(r.x, workspaceBounds.width - 40));
    const y = Math.max(0, Math.min(r.y, workspaceBounds.height - TITLE_H));
    return { x, y, width, height };
  };

  const onTitleDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onFocus();
    (e.target as Element).setPointerCapture(e.pointerId);
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
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      startFrame: { ...frame },
    };
  };

  // Use a rAF-throttled handler so we don't spam IPC on every pointermove.
  useEffect(() => {
    let rafId = 0;
    let pending: FrameRect | null = null;

    const flush = () => {
      if (pending) {
        onMove(pending);
        pending = null;
      }
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
        borderTopColor: accent,
      }}
      onMouseDown={onFocus}
    >
      <div className="pane-title" onPointerDown={onTitleDown}>
        <span className="pane-title-name">{title}</span>
        {subtitle && <span className="pane-title-sub">{subtitle}</span>}
        <button
          className="pane-close"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          title="Close persona"
        >
          ×
        </button>
      </div>
      {/* Placeholder for the native webview — rendered on top by Rust. */}
      <div className="pane-slot" />
      <div className="pane-bottom">
        <div className="pane-resize" onPointerDown={onResizeDown} title="Resize" />
      </div>
    </div>
  );
}
