import { useCallback, useEffect, useRef, useState } from "react";
import {
  Pen,
  Square,
  ArrowUpRight,
  Type,
  Eraser,
  Undo2,
  Check,
  X,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tool = "pen" | "highlight" | "rect" | "arrow" | "text" | "eraser";

type Shape =
  | { type: "pen";       points: [number, number][]; color: string; width: number }
  | { type: "highlight"; points: [number, number][]; color: string; width: number }
  | { type: "rect";      x: number; y: number; w: number; h: number; color: string; width: number }
  | { type: "arrow";     x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { type: "text";      x: number; y: number; text: string; color: string; fontSize: number }
  | { type: "eraser";    points: [number, number][]; width: number };

// ─── Constants ────────────────────────────────────────────────────────────────

const PALETTE = ["#ef4444","#f97316","#eab308","#22c55e","#3b82f6","#a855f7","#ffffff","#111111"];
const STROKE_SIZES = [2, 5, 10];

interface TextInputState { screenX: number; screenY: number; canvasX: number; canvasY: number; value: string }

interface Props {
  imageDataUrl: string;
  imgWidth: number;
  imgHeight: number;
  onDone: (file: File) => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  lineWidth: number,
) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(lineWidth * 5, 18);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

function renderShape(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (shape.type) {
    case "pen":
      if (shape.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(shape.points[0][0], shape.points[0][1]);
      for (let i = 1; i < shape.points.length; i++)
        ctx.lineTo(shape.points[i][0], shape.points[i][1]);
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.stroke();
      break;

    case "highlight":
      if (shape.points.length < 2) break;
      ctx.globalAlpha = 0.38;
      ctx.beginPath();
      ctx.moveTo(shape.points[0][0], shape.points[0][1]);
      for (let i = 1; i < shape.points.length; i++)
        ctx.lineTo(shape.points[i][0], shape.points[i][1]);
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.lineCap = "square";
      ctx.stroke();
      break;

    case "rect":
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      break;

    case "arrow": {
      const { x1, y1, x2, y2, color, width } = shape;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      drawArrowhead(ctx, x1, y1, x2, y2, width);
      break;
    }

    case "text":
      ctx.font = `bold ${shape.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.fillStyle = shape.color;
      // Drop shadow for readability
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 4;
      ctx.fillText(shape.text, shape.x, shape.y);
      break;

    case "eraser":
      if (shape.points.length < 2) break;
      ctx.globalCompositeOperation = "destination-out" as GlobalCompositeOperation;
      ctx.beginPath();
      ctx.moveTo(shape.points[0][0], shape.points[0][1]);
      for (let i = 1; i < shape.points.length; i++)
        ctx.lineTo(shape.points[i][0], shape.points[i][1]);
      ctx.lineWidth = shape.width;
      ctx.stroke();
      break;
  }

  ctx.restore();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ScreenAnnotateOverlay({ imageDataUrl, imgWidth, imgHeight, onDone, onCancel }: Props) {
  // Three canvases: bg (hidden) + annot (hidden) → composite onto display
  const bgCanvasRef      = useRef<HTMLCanvasElement>(null);
  const annotCanvasRef   = useRef<HTMLCanvasElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);

  const [tool, setTool]           = useState<Tool>("pen");
  const [color, setColor]         = useState("#ef4444");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [shapes, setShapes]       = useState<Shape[]>([]);
  const shapesRef                 = useRef<Shape[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const currentShapeRef           = useRef<Shape | null>(null);
  const [textInput, setTextInput] = useState<TextInputState | null>(null);

  // Keep shapesRef in sync (used in event handlers that close over stale state)
  useEffect(() => { shapesRef.current = shapes; }, [shapes]);

  // ── Compositing ─────────────────────────────────────────────────────────────

  const composite = useCallback(() => {
    const display = displayCanvasRef.current;
    const bg      = bgCanvasRef.current;
    const annot   = annotCanvasRef.current;
    if (!display || !bg || !annot) return;
    const ctx = display.getContext("2d")!;
    ctx.clearRect(0, 0, imgWidth, imgHeight);
    ctx.drawImage(bg, 0, 0);
    ctx.drawImage(annot, 0, 0);
  }, [imgWidth, imgHeight]);

  const redrawAnnot = useCallback((shapesToDraw: Shape[], liveShape?: Shape | null) => {
    const annot = annotCanvasRef.current;
    if (!annot) return;
    const ctx = annot.getContext("2d")!;
    ctx.clearRect(0, 0, imgWidth, imgHeight);
    for (const s of shapesToDraw) renderShape(ctx, s);
    if (liveShape) renderShape(ctx, liveShape);
    composite();
  }, [imgWidth, imgHeight, composite]);

  // ── Load background ──────────────────────────────────────────────────────────

  useEffect(() => {
    const bg = bgCanvasRef.current;
    if (!bg) return;
    const ctx = bg.getContext("2d")!;
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      composite();
    };
    img.src = imageDataUrl;
  }, [imageDataUrl, composite]);

  // ── Scale helpers ────────────────────────────────────────────────────────────

  const getScale = useCallback(() => {
    const display = displayCanvasRef.current;
    if (!display) return { sx: 1, sy: 1 };
    const rect = display.getBoundingClientRect();
    return { sx: imgWidth / rect.width, sy: imgHeight / rect.height };
  }, [imgWidth, imgHeight]);

  const toCanvas = useCallback((e: React.MouseEvent | MouseEvent) => {
    const display = displayCanvasRef.current;
    if (!display) return { x: 0, y: 0 };
    const rect = display.getBoundingClientRect();
    const { sx, sy } = getScale();
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }, [getScale]);

  // ── Mouse handlers ───────────────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    if (tool === "text") {
      const display = displayCanvasRef.current;
      if (!display) return;
      const rect = display.getBoundingClientRect();
      const { x, y } = toCanvas(e);
      setTextInput({
        screenX: e.clientX - rect.left,
        screenY: e.clientY - rect.top,
        canvasX: x,
        canvasY: y,
        value: "",
      });
      return;
    }

    const { x, y } = toCanvas(e);
    setIsDrawing(true);

    let shape: Shape;
    if (tool === "pen") {
      shape = { type: "pen", points: [[x, y]], color, width: strokeWidth };
    } else if (tool === "highlight") {
      shape = { type: "highlight", points: [[x, y]], color, width: strokeWidth * 8 };
    } else if (tool === "rect") {
      shape = { type: "rect", x, y, w: 0, h: 0, color, width: strokeWidth };
    } else if (tool === "arrow") {
      shape = { type: "arrow", x1: x, y1: y, x2: x, y2: y, color, width: strokeWidth };
    } else {
      // eraser
      shape = { type: "eraser", points: [[x, y]], width: strokeWidth * 6 };
    }

    currentShapeRef.current = shape;
    redrawAnnot(shapesRef.current, shape);
  }, [tool, color, strokeWidth, toCanvas, redrawAnnot]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing || !currentShapeRef.current) return;
    const { x, y } = toCanvas(e);
    const cs = currentShapeRef.current;

    let updated: Shape;
    if (cs.type === "pen" || cs.type === "highlight" || cs.type === "eraser") {
      updated = { ...cs, points: [...cs.points, [x, y]] } as Shape;
    } else if (cs.type === "rect") {
      updated = { ...cs, w: x - cs.x, h: y - cs.y };
    } else if (cs.type === "arrow") {
      updated = { ...cs, x2: x, y2: y };
    } else {
      return;
    }

    currentShapeRef.current = updated;
    redrawAnnot(shapesRef.current, updated);
  }, [isDrawing, toCanvas, redrawAnnot]);

  const onMouseUp = useCallback(() => {
    if (!isDrawing || !currentShapeRef.current) return;
    setIsDrawing(false);
    const cs = currentShapeRef.current;
    currentShapeRef.current = null;

    let valid = false;
    if (cs.type === "pen" || cs.type === "highlight" || cs.type === "eraser") {
      valid = cs.points.length > 1;
    } else if (cs.type === "rect") {
      valid = Math.abs(cs.w) > 4 && Math.abs(cs.h) > 4;
    } else if (cs.type === "arrow") {
      const dx = cs.x2 - cs.x1, dy = cs.y2 - cs.y1;
      valid = Math.sqrt(dx * dx + dy * dy) > 10;
    }

    if (valid) {
      const next = [...shapesRef.current, cs];
      setShapes(next);
      redrawAnnot(next);
    } else {
      redrawAnnot(shapesRef.current);
    }
  }, [isDrawing, redrawAnnot]);

  // ── Text placement ───────────────────────────────────────────────────────────

  const commitText = useCallback(() => {
    if (!textInput?.value.trim()) { setTextInput(null); return; }
    const { sy } = getScale();
    const fontSize = Math.round(24 * sy); // 24 CSS px → scaled to canvas px
    const shape: Shape = {
      type: "text",
      x: textInput.canvasX,
      y: textInput.canvasY + fontSize, // baseline offset
      text: textInput.value,
      color,
      fontSize,
    };
    const next = [...shapesRef.current, shape];
    setShapes(next);
    redrawAnnot(next);
    setTextInput(null);
  }, [textInput, color, getScale, redrawAnnot]);

  // ── Undo ─────────────────────────────────────────────────────────────────────

  const undo = useCallback(() => {
    setShapes((prev) => {
      const next = prev.slice(0, -1);
      redrawAnnot(next);
      return next;
    });
  }, [redrawAnnot]);

  // ── Export ───────────────────────────────────────────────────────────────────

  const handleDone = useCallback(() => {
    // Flatten bg + annotations into one canvas
    const out = document.createElement("canvas");
    out.width  = imgWidth;
    out.height = imgHeight;
    const ctx = out.getContext("2d")!;
    const bg    = bgCanvasRef.current;
    const annot = annotCanvasRef.current;
    if (bg)    ctx.drawImage(bg, 0, 0);
    if (annot) ctx.drawImage(annot, 0, 0);
    out.toBlob((blob) => {
      if (blob) onDone(new File([blob], "screenshot.png", { type: "image/png" }));
    }, "image/png");
  }, [imgWidth, imgHeight, onDone]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (textInput) { setTextInput(null); return; }
        onCancel();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        undo();
      }
      if (e.key === "Enter" && textInput) {
        e.preventDefault();
        commitText();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, undo, textInput, commitText]);

  // ── Cursor style ─────────────────────────────────────────────────────────────

  const cursor = { pen: "crosshair", highlight: "crosshair", rect: "crosshair", arrow: "crosshair", text: "text", eraser: "cell" }[tool];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[210] flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm select-none">

      {/* Hidden canvases for compositing */}
      <canvas ref={bgCanvasRef}    width={imgWidth} height={imgHeight} style={{ display: "none" }} />
      <canvas ref={annotCanvasRef} width={imgWidth} height={imgHeight} style={{ display: "none" }} />

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center gap-1.5 rounded-2xl border border-white/10 bg-[#1c1c1e]/95 px-3 py-2 shadow-2xl backdrop-blur-md">

        {/* Tools */}
        {(
          [
            { id: "pen",       label: "Pen",       Icon: Pen          },
            { id: "highlight", label: "Highlight", Icon: () => (
              // Simple highlighter SVG (not available in lucide v1.7)
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="m9 11-6 6v3h9l3-3"/>
                <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>
              </svg>
            )},
            { id: "rect",      label: "Rectangle", Icon: Square       },
            { id: "arrow",     label: "Arrow",     Icon: ArrowUpRight  },
            { id: "text",      label: "Text",      Icon: Type         },
            { id: "eraser",    label: "Eraser",    Icon: Eraser       },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            title={label}
            onClick={() => setTool(id)}
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all ${
              tool === id
                ? "bg-white/20 text-white shadow-inner"
                : "text-white/40 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Icon />
          </button>
        ))}

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* Color palette */}
        {PALETTE.map((c) => (
          <button
            key={c}
            title={c}
            onClick={() => setColor(c)}
            className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110"
            style={{
              background: c,
              outline: color === c ? `2px solid white` : "2px solid transparent",
              outlineOffset: "1px",
            }}
          />
        ))}

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* Stroke width */}
        {STROKE_SIZES.map((w) => (
          <button
            key={w}
            onClick={() => setStrokeWidth(w)}
            title={`${w}px`}
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
              strokeWidth === w ? "bg-white/20" : "hover:bg-white/10"
            }`}
          >
            <div
              className="rounded-full bg-white"
              style={{ width: Math.min(w + 4, 14), height: Math.min(w + 4, 14) }}
            />
          </button>
        ))}

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* Undo */}
        <button
          onClick={undo}
          disabled={shapes.length === 0}
          title="Undo (Ctrl+Z)"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-20"
        >
          <Undo2 className="h-4 w-4" />
        </button>

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* Cancel */}
        <button
          onClick={onCancel}
          title="Cancel (Esc)"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/10 hover:text-red-400"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Done */}
        <button
          onClick={handleDone}
          title="Copy annotated screenshot to clipboard"
          className="flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >
          <Check className="h-3.5 w-3.5" />
          Copy to clipboard
        </button>
      </div>

      {/* ── Canvas area ─────────────────────────────────────────────────────── */}
      <div
        className="relative overflow-hidden rounded-xl border border-white/10 shadow-2xl"
        style={{
          // CSS constrains display size while canvas keeps full pixel resolution
          maxWidth: "90vw",
          maxHeight: "calc(100vh - 120px)",
          aspectRatio: `${imgWidth} / ${imgHeight}`,
        }}
      >
        {/* Display canvas — user interacts with this */}
        <canvas
          ref={displayCanvasRef}
          width={imgWidth}
          height={imgHeight}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            cursor,
            touchAction: "none",
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />

        {/* Floating text input */}
        {textInput && (
          <input
            autoFocus
            value={textInput.value}
            onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter")  { e.preventDefault(); commitText(); }
              if (e.key === "Escape") { e.preventDefault(); setTextInput(null); }
            }}
            className="absolute min-w-[120px] bg-transparent text-2xl font-bold outline-none"
            style={{
              left: textInput.screenX,
              top: textInput.screenY,
              color,
              borderBottom: `2px dashed ${color}`,
              caretColor: color,
              textShadow: "0 1px 4px rgba(0,0,0,0.7)",
            }}
            placeholder="Type…"
          />
        )}
      </div>

      {/* Bottom hint */}
      <p className="mt-2 text-[11px] text-white/25">
        Ctrl+Z undo · Esc cancel · Enter to place text
      </p>
    </div>
  );
}
