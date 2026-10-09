// The pan/zoom container for the session canvas.
//
// Ported from the previous canvas's viewport component (since-deleted apps/web/src/studio/CanvasViewport.tsx):
// same event wiring, same constants, same gates — only the class names changed
// (`studio-viewport`/`studio-world` → `canvas-viewport`/`canvas-world`) and the doc comments were
// rewritten, because the old ones described node families this canvas no longer has.
//
// It is a CONTROLLED component: the parent holds the ViewportState and receives changes via
// onViewChange, so the pure math in ./viewport stays the single source of truth and this file is
// only its event wiring:
//   - a NATIVE (non-passive) wheel listener, because React's onWheel is passive and therefore
//     cannot preventDefault the browser's own page zoom;
//   - pointer-based background pan, two-finger pinch, and the didPan click-suppression window;
//   - background double-click / context-menu callbacks, reported in BOTH world and client coords,
//     gated AUTHORITATIVELY on the event target being the bare viewport/world layer.
//
// The one deliberate addition over the ported original: `onBackgroundPointerDown` may return
// `true` to CLAIM the press, which suppresses the pan for that gesture. Shift+drag marquee
// selection needs exactly that — otherwise the same press would both pan the canvas and drag a
// selection box. Returning nothing keeps the original behavior.

import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import {
  type ViewportState,
  type ViewportLimits,
  DEFAULT_LIMITS,
  zoomAt,
  canvasWheelZoomFactor,
  panBy,
  screenToWorld,
  worldTransform,
} from './viewport';
import './canvas.css';

export interface CanvasViewportProps {
  view: ViewportState;
  onViewChange: (next: ViewportState) => void;
  children?: React.ReactNode;
  limits?: ViewportLimits;
  className?: string;
  /** Notified when the viewport element resizes (for the parent's fit math). */
  onResize?: (size: { w: number; h: number }) => void;
  /**
   * Called on background pointer-down BEFORE the pan starts (e.g. to clear an armed port).
   * Return `true` to claim the gesture — the viewport then does NOT pan (marquee selection).
   */
  onBackgroundPointerDown?: (e: React.PointerEvent) => boolean | void;
  /**
   * Double-click on EMPTY canvas, reported in world coordinates.
   *
   * Gating on the event target is authoritative: only the bare `canvas-viewport` / `canvas-world`
   * layers count. That is robust to any descendant that forgets to stopPropagation — a tile, a
   * port, an overlay — whereas relying on every child to claim its own dblclick fails open the
   * moment one forgets.
   */
  onBackgroundDoubleClick?: (world: { x: number; y: number }) => void;
  /**
   * Right-click on EMPTY canvas (same authoritative target gate), reported in BOTH coordinate
   * systems: world (where a created node should land) and client (where the fixed-chrome context
   * menu should open). The native browser menu is suppressed only when this handler claims it.
   */
  onBackgroundContextMenu?: (world: { x: number; y: number }, client: { x: number; y: number }) => void;
}

/** The bare background layers — the authoritative target gate for background gestures. */
export function isBackgroundTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t || !t.classList) return false;
  return t.classList.contains('canvas-viewport') || t.classList.contains('canvas-world');
}

