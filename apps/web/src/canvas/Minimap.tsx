// Minimap — the world overview, ported from StudioMinimap (since-deleted apps/web/src/studio/StudioMinimap.tsx),
// which itself carries the partner Infinite-Canvas frontend's renderMinimap semantics verbatim:
//
//   - bounds = union of every node rect AND the current viewport's world rect, padded ±200 world
//     px, uniformly scaled and centered into the map box (projectMinimap in ./viewport);
//   - node dots have a 4×4 px floor and the viewport rect an 8×8 floor, so a tiny or a sprawling
//     world both stay visible and clickable;
//   - pointerdown (left) immediately CENTERS the main viewport on the clicked world point
//     (click = jump), and dragging keeps re-centering on the cursor's world point (drag = scrub,
//     absolute positioning rather than relative deltas);
//   - minimap interaction NEVER changes the zoom level — `onCenter` keeps the current scale, so
//     the operator's sense of size survives a jump across the world.
//
// Placement: fixed TOP-RIGHT but pushed DOWN below the host's login chip (`top: 72`), so it never
// covers or is covered by it. The host can override via `style` (e.g. shifting left while the
// inspector dock is open).

import { useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { MINIMAP, projectMinimap, type Size, type ViewportState } from './viewport';
import { useCanvasI18n } from './i18n';

const MAP_STYLE: CSSProperties = {
  position: 'fixed',
  top: 72,
  right: 16,
  zIndex: 30,
  overflow: 'hidden',
};

export function Minimap({
  boxes,
  view,
  size,
  onCenter,
  style,
}: {
  boxes: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>;
  view: ViewportState;
  /** The main viewport's pixel size — the projection needs it to draw the view rect. */
  size: Size;
  /** Center the main viewport on this world point, KEEPING the current scale. */
  onCenter: (wx: number, wy: number) => void;
  style?: CSSProperties;
}) {
  const { t } = useCanvasI18n();
  const proj = projectMinimap(boxes, view, size);
  const elRef = useRef<HTMLDivElement>(null);
  // The scrubbing pointer's id, null when idle. Tracking the id (not a boolean) plus the
  // e.buttons guard below keeps the scrub from sticking "on" in engines without pointer capture,
  // and keeps a second touch finger from ending the first finger's scrub.
  const dragId = useRef<number | null>(null);

  const centerAt = useCallback(
    (clientX: number, clientY: number) => {
      const el = elRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Re-project against the CURRENT props (proj is fresh each render; this call runs within
      // the same commit, so the render-scope proj is correct).
      const w = proj.toWorld(clientX - r.left, clientY - r.top);
      onCenter(w.x, w.y);
    },
    [proj, onCenter],
  );

  return (
    <div
      ref={elRef}
      className="canvas-minimap"
      style={{ ...MAP_STYLE, width: MINIMAP.w, height: MINIMAP.h, ...style }}
      aria-label={t('workspace.minimap')}
      data-testid="canvas-minimap"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation(); // never starts a canvas pan
        elRef.current?.setPointerCapture?.(e.pointerId);
        dragId.current = e.pointerId;
        centerAt(e.clientX, e.clientY); // click = jump-center immediately
      }}
      onPointerMove={(e) => {
        // buttons===0 catches a release that happened outside the map in engines without capture.
        if (dragId.current !== e.pointerId || e.buttons === 0) return;
        centerAt(e.clientX, e.clientY); // drag = scrub (absolute re-center)
      }}
      onPointerUp={(e) => {
        if (dragId.current === e.pointerId) dragId.current = null;
      }}
      onPointerCancel={(e) => {
        if (dragId.current === e.pointerId) dragId.current = null;
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {proj.nodes.map((n) => (
        <div key={n.id} className="canvas-minimap-node" style={{ position: 'absolute', left: n.x, top: n.y, width: n.w, height: n.h }} />
      ))}
      <div
        className="canvas-minimap-view"
        style={{
          position: 'absolute',
          left: proj.viewRect.x,
          top: proj.viewRect.y,
          width: proj.viewRect.w,
          height: proj.viewRect.h,
        }}
      />
    </div>
  );
}
