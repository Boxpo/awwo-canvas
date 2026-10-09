// Zoom-driven level of detail for session tiles.
//
// Every tile renders a live conversation. At overview zoom that transcript is unreadable
// noise, so the tile must simplify — but simplification has to key off what the operator can
// ACTUALLY read, which is the tile's EFFECTIVE PIXEL HEIGHT (node.h * scale), not the zoom
// scale alone. A 600px-tall tile at 0.25 is still 150px of readable surface; a 120px tile at
// the same zoom is a 30px sliver. Keying on scale alone would blank the first and over-render
// the second.
//
// Pure: no React, no DOM, no measurement — the tile passes its own height and the current
// scale, and gets back which face to draw.

/**
 * - glance: too small to read — identity only (title / status dot / kind glyph).
 * - card:   a headline plus the last few lines.
 * - open:   a working transcript tail.
 * - focus:  the operator has this tile focused — full transcript and composer, regardless of
 *           zoom (focus is an explicit intent and outranks the size heuristic).
 */
export type TileLod = 'glance' | 'card' | 'open' | 'focus';

/** Effective-pixel-height thresholds between the size-driven tiers. */
export const LOD_GLANCE_MAX_PX = 90;
export const LOD_CARD_MAX_PX = 200;

/** How many trailing transcript lines each tier renders. */
export const TAIL_LINES: Record<TileLod, number> = {
  glance: 0,
  card: 3,
  open: 12,
  focus: Infinity,
};

/**
 * Which face a tile should draw at the current zoom.
 * `focused` wins outright; otherwise the tier follows the tile's on-screen height.
 */
export function lodFor(node: { h: number }, scale: number, focused: boolean): TileLod {
  if (focused) return 'focus';
  const effectiveHeight = node.h * scale;
  if (!Number.isFinite(effectiveHeight) || effectiveHeight < LOD_GLANCE_MAX_PX) return 'glance';
  if (effectiveHeight < LOD_CARD_MAX_PX) return 'card';
  return 'open';
}
