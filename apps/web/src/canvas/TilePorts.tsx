// Port handles on a tile + the wiring gesture that connects them.
//
// The gesture is ported from the previous canvas (since-deleted apps/web/src/studio/StudioCanvas.tsx) VERBATIM
// in behavior — it is the wiring that ships today and must not regress:
//
//   - click-click wiring: click an OUTPUT port to arm it, then a compatible INPUT port completes;
//     a background press disarms.
//   - drag-to-wire: press a port and drag (>4px Manhattan) — a live preview bezier follows the
//     cursor in WORLD space; release over a port of the opposite polarity connects.
//   - leak-proof teardown: every move/up/cancel listener is attached to the PORT BUTTON itself
//     with pointer capture (no window listeners to leak), `pointercancel` aborts the gesture, and
//     the current teardown is held in a ref so component unmount tears it down too. A leaked
//     listener would trail a ghost preview and could fire a phantom connection.
//   - `canConnect` (./ports) is the ONLY authority on validity — self-node, occupied input, type
//     mismatch. This file never re-implements that judgement.
//   - `onConnect` carries the SOURCE port's REAL dataType, read from `portsFor` at connect time.
//     It is never guessed and never defaulted: if the source spec cannot be resolved, no edge is
//     reported at all. (The old canvas fell back to a wildcard 'any'; this canvas's type set is
//     closed, so a fallback could only smuggle in a mistyped wire.)
//
// Port handles render at EVERY level of detail. Wires are the graph's structure, not a detail of
// one zoom tier: hiding the handles when zoomed out would hide the only affordance for reading
// and repairing that structure.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { CanvasEdge, CanvasNode } from './canvasDoc';
import {
  type DataType,
  type PortRef,
  type PortSide,
  type PortSpec,
  canConnect,
  portAnchorWorld,
  portsFor,
} from './ports';
import type { ViewportState } from './viewport';
import { useCanvasI18n, type CanvasTextKey } from './i18n';

export interface WireDrag {
  from: PortRef;
  /** Polarity of the port the gesture STARTED on (a drag may run either direction). */
  side: PortSide;
  /** Cursor position in world coords, for the preview bezier. */
  world: { x: number; y: number };
}

export interface WiringApi {
  /** The armed output port of a click-click wiring, if any. */
  pendingPort: PortRef | null;
  /** The in-flight drag-to-wire gesture, if any (drives the preview bezier). */
  wireDrag: WireDrag | null;
  /** True when ports should render as interactive (an onConnect handler exists). */
  interactive: boolean;
  /** How many wires currently land on (or leave) a given port. Drives the connected state and
   *  the fan-in count badge — with a multi input you have to be able to SEE that three things
   *  feed this node, not discover it when the prompt comes out wrong. */
  wireCount: (nodeId: string, portId: string, side: PortSide) => number;
  /** Disarm the click-click flow — wire this to the viewport's background pointer-down. */
  clearPending: () => void;
  onPortPointerDown: (nodeId: string, port: PortSpec, e: React.PointerEvent) => void;
  onPortClick: (nodeId: string, port: PortSpec, e: React.MouseEvent) => void;
}

export interface UseWiringOptions {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  /** Omitted → ports render inert (still visible: they are the graph's structure). */
  onConnect?: (from: PortRef, to: PortRef, dataType: DataType) => void;
  /** The `.canvas-root` element — used to locate `.canvas-viewport` for client→world math. */
  rootRef: RefObject<HTMLElement | null>;
  /** Current viewport (read through a ref inside the gesture, so mid-drag zoom stays correct). */
  view: ViewportState;
}

