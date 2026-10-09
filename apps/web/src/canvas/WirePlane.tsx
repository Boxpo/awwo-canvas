// The wire layer: every committed edge plus the live drag preview, drawn in WORLD coordinates.
//
// Ported from the previous canvas's edge rendering (since-deleted apps/web/src/studio/StudioCanvas.tsx): a
// zero-box, overflow-visible SVG sitting inside the transformed world, so the world transform
// scales the strokes with everything else and no separate projection can drift from the tiles.
//
// Two rules carried over unchanged:
//  - A wire whose endpoint port cannot be resolved is NOT drawn. `portAnchorWorld` returns null
//    when the node no longer exposes that port (e.g. an image session's 'reference' input after
//    the tile was switched to LLM); falling back to a made-up point would render a connection
//    that does not exist. (`reconcileEdges` removes such edges from the document; a null here
//    means the caller is drawing from unreconciled state.)
//  - Disconnect is a DOUBLE-click on a wide invisible hit path, never a single click: an
//    accidental brush across a line must not sever a wiring. The hit path also stops its own
//    pointerdown, because the viewport's setPointerCapture would otherwise retarget the derived
//    dblclick to the background (real-browser UI Events behavior) — the disconnect would never
//    fire and the background's own double-click gesture would run instead.

import { useId } from 'react';
import type { CanvasEdge, CanvasNode } from './canvasDoc';
import { edgeBezierPath, portAnchorWorld } from './ports';
import { useCanvasI18n, type CanvasTextKey } from './i18n';
import type { RunNodeStatus } from './runGraph';
import type { WireDrag } from './TilePorts';
import { wirePath, wireState, type WireState } from './wireState';
import './wire-state.css';

const STATE_TEXT: Record<WireState, CanvasTextKey> = {
  idle: 'wire.idle', waiting: 'wire.waiting', flowing: 'wire.flowing', delivered: 'wire.delivered',
  failed: 'wire.failed', blocked: 'wire.blocked', cancelled: 'wire.cancelled',
};

export interface WirePlaneProps {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  /** The in-flight drag-to-wire gesture (from `useWiring`), or null. */
  preview?: WireDrag | null;
  /** Omitted → wires render without a disconnect affordance. */
  onDisconnect?: (edge: CanvasEdge) => void;
  runs?: Readonly<Record<string, RunNodeStatus>>;
  running?: boolean;
  round?: number;
  /** World zoom; keeps directional arrowheads readable at fit-to-canvas scale. */
  scale?: number;
  selectedEdgeId?: string;
  onSelectEdge?: (edgeId: string) => void;
}

export function WirePlane({ nodes, edges, preview = null, onDisconnect, runs = {}, running = false, round = 1, scale = 1, selectedEdgeId, onSelectEdge }: WirePlaneProps) {
  const { t } = useCanvasI18n();
  const markerPrefix = useId().replace(/:/g, '');
  const markerSize = 12 / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg
      className="canvas-wires"
      width={1}
      height={1}
      style={{ position: 'absolute', overflow: 'visible' }}
      role="group"
      aria-label={t('workspace.connectionCount', { count: edges.length })}
    >
      {edges.map((e, index) => {
        const from = nodeById.get(e.fromNode);
        const to = nodeById.get(e.toNode);
        if (!from || !to) return null;
        const a = portAnchorWorld(from, e.fromPort);
        const b = portAnchorWorld(to, e.toPort);
        if (!a || !b) return null; // unresolvable endpoint → draw nothing, invent nothing
        const feedback = e.kind === 'feedback';
        const d = wirePath(a, b, feedback, Math.min(from.y, to.y));
        const state = wireState({ kind: e.kind, from: runs[e.fromNode], to: runs[e.toNode], running, round });
        const markerId = `${markerPrefix}-wire-arrow-${index}`;
        const selected = selectedEdgeId === e.id;
        const interactive = Boolean(onSelectEdge || onDisconnect);
        const label = t('wire.connection', { from: from.title, to: to.title, kind: t(feedback ? 'wire.feedback' : 'wire.data'), state: t(STATE_TEXT[state]) });
        const hint = [onSelectEdge ? t('wire.selectHint') : '', onDisconnect ? t('wire.disconnectHint') : ''].filter(Boolean).join(' · ');
        return (
          <g
            key={e.id}
            className={`canvas-wire-link canvas-wire-link--${state}${feedback ? ' canvas-wire-link--feedback' : ''}${selected ? ' canvas-wire-link--selected' : ''}`}
            role={onSelectEdge ? 'button' : interactive ? 'group' : 'img'}
            tabIndex={interactive ? 0 : undefined}
            aria-label={label}
            aria-pressed={onSelectEdge ? selected : undefined}
            aria-describedby={hint ? `${markerId}-hint` : undefined}
            data-wire-state={state}
            data-wire-kind={feedback ? 'feedback' : 'data'}
            onPointerDown={interactive ? (ev) => ev.stopPropagation() : undefined}
            onClick={onSelectEdge ? (ev) => { ev.stopPropagation(); onSelectEdge(e.id); } : undefined}
            onDoubleClick={interactive ? (ev) => { ev.stopPropagation(); onDisconnect?.(e); } : undefined}
            onKeyDown={interactive ? (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault(); ev.stopPropagation(); onSelectEdge?.(e.id);
              } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
                ev.preventDefault(); ev.stopPropagation(); onDisconnect?.(e);
              }
            } : undefined}
          >
            <title>{label}</title>
            {hint ? <desc id={`${markerId}-hint`}>{hint}</desc> : null}
            <defs>
              <marker id={markerId} markerWidth={markerSize} markerHeight={markerSize} viewBox="0 0 12 12" refX="11" refY="6" orient="auto" markerUnits="userSpaceOnUse">
                <path className="canvas-wire-arrow" d="M 1 1 L 11 6 L 1 11 Z" />
              </marker>
            </defs>
            <path className="canvas-wire-selection" d={d} vectorEffect="non-scaling-stroke" aria-hidden="true" />
            <path className={`canvas-wire canvas-wire--${e.dataType}`} d={d} markerEnd={`url(#${markerId})`} vectorEffect="non-scaling-stroke" data-testid={`canvas-wire-${e.id}`} aria-hidden="true" />
            {state === 'flowing' ? <path className="canvas-wire-flow" d={d} vectorEffect="non-scaling-stroke" data-testid={`canvas-wire-flow-${e.id}`} aria-hidden="true" /> : null}
            {interactive ? (
              <path
                className="canvas-wire-hit"
                d={d}
                vectorEffect="non-scaling-stroke"
                data-testid={`canvas-wire-hit-${e.id}`}
                aria-hidden="true"
              />
            ) : null}
          </g>
        );
      })}
      {preview
        ? (() => {
            const n = nodeById.get(preview.from.nodeId);
            if (!n) return null;
            const a = portAnchorWorld(n, preview.from.portId);
            if (!a) return null;
            // The preview runs FROM the anchor when the gesture started on an output, and INTO it
            // when it started on an input, so the curve's handles read the same direction the
            // committed wire will.
            const d = preview.side === 'output' ? edgeBezierPath(a, preview.world) : edgeBezierPath(preview.world, a);
            return <path className="canvas-wire canvas-wire-preview" d={d} data-testid="canvas-wire-preview" />;
          })()
        : null}
    </svg>
  );
}
