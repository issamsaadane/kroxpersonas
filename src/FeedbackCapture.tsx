import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ScreenAnnotateOverlay } from "./ScreenAnnotateOverlay";

/**
 * KroxPersonas feedback shortcut — same trigger as the main KroxFlow app:
 *
 *   press "f" twice within 400ms  →  screen capture → annotate overlay →
 *                                    copy annotated PNG to clipboard
 *
 * Persona webviews are painted over HTML by the native platform, so when
 * the annotate overlay appears we ask Rust to hide them (set_panes_visible
 * false). The overlay is a normal HTML layer — with webviews hidden it's
 * fully visible. On done/cancel, webviews come back.
 */

interface AnnotateState { dataUrl: string; w: number; h: number }

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

interface CaptureResult { dataUrl: string; width: number; height: number; looksBlank: boolean }

// Capture via Tauri-side Rust command (xcap crate). No browser permission
// prompt; macOS still requires a one-time Screen Recording permission — if
// that's missing, the capture silently returns an all-black image, which
// we detect server-side as `looksBlank`.
async function captureScreen(): Promise<CaptureResult> {
  return await invoke<CaptureResult>("capture_primary_screen");
}

export function FeedbackCapture() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [annotateState, setAnnotateState] = useState<AnnotateState | null>(null);
  const [copiedToast, setCopiedToast] = useState<"copied" | "failed" | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const lastFRef = useRef<number>(0);

  // Hide persona webviews whenever the annotate overlay is up; they'd cover
  // the HTML otherwise (native layer > HTML layer).
  useEffect(() => {
    const visible = !annotateState;
    invoke("set_panes_visible", { visible }).catch(() => {});
  }, [annotateState]);

  useEffect(() => {
    const startCapture = () => {
      if (isCapturing || annotateState) return;
      setIsCapturing(true);
      captureScreen()
        .then((r) => {
          if (!r) return;
          if (r.looksBlank) {
            // macOS without Screen Recording permission returns an all-black
            // frame — surface the fix-it flow instead of an unusable overlay.
            setNeedsPermission(true);
            return;
          }
          setAnnotateState({ dataUrl: r.dataUrl, w: r.width, h: r.height });
        })
        .catch(() => setCopiedToast("failed"))
        .finally(() => setIsCapturing(false));
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const now = Date.now();
      if (now - lastFRef.current < 400) {
        lastFRef.current = 0;
        e.preventDefault();
        startCapture();
      } else {
        lastFRef.current = now;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isCapturing, annotateState]);

  const handleAnnotateDone = async (file: File) => {
    setAnnotateState(null);
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": file })]);
      setCopiedToast("copied");
    } catch {
      // Fallback if the browser ClipboardItem is locked down: read the file
      // as blob URL and silently swallow. Toast shows "failed" — user can
      // re-run (v2 could write the PNG to a temp file via Rust instead).
      setCopiedToast("failed");
    }
    setTimeout(() => setCopiedToast(null), 1800);
  };

  return (
    <>
      {isCapturing && (
        <div className="fc-toast capturing">
          <span className="fc-spin" />
          Capturing screenshot…
        </div>
      )}

      {copiedToast && (
        <div className="fc-toast">
          {copiedToast === "copied" ? "Screenshot copied to clipboard" : "Could not copy — try again"}
        </div>
      )}

      {annotateState && (
        <ScreenAnnotateOverlay
          imageDataUrl={annotateState.dataUrl}
          imgWidth={annotateState.w}
          imgHeight={annotateState.h}
          onDone={handleAnnotateDone}
          onCancel={() => setAnnotateState(null)}
        />
      )}

      {needsPermission && (
        <div className="fc-permission-backdrop" onClick={() => setNeedsPermission(false)}>
          <div className="fc-permission" onClick={(e) => e.stopPropagation()}>
            <h2>Screen Recording permission needed</h2>
            <p>
              macOS returned a blank screenshot. KroxPersonas needs
              <strong> Screen Recording </strong>
              permission to capture the screen for the feedback tool.
            </p>
            <ol>
              <li>Open <strong>System Settings → Privacy &amp; Security → Screen Recording</strong>.</li>
              <li>Enable <strong>KroxPersonas</strong> in the list.</li>
              <li>Quit and re-launch KroxPersonas.</li>
            </ol>
            <div className="fc-permission-actions">
              <button
                className="btn"
                onClick={() => setNeedsPermission(false)}
              >
                Not now
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  invoke("open_screen_recording_settings").catch(() => {});
                  setNeedsPermission(false);
                }}
              >
                Open Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