export function useWiring({ nodes, edges, onConnect, rootRef, view }: UseWiringOptions): WiringApi {
  const [pendingPort, setPendingPort] = useState<PortRef | null>(null);
  const [wireDrag, setWireDrag] = useState<WireDrag | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  // Read through refs inside the gesture so a mid-drag prop change dispatches against the CURRENT
  // graph and handler, not the ones captured at pointerdown.
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // Teardown of the CURRENT wire gesture, if any. Held in a ref so pointercancel AND component
  // unmount can both tear it down — the gesture must never outlive the pointer or the component.
  const wireTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => wireTeardownRef.current?.(), []);

  const clearPending = useCallback(() => setPendingPort(null), []);

  /** Resolve the SOURCE port's real dataType and report the edge. Never guesses a type. */
  const emit = useCallback((from: PortRef, to: PortRef) => {
    const fromNode = nodesRef.current.find((n) => n.id === from.nodeId);
    if (!fromNode) return;
    const spec = portsFor(fromNode).find((p) => p.side === 'output' && p.id === from.portId);
    if (!spec) return; // unresolvable source → no edge, rather than an invented type
    onConnectRef.current?.(from, to, spec.dataType);
  }, []);

  const onPortClick = useCallback(
    (nodeId: string, port: PortSpec, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!onConnectRef.current) return;
      if (port.side === 'output') {
        setPendingPort({ nodeId, portId: port.id });
        return;
      }
      if (pendingPort) {
        const to: PortRef = { nodeId, portId: port.id };
        if (canConnect(nodesRef.current, edgesRef.current, pendingPort, to)) emit(pendingPort, to);
        setPendingPort(null);
      }
    },
    [pendingPort, emit],
  );

  const onPortPointerDown = useCallback(
    (nodeId: string, p: PortSpec, e: React.PointerEvent) => {
      // Never let a port press start a tile drag or a background pan.
      e.stopPropagation();
      if (!onConnectRef.current || e.button !== 0) return;
      wireTeardownRef.current?.(); // never run two wire gestures at once
      const toWorld = (cx: number, cy: number) => {
        const vp = rootRef.current?.querySelector('.canvas-viewport');
        const r = vp?.getBoundingClientRect();
        const v = viewRef.current;
        return r ? { x: (cx - r.left - v.x) / v.scale, y: (cy - r.top - v.y) / v.scale } : { x: 0, y: 0 };
      };
      // Capture the pointer to THIS port button so every subsequent move/up/cancel is delivered to
      // it even if the cursor leaves the window — no window listeners to leak.
      const btn = e.currentTarget as HTMLElement;
      btn.setPointerCapture?.(e.pointerId);
      let moved = false;
      let done = false;
      const sx = e.clientX;
      const sy = e.clientY;
      const teardown = () => {
        if (done) return;
        done = true;
        btn.removeEventListener('pointermove', move);
        btn.removeEventListener('pointerup', up);
        btn.removeEventListener('pointercancel', cancel);
        btn.releasePointerCapture?.(e.pointerId);
        wireTeardownRef.current = null;
        setWireDrag(null);
      };
      const move = (pe: PointerEvent) => {
        if (pe.pointerId !== e.pointerId) return;
        if (Math.abs(pe.clientX - sx) + Math.abs(pe.clientY - sy) > 4) moved = true;
        if (moved) setWireDrag({ from: { nodeId, portId: p.id }, side: p.side, world: toWorld(pe.clientX, pe.clientY) });
      };
      const cancel = (pe: PointerEvent) => {
        if (pe.pointerId !== e.pointerId) return;
        teardown(); // gesture aborted (palm/scroll takeover) → no connect, no ghost wire
      };
      const up = (pe: PointerEvent) => {
        if (pe.pointerId !== e.pointerId) return;
        const wasMoved = moved;
        const px = pe.clientX;
        const py = pe.clientY;
        teardown();
        if (!wasMoved) return; // plain click → the click-click flow owns it
        const portEl = (document.elementFromPoint(px, py) as HTMLElement | null)?.closest?.('.canvas-port') as HTMLElement | null;
        if (!portEl) return;
        const tNode = portEl.getAttribute('data-node-id');
        const tPort = portEl.getAttribute('data-port-id');
        const tSide = portEl.getAttribute('data-port-side');
        // Opposite polarity only; dropping back on a same-side port is a no-op.
        if (!tNode || !tPort || tSide === p.side) return;
        const from = p.side === 'output' ? { nodeId, portId: p.id } : { nodeId: tNode, portId: tPort };
        const to = p.side === 'output' ? { nodeId: tNode, portId: tPort } : { nodeId, portId: p.id };
        // canConnect is the authority (self-node, occupied input, type mismatch).
        if (canConnect(nodesRef.current, edgesRef.current, from, to)) emit(from, to);
      };
      btn.addEventListener('pointermove', move);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', cancel);
      wireTeardownRef.current = teardown;
    },
    [rootRef, emit],
  );

  const wireCount = useCallback(
    (nodeId: string, portId: string, side: PortSide) =>
      side === 'input'
        ? edgesRef.current.filter((e) => e.toNode === nodeId && e.toPort === portId).length
        : edgesRef.current.filter((e) => e.fromNode === nodeId && e.fromPort === portId).length,
    [],
  );

  return {
    pendingPort,
    wireDrag,
    interactive: Boolean(onConnect),
    wireCount,
    clearPending,
    onPortPointerDown,
    onPortClick,
  };
}

