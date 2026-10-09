// Canvas viewport math — the single pan/zoom authority for the session canvas.
//
// This is a VERBATIM port of the proven viewport module that shipped on the previous
// canvas (since-deleted apps/web/src/studio/viewport.ts): same formulas, same constants, same export
// names. It runs in production today and must not regress, so nothing here was
// "improved" during the port — only the doc comments were rewritten, because the old
// ones described node families (fleet companies / creative media nodes) that the new
// product model no longer has. The math is family-agnostic and always was.
//
// The new model: one infinite canvas of agent-session tiles, HTML-absolute inside a
// `transform: translate(x,y) scale(s)` world div, with SVG bezier wires between typed
// ports. Zoom drives level of detail (see ./lod). No React, no DOM here — pure math,
// fully unit-testable.

export interface ViewportState {
  /** world→screen translate in px, applied BEFORE scale (matches the CSS transform order). */
  x: number;
  y: number;
  /** zoom scale (1 = 100%). */
  scale: number;
}

export interface ViewportLimits {
  minScale: number;
  maxScale: number;
}

/**
 * Wide zoom range, sized so the overview fit (min 0.06, see fitOverview) and deep
 * inspection of a single tile both fit inside. Upstream infinite canvases run UNBOUNDED
 * (finite-guard only) — we deliberately keep a clamp: an unbounded canvas lets the operator
 * zoom into numerical noise or out to a dot with no way to judge where they are.
 */
export const DEFAULT_LIMITS: ViewportLimits = { minScale: 0.05, maxScale: 4 };

export function clampScale(scale: number, limits: ViewportLimits): number {
  return Math.min(limits.maxScale, Math.max(limits.minScale, scale));
}

/**
 * Cursor-anchored zoom: multiply scale by `factor` (clamped) while keeping the world
 * point currently under (cx, cy) fixed on screen. `cx`/`cy` are viewport-LOCAL pixel
 * coords (e.g. `event.clientX - rect.left`).
 */
export function zoomAt(
  view: ViewportState,
  factor: number,
  cx: number,
  cy: number,
  limits: ViewportLimits = DEFAULT_LIMITS,
): ViewportState {
  const scale = clampScale(view.scale * factor, limits);
  const ratio = scale / view.scale;
  return { scale, x: cx - (cx - view.x) * ratio, y: cy - (cy - view.y) * ratio };
}

// ---- Exponential wheel zoom ---------------------------------------------------------------
// Ported from the partner Infinite-Canvas frontend (commercial collaboration; source:
// smart-canvas.js canvasWheelZoomFactor, identical copy in canvas.js). The zoom multiplier is a
// CONTINUOUS exponential of deltaY — not a fixed step — so a mouse notch (±100) gives a crisp
// ~1.0833× while trackpad scrolls/pinches (small fractional deltas) zoom proportionally and feel
// native. This also dissolves the "distinguish trackpad-pinch from ctrl+wheel" problem: no
// modifier inspection is needed because deltaY magnitude already carries the intent.

/** Wheel-zoom sensitivity per deltaY pixel (upstream constant). */
export const WHEEL_ZOOM_SENSITIVITY = 0.0008;
/** Extra zoom sensitivity on macOS (upstream constant; navigator.platform starts with "Mac"). */
export const MAC_WHEEL_MULTIPLIER = 1.15;
/** Pixels assumed per line when deltaMode === DOM_DELTA_LINE (upstream constant). */
const LINE_UNIT_PX = 40;

/**
 * The zoom factor for a wheel event: exp(-deltaY · unit · sensitivity · macMult).
 * `pageSize` is the visible canvas height (used only for deltaMode === 2 / DOM_DELTA_PAGE).
 * Negative deltaY (scroll up / pinch out) zooms in.
 */
export function canvasWheelZoomFactor(
  deltaY: number,
  deltaMode: number,
  pageSize: number,
  isMac: boolean,
): number {
  const unit = deltaMode === 1 ? LINE_UNIT_PX : deltaMode === 2 ? pageSize : 1;
  return Math.exp(-deltaY * unit * WHEEL_ZOOM_SENSITIVITY * (isMac ? MAC_WHEEL_MULTIPLIER : 1));
}

/** Pan by a screen-space delta (px). */
export function panBy(view: ViewportState, dx: number, dy: number): ViewportState {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** Viewport-local pixel point → world point (inverse of the world transform). */
export function screenToWorld(view: ViewportState, px: number, py: number): { x: number; y: number } {
  return { x: (px - view.x) / view.scale, y: (py - view.y) / view.scale };
}

/** World point → viewport-local pixel point (forward transform). */
export function worldToScreen(view: ViewportState, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * view.scale + view.x, y: wy * view.scale + view.y };
}

