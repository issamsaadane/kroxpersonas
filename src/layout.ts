/**
 * Workspace tiling logic — N panes → grid slots that fill the workspace
 * without overlap. Used by App.tsx to assign each open persona a slot.
 */

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const TILE_GAP = 6;      // pixels between tiles
const TILE_EDGE = 0;     // pixels between tiles and workspace edge

/**
 * Pick a (cols, rows) split for N panes. Prefers near-square layouts but
 * biases to more columns on wide workspaces (side-by-side feels right).
 */
function pickGrid(n: number, aspect: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  if (n === 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return aspect >= 1.8 ? { cols: 3, rows: 1 } : { cols: 2, rows: 2 };
  if (n === 4) return { cols: 2, rows: 2 };
  // 5+ → as square as possible, slightly biased to columns on wide screens.
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * Math.max(1, aspect / 1.4))));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

/**
 * Compute tile rects for `n` panes inside a (width, height) workspace.
 * Returns an array of FrameRect in pane order (index 0 → top-left, row-major).
 */
export function tileLayout(n: number, width: number, height: number): FrameRect[] {
  if (n <= 0 || width <= 0 || height <= 0) return [];
  const aspect = width / Math.max(1, height);
  const { cols, rows } = pickGrid(n, aspect);

  const usableW = width  - TILE_EDGE * 2;
  const usableH = height - TILE_EDGE * 2;
  const cellW = (usableW - TILE_GAP * (cols - 1)) / cols;
  const cellH = (usableH - TILE_GAP * (rows - 1)) / rows;

  const tiles: FrameRect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;

    // On the last row, if it has fewer panes than cols, stretch to fill.
    const lastRowPanes = n - Math.floor((n - 1) / cols) * cols;
    const isLastRow = row === rows - 1;
    const effectiveCols = isLastRow ? lastRowPanes : cols;
    const cellWidth = isLastRow
      ? (usableW - TILE_GAP * (effectiveCols - 1)) / effectiveCols
      : cellW;

    tiles.push({
      x: Math.round(TILE_EDGE + col * (cellWidth + TILE_GAP)),
      y: Math.round(TILE_EDGE + row * (cellH + TILE_GAP)),
      width:  Math.round(cellWidth),
      height: Math.round(cellH),
    });
  }
  return tiles;
}

export const LAYOUT_GAP = TILE_GAP;