export function CanvasViewport({
  view,
  onViewChange,
  children,
  limits = DEFAULT_LIMITS,
  className,
  onResize,
  onBackgroundPointerDown,
  onBackgroundDoubleClick,
  onBackgroundContextMenu,
}: CanvasViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  // Keep the latest view in a ref so the native wheel listener (bound once) reads fresh state.
  const viewRef = useRef(view);
  viewRef.current = view;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  // Native wheel listener — React onWheel is passive so it cannot preventDefault the page zoom.
  // The zoom curve is a CONTINUOUS exponential of deltaY (see canvasWheelZoomFactor). No modifier
  // branching: plain wheel, ctrl+wheel (trackpad pinch), shift/alt+wheel all zoom through the same
  // curve, and deltaY magnitude alone makes a mouse notch crisp (~1.083x) while trackpad deltas
  // zoom smoothly in proportion.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const isMac = /^Mac/.test(typeof navigator !== 'undefined' ? navigator.platform : '');
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const pageSize = el.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0) || 800;
      const factor = canvasWheelZoomFactor(e.deltaY, e.deltaMode, pageSize, isMac);
      onViewChangeRef.current(zoomAt(viewRef.current, factor, e.clientX - r.left, e.clientY - r.top, limits));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [limits]);

  // Track size for the parent's fit-to-content.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !onResize) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      onResize({ w: r.width, h: r.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onResize]);

  // Background pan (one pointer) and pinch-zoom (two pointers). Both ride Pointer Events, so a
  // single abstraction covers mouse, trackpad and TOUCH. The viewport must carry
  // `touch-action: none` (canvas.css) or the browser consumes the gestures before we do.
  // sx/sy/ox/oy are the pan-math anchor (rebased when the view changes externally, see below);
  // gx/gy are the IMMUTABLE gesture start used only for the didPan measurement — the rebase must
  // never reset them or a long pan would read as a 0px excursion at release.
  const pan = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; gx: number; gy: number } | null>(null);
  // Live positions of every pointer currently down on the background, keyed by pointerId.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Active pinch: the previous finger distance + midpoint, so each move is an incremental zoom
  // anchored at the (also-moving) midpoint — a natural pinch that zooms AND pans together.
  const pinch = useRef<{ lastDist: number; lastMidX: number; lastMidY: number } | null>(null);

  const localMidAndDist = () => {
    const el = viewportRef.current;
    const pts = Array.from(pointers.current.values());
    if (!el || pts.length < 2) return null;
    const r = el.getBoundingClientRect();
    const [a, b] = pts;
    return {
      midX: (a.x + b.x) / 2 - r.left,
      midY: (a.y + b.y) / 2 - r.top,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  // Pan-vs-click disambiguation: once a gesture pans more than the threshold (Manhattan), the
  // background double-click that may follow it is suppressed for 180ms — otherwise a sloppy pan
  // could end in an accidental "create a node here".
  const suppressClicksUntil = useRef(0);

  // Re-anchor an in-flight pan whenever the view changes. For our own pan-driven changes this is a
  // mathematical no-op (same delta from the new anchor), but for an EXTERNAL change mid-drag — a
  // waypoint recall, a focus fit — it stops the next pointermove from yanking the canvas back to
  // coordinates computed off the pre-change pan origin.
  useEffect(() => {
    const p = pan.current;
    if (!p) return;
    const pt = pointers.current.get(p.id);
    if (pt) pan.current = { id: p.id, sx: pt.x, sy: pt.y, ox: view.x, oy: view.y, gx: p.gx, gy: p.gy };
  }, [view]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const claimed = onBackgroundPointerDown?.(e) === true;
      // Left button pans; MIDDLE button (1) also pans. Touch/pen report button 0 for every
      // contact, so this admits each finger (enabling two-finger pinch) while still rejecting a
      // right-click drag.
      if (e.button !== 0 && e.button !== 1) return;
      if (e.button === 1) e.preventDefault(); // stop the browser's middle-click autoscroll
      // A claimed press (marquee) must not ALSO pan the canvas.
      if (claimed) return;
      const el = viewportRef.current;
      if (!el) return;
      el.setPointerCapture?.(e.pointerId); // jsdom / older engines may lack pointer capture
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.current.size >= 2) {
        // Second finger down → enter pinch, abandon any single-finger pan mid-flight.
        pan.current = null;
        const m = localMidAndDist();
        if (m) pinch.current = { lastDist: m.dist, lastMidX: m.midX, lastMidY: m.midY };
      } else {
        pan.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y, gx: e.clientX, gy: e.clientY };
      }
    },
    [onBackgroundPointerDown],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const tracked = pointers.current.get(e.pointerId);
      if (tracked) {
        tracked.x = e.clientX;
        tracked.y = e.clientY;
      }
      // Pinch takes precedence whenever two fingers are down.
      if (pinch.current && pointers.current.size >= 2) {
        const m = localMidAndDist();
        if (!m || m.dist <= 0 || pinch.current.lastDist <= 0) return;
        const factor = m.dist / pinch.current.lastDist;
        // Zoom anchored at the current midpoint, then translate by the midpoint's own drift so a
        // two-finger drag pans at the same time.
        const zoomed = zoomAt(viewRef.current, factor, m.midX, m.midY, limits);
        onViewChangeRef.current({
          ...zoomed,
          x: zoomed.x + (m.midX - pinch.current.lastMidX),
          y: zoomed.y + (m.midY - pinch.current.lastMidY),
        });
        pinch.current = { lastDist: m.dist, lastMidX: m.midX, lastMidY: m.midY };
        return;
      }
      const p = pan.current;
      if (!p || p.id !== e.pointerId) return;
      onViewChangeRef.current({ ...viewRef.current, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) });
    },
    [limits],
  );

  const endPan = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pan.current?.id === e.pointerId) {
      // didPan: Manhattan movement beyond the threshold marks this gesture as a pan, suppressing
      // the click/dblclick that trails it. The threshold is input-aware: 3px for a mouse but 10px
      // for touch — a finger legitimately wobbles 4–9px within the browser's own tap slop, and
      // suppressing there would silently eat double-tap-create.
      const threshold = e.pointerType === 'touch' ? 10 : 3;
      if (Math.abs(e.clientX - pan.current.gx) + Math.abs(e.clientY - pan.current.gy) > threshold) {
        suppressClicksUntil.current = Date.now() + 180;
      }
      pan.current = null;
    }
    if (pointers.current.size < 2) pinch.current = null;
    // If exactly one finger remains after a pinch, hand it back to pan so the gesture continues
    // smoothly instead of freezing until the user lifts and re-touches.
    if (pointers.current.size === 1 && !pan.current) {
      const [id, pt] = Array.from(pointers.current.entries())[0];
      pan.current = { id, sx: pt.x, sy: pt.y, ox: viewRef.current.x, oy: viewRef.current.y, gx: pt.x, gy: pt.y };
    }
  }, []);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onBackgroundDoubleClick) return;
      // A gesture that just panned is not a double-click (didPan gate).
      if (Date.now() < suppressClicksUntil.current) return;
      if (!isBackgroundTarget(e.target)) return;
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const v = viewRef.current; // live view — a render-closure scale can be stale mid-gesture
      onBackgroundDoubleClick(screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top));
    },
    [onBackgroundDoubleClick],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onBackgroundContextMenu) return;
      // Same authoritative target gate as double-click: only the bare background layers count —
      // right-clicking a tile / port / overlay keeps its native (or future node-level) menu.
      if (!isBackgroundTarget(e.target)) return;
      const el = viewportRef.current;
      if (!el) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const v = viewRef.current;
      onBackgroundContextMenu(
        screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top),
        { x: e.clientX, y: e.clientY },
      );
    },
    [onBackgroundContextMenu],
  );

  return (
    <div
      ref={viewportRef}
      className={`canvas-viewport${className ? ` ${className}` : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {/* The grid MOVES WITH THE WORLD. It used to be painted on the non-transformed root, so it
          never panned and never scaled: zooming made tiles grow against a stationary field, which
          the eye reads as "the content resized", not "I moved closer" — and that single missing
          cue is most of why an infinite canvas stops feeling like a space. Two layers: a fine one
          at 24 world-units that fades out below scale 0.3 rather than moiréing into mush, and a
          coarse one at 8× it so structure survives when the fine layer is gone. The dot radius is
          kept in SCREEN pixels so dots stay hairlines instead of swelling into blobs at 4×. */}
      <div className="canvas-grid" aria-hidden="true" style={gridStyle(view)} />
      <div className="canvas-grid canvas-grid--coarse" aria-hidden="true" style={gridStyle(view, 8)} />
      <div className="canvas-world" style={{ transform: worldTransform(view), transformOrigin: '0 0' }}>
        {children}
      </div>
    </div>
  );
}

/** Spacing of the fine grid, in WORLD units. */
const GRID_WORLD = 24;

/**
 * Background style for one grid layer at the current camera.
 *
 * The pattern is drawn in screen space but stepped by `world spacing × scale` and offset by the
 * pan, which is what makes it behave like part of the world without being inside the transformed
 * layer (a transformed background would rasterise its dots and blur them at every scale ≠ 1).
 *
 * The fine layer fades below ~0.3 instead of collapsing into moiré; the coarse layer never does,
 * so there is always SOMETHING to read motion against.
 */
export function gridStyle(view: ViewportState, multiple = 1): CSSProperties {
  const step = GRID_WORLD * multiple * view.scale;
  // Below a couple of px the pattern is noise, not structure — stop drawing it at all.
  if (!Number.isFinite(step) || step < 3) return { opacity: 0 };
  const fine = multiple === 1;
  const opacity = fine ? Math.min(1, Math.max(0, (view.scale - 0.18) / 0.35)) : 1;
  return {
    backgroundImage: `radial-gradient(var(--grid) ${fine ? 1 : 1.5}px, transparent ${fine ? 1 : 1.5}px)`,
    backgroundSize: `${step}px ${step}px`,
    backgroundPosition: `${view.x % step}px ${view.y % step}px`,
    opacity,
  };
}

/** Convenience: the panBy helper re-exported for parents that pan programmatically. */
export { panBy };
