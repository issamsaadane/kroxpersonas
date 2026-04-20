import { useEffect, useRef } from "react";
import { FrameRect } from "./layout";

export const TITLE_H = 36;
export const EDGE    = 4;    // thin resize strip on right + bottom (replaces the old black bar)
export const MIN_W   = 320;
export const MIN_H   = 220;

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
  otherFrames: FrameRect[];
  onMove: (rect: FrameRect) => void;
  onFocus: () => void;
  onClose: () => void;
  onSetViewport: (v: Viewport) => void;
}

const SNAP = 8;
type ResizeDir = "e" | "s" | "se";

function intersects(a: FrameRect, b: FrameRect): boolean {
  return !(
    a.x + a.width  <= b.x ||
    b.x + b.width  <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

export function FramedPane({
  title,
  subtitle,
  frame,
  zIndex,
  viewport,
  workspaceBounds,
  otherFrames,
  onMove,
  onFocus,
  onClose,
  onSetViewport,
}: Props) {
  const dragRef = useRef<null | {
    mode: "move" | "resize";
    dir?: ResizeDir;
    startX: number;
    startY: number;
    startFrame: FrameRect;
  }>(null);

  const snapAndClamp = (r: FrameRect, mode: "move" | "resize"): FrameRect => {
    const wsW = Math.max(MIN_W, workspaceBounds.width);
    const wsH = Math.max(MIN_H, workspaceBounds.height);

    let { x, y, width, height } = r;
    width  = Math.max(MIN_W, Math.min(width,  wsW));
    height = Math.max(MIN_H, Math.min(height, wsH));

    if (mode === "resize") {
      width  = Math.min(width,  wsW - x);
      height = Math.min(height, wsH - y);
      for (const o of otherFrames) {
        const vAlign = !(y + height <= o.y || o.y + o.height <= y);
        const hAlign = !(x + width  <= o.x || o.x + o.width  <= x);
        if (vAlign && x < o.x && x + width  > o.x) width  = o.x - x;
        if (hAlign && y < o.y && y + height > o.y) height = o.y - y;
      }
      if (Math.abs(x + width  - wsW) < SNAP) width  = wsW - x;
      if (Math.abs(y + height - wsH) < SNAP) height = wsH - y;
      for (const o of otherFrames) {
        if (Math.abs((x + width)  - o.x) < SNAP) width  = o.x - x;
        if (Math.abs((y + height) - o.y) < SNAP) height = o.y - y;
      }
      width  = Math.max(MIN_W, width);
      height = Math.max(MIN_H, height);
      return { x, y, width, height };
    }

    // Move
    if (Math.abs(x) < SNAP) x = 0;
    if (Math.abs(y) < SNAP) y = 0;
    if (Math.abs(x + width  - wsW) < SNAP) x = wsW - width;
    if (Math.abs(y + height - wsH) < SNAP) y = wsH - height;
    for (const o of otherFrames) {
      if (Math.abs(x - (o.x + o.width)) < SNAP)   x = o.x + o.width;
      if (Math.abs((x + width)  - o.x) < SNAP)    x = o.x - width;
      if (Math.abs(y - (o.y + o.height)) < SNAP)  y = o.y + o.height;
      if (Math.abs((y + height) - o.y) < SNAP)    y = o.y - height;
      if (Math.abs(x - o.x) < SNAP) x = o.x;
      if (Math.abs((x + width)  - (o.x + o.width))  < SNAP) x = o.x + o.width  - width;
      if (Math.abs(y - o.y) < SNAP) y = o.y;
      if (Math.abs((y + height) - (o.y + o.height)) < SNAP) y = o.y + o.height - height;
    }
    x = Math.max(0, Math.min(x, wsW - width));
    y = Math.max(0, Math.min(y, wsH - height));
    for (const o of otherFrames) {
      if (!intersects({ x, y, width, height }, o)) continue;
      const overlapLeft   = (x + width)  - o.x;
      const overlapRight  = (o.x + o.width)  - x;
      const overlapTop    = (y + height) - o.y;
      const overlapBottom = (o.y + o.height) - y;
      const min = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
      if      (min === overlapLeft)   x = o.x - width;
      else if (min === overlapRight)  x = o.x + o.width;
      else if (min === overlapTop)    y = o.y - height;
      else                            y = o.y + o.height;
      x = Math.max(0, Math.min(x, wsW - width));
      y = Math.max(0, Math.min(y, wsH - height));
    }
    return { x, y, width, height };
  };

  const onTitleDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
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

  const onResizeDown = (dir: ResizeDir) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "resize",
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startFrame: { ...frame },
    };
  };

  useEffect(() => {
    let rafId = 0;
    let pending: FrameRect | null = null;

    const flush = () => { if (pending) { onMove(pending); pending = null; } rafId = 0; };
    const schedule = (r: FrameRect) => { pending = r; if (!rafId) rafId = requestAnimationFrame(flush); };

    const onMoveWin = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === "move") {
        schedule(snapAndClamp({
          ...d.startFrame,
          x: d.startFrame.x + dx,
          y: d.startFrame.y + dy,
        }, "move"));
      } else {
        const dir = d.dir ?? "se";
        schedule(snapAndClamp({
          ...d.startFrame,
          width:  d.startFrame.width  + (dir === "s" ? 0 : dx),
          height: d.startFrame.height + (dir === "e" ? 0 : dy),
        }, "resize"));
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
  }, [frame.x, frame.y, frame.width, frame.height, workspaceBounds.width, workspaceBounds.height, otherFrames.length]);

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

      {/* Native webview paints over this. It does NOT reach the right / bottom
          EDGE pixels — that thin strip is HTML, used for edge resize. */}
      <div className="pane-slot" />

      <div className="pane-edge e"  onPointerDown={onResizeDown("e")}  />
      <div className="pane-edge s"  onPointerDown={onResizeDown("s")}  />
      <div className="pane-edge se" onPointerDown={onResizeDown("se")} />
    </div>
  );
}
