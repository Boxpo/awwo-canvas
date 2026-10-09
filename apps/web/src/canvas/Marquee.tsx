// Shift+drag box selection over the canvas background.
//
// Two pieces, kept apart on purpose:
//   `useMarquee` owns the gesture and the arithmetic (client px → world rect → hit test), and
//   `Marquee` is the rectangle, drawn in WORLD coordinates inside the transformed world layer so
//   it tracks the content it is selecting through any pan or zoom that happens mid-drag.
//
// The hit test is `hitTestRect` from ./spatialOrder — this file never re-implements overlap. That
// matters for one specific honesty: a click that registered as a 0px drag selects NOTHING, because
// a degenerate rect dropped inside a tile would otherwise satisfy every edge comparison and
// "select" a tile the operator never boxed.
//
// The gesture starts from the viewport's `onBackgroundPointerDown`, which is why that callback
// returns a boolean: the marquee CLAIMS the press so the same drag does not also pan the canvas.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { CanvasNode } from './canvasDoc';
import { hitTestRect, type WorldRect } from './spatialOrder';
import type { ViewportState } from './viewport';
import { isBackgroundTarget } from './CanvasViewport';

export interface MarqueeApi {
  /** Live rect in world coords while dragging, else null. Feed it to <Marquee />. */
  rect: WorldRect | null;
  /**
   * Wire to `CanvasViewport.onBackgroundPointerDown`. Returns true when it CLAIMS the press
   * (Shift held, left button, bare background) so the viewport suppresses its pan.
   */
  onBackgroundPointerDown: (e: React.PointerEvent) => boolean;
}

export interface UseMarqueeOptions {
  /** Explicit selection tool; Shift+drag remains available in pan mode. */
  enabled?: boolean;
  nodes: ReadonlyArray<CanvasNode>;
  /** The `.canvas-root` element — used to locate `.canvas-viewport` for client→world math. */
  rootRef: RefObject<HTMLElement | null>;
  view: ViewportState;
  /** Ids of every node the box overlapped. `additive` is true when the gesture began with Meta/Ctrl. */
  onSelect: (ids: string[], additive: boolean) => void;
}

export function useMarquee({ nodes, rootRef, view, onSelect, enabled = false }: UseMarqueeOptions): MarqueeApi {
  const [rect, setRect] = useState<WorldRect | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // Teardown of the CURRENT gesture. Held in a ref so unmount can tear it down too — a leaked
  // window listener would keep painting a ghost box over a canvas that is gone.
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => teardownRef.current?.(), []);

  const toWorld = useCallback(
    (cx: number, cy: number) => {
      const vp = rootRef.current?.querySelector('.canvas-viewport');
      const r = vp?.getBoundingClientRect();
      const v = viewRef.current;
      if (!r) return { x: 0, y: 0 };
      return { x: (cx - r.left - v.x) / v.scale, y: (cy - r.top - v.y) / v.scale };
    },
    [rootRef],
  );

  const onBackgroundPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((!e.shiftKey && !enabled) || e.button !== 0) return false;
      // Only the bare background starts a marquee — a shift-press on a tile belongs to the tile.
      if (!isBackgroundTarget(e.target)) return false;
      teardownRef.current?.();
      const additive = e.metaKey || e.ctrlKey;
      const start = toWorld(e.clientX, e.clientY);
      const pointerId = e.pointerId;
      const captureTarget = e.currentTarget;
      let live: WorldRect = { x: start.x, y: start.y, w: 0, h: 0 };
      setRect(live);

      let done = false;
      const teardown = () => {
        if (done) return;
        done = true;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        captureTarget.removeEventListener('lostpointercapture', lostCapture);
        try {
          if (!captureTarget.hasPointerCapture || captureTarget.hasPointerCapture(pointerId)) {
            captureTarget.releasePointerCapture?.(pointerId);
          }
        } catch { /* Capture may already have been released by the browser or DOM teardown. */ }
        teardownRef.current = null;
        setRect(null);
      };
      const move = (pe: PointerEvent) => {
        if (pe.pointerId !== pointerId) return;
        const p = toWorld(pe.clientX, pe.clientY);
        live = { x: start.x, y: start.y, w: p.x - start.x, h: p.y - start.y };
        setRect(live);
      };
      const cancel = (pe: PointerEvent) => {
        if (pe.pointerId !== pointerId) return;
        teardown(); // aborted → no selection change at all
      };
      const lostCapture = (event: Event) => {
        if ('pointerId' in event && event.pointerId === pointerId) teardown();
      };
      const up = (pe: PointerEvent) => {
        if (pe.pointerId !== pointerId) return;
        const finished = live;
        teardown();
        // hitTestRect is the authority: it normalises a box pulled up/left and rejects a
        // degenerate (0-area) marquee, so a stray click can never select the tile under it.
        onSelectRef.current(hitTestRect(nodesRef.current, finished), additive);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      captureTarget.addEventListener('lostpointercapture', lostCapture);
      teardownRef.current = teardown;
      // The viewport skips its own capture when we claim the press. Own it here so moving over
      // an opaque deliverable iframe cannot swallow pointerup and leave a suspended marquee.
      try { captureTarget.setPointerCapture?.(pointerId); } catch { /* Older engines retain the window-listener fallback. */ }
      return true;
    },
    [toWorld, enabled],
  );

  return { rect, onBackgroundPointerDown };
}

/** The selection box itself. Render inside the world layer (it is in world coords). */
export function Marquee({ rect }: { rect: WorldRect | null }) {
  if (!rect) return null;
  const x = rect.w < 0 ? rect.x + rect.w : rect.x;
  const y = rect.h < 0 ? rect.y + rect.h : rect.y;
  return (
    <div
      className="canvas-marquee"
      data-testid="canvas-marquee"
      style={{ left: x, top: y, width: Math.abs(rect.w), height: Math.abs(rect.h) }}
    />
  );
}
