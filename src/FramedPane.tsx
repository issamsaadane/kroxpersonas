import { FrameRect } from "./layout";

export const TITLE_H  = 36;
export const BOTTOM_H = 0;   // No bottom strip in tiled mode — the tile owns the space.

export type Viewport = "fit" | "desktop" | "tablet" | "mobile";

export const VIEWPORT_PRESETS: Record<Exclude<Viewport, "fit">, { w: number; h: number; label: string }> = {
  desktop: { w: 1280, h: 800,  label: "Desktop" },
  tablet:  { w: 768,  h: 1024, label: "Tablet"  },
  mobile:  { w: 375,  h: 812,  label: "Mobile"  },
};

interface Props {
  title: string;
  subtitle?: string;
  frame: FrameRect;              // tile bounds (local to workspace)
  viewport: Viewport;
  onClose: () => void;
  onSetViewport: (v: Viewport) => void;
}

/**
 * A single tile in the auto-grid. Renders HTML chrome (title bar) on top of
 * where the native Tauri webview is painted. The webview is positioned by the
 * parent to match the "content rect" inside the tile.
 */
export function FramedPane({
  title,
  subtitle,
  frame,
  viewport,
  onClose,
  onSetViewport,
}: Props) {
  return (
    <div
      className="pane"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
      }}
    >
      <div className="pane-title">
        <span className="pane-title-name">{title}</span>
        {subtitle && <span className="pane-title-sub">{subtitle}</span>}
        <div className="pane-viewport" title="Viewport">
          {(["fit", "desktop", "tablet", "mobile"] as Viewport[]).map((v) => (
            <button
              key={v}
              className={`vp-btn ${viewport === v ? "on" : ""}`}
              onClick={(e) => { e.stopPropagation(); onSetViewport(v); }}
              title={v === "fit" ? "Fit tile" : VIEWPORT_PRESETS[v].label}
            >
              {v === "fit"     ? "⤢" :
               v === "desktop" ? "🖥" :
               v === "tablet"  ? "📱" :
                                 "📱"}
              <span className="vp-label">
                {v === "fit" ? "Fit" :
                 v === "mobile" ? "Mobile" :
                 v === "tablet" ? "Tablet" :
                 "Desktop"}
              </span>
            </button>
          ))}
        </div>
        <button
          className="pane-close"
          onClick={onClose}
          title="Close persona"
        >
          ×
        </button>
      </div>
      <div className="pane-slot" />
    </div>
  );
}