/** New world coord for a node dragged by a screen-space delta (origin + delta/scale). */
export function dragToWorld(
  origin: { x: number; y: number },
  screenDx: number,
  screenDy: number,
  scale: number,
): { x: number; y: number } {
  return { x: origin.x + screenDx / scale, y: origin.y + screenDy / scale };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface Size {
  w: number;
  h: number;
}
/** Padding reserved when fitting content (extra bottom room for the composer overlay). */
export interface FitPadding {
  x: number;
  top: number;
  bottom: number;
}

export const DEFAULT_FIT_PADDING: FitPadding = { x: 56, top: 44, bottom: 220 };

/**
 * Floor for the AUTO-fit scale. Fitting purely to "everything is visible" is a trap once the
 * world is wide: with real data a sprawling world fits at ~0.32, rendering a tile at a size
 * where its controls cannot be hit at all. A canvas you cannot click is not "fitted", it is
 * unusable. Below this floor we stop zooming out and let the operator pan instead: seeing part
 * of the world at a workable size beats seeing all of it at an unworkable one.
 */
export const MIN_READABLE_FIT_SCALE = 0.75;

/**
 * Fit a world-space bounds into the viewport, centered, reserving padding: scale to the
 * tighter axis ratio (clamped), then center the bounds midpoint in the available area.
 * Returns the viewport that shows the whole bounds.
 */
export function fitBounds(
  bounds: Bounds,
  size: Size,
  limits: ViewportLimits = DEFAULT_LIMITS,
  pad: FitPadding = DEFAULT_FIT_PADDING,
): ViewportState {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const availW = Math.max(120, size.w - pad.x * 2);
  const availH = Math.max(120, size.h - pad.top - pad.bottom);
  // Never auto-fit below the readable floor (see MIN_READABLE_FIT_SCALE): overflow is pannable,
  // an uninteractable tile is not. The floor is applied BEFORE the limits clamp, so a caller can
  // only lower the result via a lower maxScale — a minScale below the floor cannot (deliberate:
  // the readable floor is the point). For an explicit go-below-readable view, use fitOverview.
  const raw = Math.max(Math.min(availW / bw, availH / bh), MIN_READABLE_FIT_SCALE);
  const scale = clampScale(raw, limits);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { scale, x: pad.x + availW / 2 - cx * scale, y: pad.top + availH / 2 - cy * scale };
}

/**
 * Opens bounds where they are instead of centring them: at `scale`, the bounds' top-left corner keeps
 * its current screen position under `view`, and the camera then moves only as far as needed to show
 * the whole bounds inside the padded stage (`pad.right`, default `pad.x`, keeps a panel on the right
 * clear). Bounds larger than the stage align to its top-left.
 */
export function openInPlace(view: ViewportState, bounds: Bounds, size: Size, scale: number, pad: FitPadding & { right?: number } = DEFAULT_FIT_PADDING): ViewportState {
  const width = (bounds.maxX - bounds.minX) * scale;
  const height = (bounds.maxY - bounds.minY) * scale;
  const place = (at: number, start: number, end: number) => end < start ? start : Math.min(Math.max(at, start), end);
  const left = place(bounds.minX * view.scale + view.x, pad.x, size.w - (pad.right ?? pad.x) - width);
  const top = place(bounds.minY * view.scale + view.y, pad.top, size.h - pad.bottom - height);
  return { scale, x: left - bounds.minX * scale, y: top - bounds.minY * scale };
}

/**
 * Whether the whole world-space bounds is on screen at `view` in a viewport of `size`
 * (edges inclusive). Used to decide if a saved viewport still shows the graph on THIS stage —
 * a view persisted on a wide monitor can leave half the graph off a laptop screen.
 */
export function boundsWithinViewport(bounds: Bounds, view: ViewportState, size: Size): boolean {
  if (size.w <= 0 || size.h <= 0 || !(view.scale > 0)) return false;
  const left = bounds.minX * view.scale + view.x;
  const top = bounds.minY * view.scale + view.y;
  const right = bounds.maxX * view.scale + view.x;
  const bottom = bounds.maxY * view.scale + view.y;
  return left >= 0 && top >= 0 && right <= size.w && bottom <= size.h;
}

/** Center a world point in a viewport of the given size, keeping the current scale. */
export function focusWorld(view: ViewportState, wx: number, wy: number, size: Size): ViewportState {
  return { ...view, x: (size.w || 1) / 2 - wx * view.scale, y: (size.h || 1) / 2 - wy * view.scale };
}

/** CSS transform string for the world div. */
export function worldTransform(view: ViewportState): string {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

/**
 * Viewport culling: return the ids of the boxes whose AABB intersects the visible world rect
 * (the viewport rect inverse-transformed to world space, padded by `margin` world units per
 * side). Off-screen tiles can then be skipped by the renderer. Empty `size` (viewport not
 * measured yet) means "unknown" and culls nothing.
 */
export function visibleBoxIds(
  boxes: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>,
  view: ViewportState,
  size: { w: number; h: number },
  margin = 200,
): ReadonlySet<string> {
  if (size.w <= 0 || size.h <= 0) return new Set(boxes.map((b) => b.id));
  const minX = (0 - view.x) / view.scale - margin;
  const minY = (0 - view.y) / view.scale - margin;
  const maxX = (size.w - view.x) / view.scale + margin;
  const maxY = (size.h - view.y) / view.scale + margin;
  const out = new Set<string>();
  for (const b of boxes) {
    if (b.x + b.w >= minX && b.x <= maxX && b.y + b.h >= minY && b.y <= maxY) out.add(b.id);
  }
  return out;
}

/** Axis-aligned bounds of a set of positioned boxes (for fit-to-content). */
export function boundsOfBoxes(
  boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
): Bounds {
  if (boxes.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX, minY, maxX, maxY };
}

// ---- Overview fit + minimap projection ----------------------------------------------------
// Ported from the partner Infinite-Canvas frontend (fitAllNodesViewport + renderMinimap in
// smart-canvas.js/canvas.js). Distinct from fitBounds() above: fitBounds is our first-layout
// fit with the MIN_READABLE_FIT_SCALE floor (tiles must stay interactable); fitOverview is the
// operator-invoked "see everything" map view, allowed to go far below readability because the
// paired restore (Z toggle) brings the previous viewport back.

/** Upstream fit constants: world-px bbox padding per side, screen margin, and the fit clamp. */
export const OVERVIEW_FIT = { padWorld: 160, marginScreen: 80, minScale: 0.06, maxScale: 0.82 } as const;
/** Upstream fallback scale when the canvas has no nodes (origin centered). */
export const EMPTY_CANVAS_SCALE = 0.45;

/** Fit ALL content for an overview: pad the bounds, fit to view minus margin, clamp [0.06, 0.82]. */
export function fitOverview(bounds: Bounds | null, size: Size): ViewportState {
  if (!bounds) {
    return { scale: EMPTY_CANVAS_SCALE, x: (size.w || 1) / 2, y: (size.h || 1) / 2 };
  }
  const bw = Math.max(1, bounds.maxX - bounds.minX + OVERVIEW_FIT.padWorld * 2);
  const bh = Math.max(1, bounds.maxY - bounds.minY + OVERVIEW_FIT.padWorld * 2);
  const raw = Math.min((Math.max(1, size.w) - OVERVIEW_FIT.marginScreen) / bw, (Math.max(1, size.h) - OVERVIEW_FIT.marginScreen) / bh);
  const scale = Math.min(OVERVIEW_FIT.maxScale, Math.max(OVERVIEW_FIT.minScale, raw));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { scale, x: (size.w || 1) / 2 - cx * scale, y: (size.h || 1) / 2 - cy * scale };
}

// Minimap (upstream renderMinimap): bounds = union of all node rects AND the current viewport's
// world rect, padded ±200 world px; a uniform scale centers that in the map box; node dots have a
// 4×4 px floor and the viewport rect an 8×8 floor so tiny worlds still show something clickable.

export const MINIMAP = { w: 170, h: 108, padWorld: 200, nodeMinPx: 4, viewMinPx: 8 } as const;

export interface MinimapProjection {
  nodes: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  viewRect: { x: number; y: number; w: number; h: number };
  /** Map-local px → world point (for click-to-center / scrub). */
  toWorld: (mx: number, my: number) => { x: number; y: number };
}

export function projectMinimap(
  boxes: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>,
  view: ViewportState,
  size: Size,
  mapW: number = MINIMAP.w,
  mapH: number = MINIMAP.h,
): MinimapProjection {
  // The viewport's world-space rectangle (what the operator currently sees).
  const vw = { x: -view.x / view.scale, y: -view.y / view.scale, w: (size.w || 1) / view.scale, h: (size.h || 1) / view.scale };
  let minX = vw.x, minY = vw.y, maxX = vw.x + vw.w, maxY = vw.y + vw.h;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  minX -= MINIMAP.padWorld; minY -= MINIMAP.padWorld; maxX += MINIMAP.padWorld; maxY += MINIMAP.padWorld;
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const s = Math.min(mapW / bw, mapH / bh);
  const ox = (mapW - bw * s) / 2 - minX * s;
  const oy = (mapH - bh * s) / 2 - minY * s;
  const px = (wx: number) => wx * s + ox;
  const py = (wy: number) => wy * s + oy;
  return {
    nodes: boxes.map((b) => ({
      id: b.id,
      x: px(b.x),
      y: py(b.y),
      w: Math.max(MINIMAP.nodeMinPx, b.w * s),
      h: Math.max(MINIMAP.nodeMinPx, b.h * s),
    })),
    viewRect: {
      x: px(vw.x),
      y: py(vw.y),
      w: Math.max(MINIMAP.viewMinPx, vw.w * s),
      h: Math.max(MINIMAP.viewMinPx, vw.h * s),
    },
    toWorld: (mx, my) => ({ x: (mx - ox) / s, y: (my - oy) / s }),
  };
}
