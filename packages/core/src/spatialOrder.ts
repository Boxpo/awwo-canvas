// Spatial ordering and hit-testing for keyboard navigation and marquee selection.
//
// An infinite canvas has no document order, but the operator reads it like one: left to right,
// top to bottom. Cmd+[ / Cmd+] step through tiles in that reading order, so the order has to
// match what the eye does — tiles whose tops are within a band count as the SAME row even when
// they are not pixel-aligned, and are then read left to right. Sorting purely by y would make
// two side-by-side tiles that differ by 3px into two separate "rows".
//
// Pure: world coordinates in, ids out. No React, no DOM.

/** The minimum a tile's top must differ by to start a new row. */
export const ROW_BAND_TOLERANCE = 80;

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
}

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Sort nodes into reading order: row bands by y (within `tolerance`), then left to right
 * inside each band. Ties break on y then id so the order is stable across renders.
 */
export function orderNodes<T extends PositionedNode>(
  nodes: ReadonlyArray<T>,
  tolerance: number = ROW_BAND_TOLERANCE,
): T[] {
  const byY = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const bands: T[][] = [];
  let band: T[] = [];
  let bandTop = 0;
  for (const node of byY) {
    if (band.length === 0 || node.y - bandTop <= tolerance) {
      if (band.length === 0) bandTop = node.y;
      band.push(node);
    } else {
      bands.push(band);
      band = [node];
      bandTop = node.y;
    }
  }
  if (band.length > 0) bands.push(band);
  const out: T[] = [];
  for (const b of bands) {
    b.sort((a, c) => a.x - c.x || a.y - c.y || a.id.localeCompare(c.id));
    out.push(...b);
  }
  return out;
}

/**
 * The id one step from `currentId` in `order`, wrapping at both ends.
 * `dir` is +1 (next) or -1 (previous). Returns null for an empty order. When `currentId` is
 * absent from the order (nothing focused, or a node that just went away) navigation starts at
 * the near end for that direction rather than silently doing nothing.
 */
export function nextIn(
  order: ReadonlyArray<{ id: string }>,
  currentId: string | null,
  dir: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const index = currentId === null ? -1 : order.findIndex((n) => n.id === currentId);
  if (index < 0) return (dir === 1 ? order[0] : order[order.length - 1]).id;
  const next = (index + dir + order.length) % order.length;
  return order[next].id;
}

/** Normalise a drag rectangle so a marquee pulled up/left is still a positive box. */
function normalizeRect(rect: WorldRect): WorldRect {
  const x = rect.w < 0 ? rect.x + rect.w : rect.x;
  const y = rect.h < 0 ? rect.y + rect.h : rect.y;
  return { x, y, w: Math.abs(rect.w), h: Math.abs(rect.h) };
}

/**
 * Ids of every node whose box overlaps `rect` (world space). Overlap is strict, so a
 * zero-area marquee or one that merely grazes a border selects nothing — a click that
 * happened to register as a 0px drag should not select the tile under it.
 */
export function hitTestRect(
  nodes: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>,
  rect: WorldRect,
): string[] {
  const r = normalizeRect(rect);
  // A degenerate marquee selects nothing. This needs its own guard rather than falling out of
  // the overlap test below: a zero-area rect dropped INSIDE a box still satisfies every
  // edge comparison, so a click that registered as a 0px drag would select the tile under it.
  if (!(r.w > 0) || !(r.h > 0)) return [];
  const out: string[] = [];
  for (const n of nodes) {
    if (n.x < r.x + r.w && n.x + n.w > r.x && n.y < r.y + r.h && n.y + n.h > r.y) out.push(n.id);
  }
  return out;
}