const TYPE_LABEL: Record<DataType, CanvasTextKey> = {
  text: 'contract.text', image: 'contract.image', video: 'contract.video', number: 'contract.number', boolean: 'contract.boolean', file: 'contract.file',
};

export interface TilePortsProps {
  node: CanvasNode;
  /** Omitted → handles still render (structure is never hidden) but are inert. */
  wiring?: WiringApi;
}

/**
 * The node's typed port handles, positioned on the tile from the SAME anchor math the wires use
 * (`portAnchorWorld` minus the node origin) so a handle can never sit off the line that leaves it.
 */
export function TilePorts({ node, wiring }: TilePortsProps) {
  const { t } = useCanvasI18n();
  const interactive = wiring?.interactive ?? false;
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const hasContract = node.kind === 'session' && Boolean(node.contract);
  return (
    <>
      {portsFor(node).map((p) => {
        const anchor = portAnchorWorld(node, p.id);
        if (!anchor) return null; // node does not expose this port — draw nothing, invent nothing
        const armed = wiring?.pendingPort?.nodeId === node.id && wiring?.pendingPort?.portId === p.id;
        const wires = wiring?.wireCount(node.id, p.id, p.side) ?? 0;
        // A port that carries wires must LOOK different from an empty one, and a multi input
        // carrying several must say how many — otherwise fan-in is invisible until the prompt
        // comes out wrong.
        const countLabel = p.multi && wires > 1 ? String(wires) : '';
        // Display names belong to the form; stable IDs remain exclusively in the wire payload.
        const sideLabel = t(p.side === 'input' ? 'ports.input' : 'ports.output');
        const typeLabel = t(TYPE_LABEL[p.dataType]);
        const portLabel = hasContract ? p.label?.trim() || t('ports.unnamed', { side: sideLabel }) : p.id;
        const portKey = `${p.side}:${p.id}`;
        const expanded = expandedLabel === portKey;
        return (
          <button
            key={portKey}
            type="button"
            className={`canvas-port canvas-port--${p.side} canvas-port--${p.dataType}${
              interactive ? ' canvas-port--interactive' : ''
            }${armed ? ' is-pending' : ''}${wires > 0 ? ' is-connected' : ''}${
              countLabel ? ' has-count' : ''
            }`}
            style={{ left: anchor.x - node.x, top: anchor.y - node.y }}
            data-wires={wires || undefined}
            title={`${portLabel} · ${typeLabel}${p.multi ? ` · ${t('ports.multi')}` : ''}${wires ? ` · ${t('ports.wireCount', { count: wires })}` : ''}`}
            aria-label={t('ports.port', { side: sideLabel, label: portLabel, type: typeLabel,
              connection: wires ? t('ports.connected', { count: wires }) : t('ports.disconnected') })}
            aria-pressed={armed ? true : undefined}
            data-port-id={p.id}
            data-node-id={node.id}
            data-port-side={p.side}
            data-data-type={p.dataType}
            disabled={!interactive}
            onMouseEnter={() => setExpandedLabel(portKey)}
            onMouseLeave={(event) => {
              if (document.activeElement !== event.currentTarget) setExpandedLabel(null);
            }}
            onFocus={() => setExpandedLabel(portKey)}
            onBlur={() => setExpandedLabel(null)}
            onPointerDown={(e) => wiring?.onPortPointerDown(node.id, p, e)}
            onClick={(e) => wiring?.onPortClick(node.id, p, e)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {hasContract ? <span className="canvas-port-field-label" aria-hidden="true" style={{
              // Absolutely positioned OUTSIDE the handle: no card layout or hit-target changes.
              position: 'absolute', top: '50%', transform: 'translateY(-50%)',
              ...(p.side === 'input' ? { right: 18 } : { left: 18 }),
              maxWidth: expanded ? 220 : 72, width: 'max-content', boxSizing: 'border-box',
              whiteSpace: expanded ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              overflowWrap: 'anywhere', pointerEvents: 'none', textAlign: 'left',
              fontSize: 11, fontWeight: 500, lineHeight: 1.4, padding: '2px 5px', borderRadius: 4,
              color: 'var(--awwo-muted, var(--muted))', background: 'var(--awwo-card, var(--card))',
              border: '1px solid var(--awwo-line, var(--line))',
            }}>{portLabel}</span> : null}
            {countLabel ? <span className="canvas-port-count">{countLabel}</span> : null}
          </button>
        );
      })}
    </>
  );
}
