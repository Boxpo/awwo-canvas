import type { CanvasEdge, CanvasNode } from './canvasDoc';

export const COMPACT_SESSION_SIZE = { w: 260, h: 128 } as const;
// Slim focused geometry: a focused node plus its delivery drawer has to fit a laptop stage with
// both side rails open. The drawer width is mirrored by .awwo-node-delivery-drawer in awwo-node.css.
export const FOCUSED_SESSION_MIN_SIZE = { w: 520, h: 380 } as const;
export const DELIVERY_DRAWER_WIDTH = 320;

/**
 * Geometry for the current canvas view only. Persisted workspace sizes and session contents
 * remain untouched, so closing a conversation does not resize or discard the user's work.
 * Use these same nodes for cards, port anchors, wires, minimap, selection and viewport fitting.
 */
export function presentationNodes(nodes: ReadonlyArray<CanvasNode>, focusedId: string | null, narrowFocusWidth?: number): CanvasNode[] {
  return nodes.map(node => {
    if (node.kind !== 'session') return node;
    const w = node.id === focusedId
      ? narrowFocusWidth
        ? Math.min(Math.max(280, narrowFocusWidth), Math.max(node.w, FOCUSED_SESSION_MIN_SIZE.w))
        : Math.max(node.w, FOCUSED_SESSION_MIN_SIZE.w + (node.deliverablesOpen ? DELIVERY_DRAWER_WIDTH : 0))
      : COMPACT_SESSION_SIZE.w;
    const h = node.id === focusedId ? Math.max(node.h, FOCUSED_SESSION_MIN_SIZE.h) : COMPACT_SESSION_SIZE.h;
    return node.w === w && node.h === h ? node : { ...node, w, h };
  });
}

/**
 * Each node's step in the graph: its longest path from a node with no inputs. Cycles and their
 * unresolved descendants share one step after every other, so malformed graphs still terminate.
 * Wires to missing nodes and duplicate wires are ignored.
 */
export function nodeDepths(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>): Map<string, number> {
  const ids = new Set(nodes.map(node => node.id));
  const outgoing = new Map(nodes.map(node => [node.id, new Set<string>()]));
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const rank = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    if (!ids.has(edge.fromNode) || !ids.has(edge.toNode)) continue;
    const targets = outgoing.get(edge.fromNode)!;
    if (targets.has(edge.toNode)) continue;
    targets.add(edge.toNode);
    indegree.set(edge.toNode, indegree.get(edge.toNode)! + 1);
  }
  const ready = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  const visited = new Set<string>();
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index];
    visited.add(id);
    for (const target of outgoing.get(id)!) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      const pending = indegree.get(target)! - 1;
      indegree.set(target, pending);
      if (pending === 0) ready.push(target);
    }
  }
  const fallbackRank = ready.reduce((max, id) => Math.max(max, rank.get(id)!), -1) + 1;
  return new Map(nodes.map(node => [node.id, visited.has(node.id) ? rank.get(node.id)! : fallbackRank]));
}

/**
 * Explicit, reversible graph layout. Longest-path layers (nodeDepths) keep every DAG dependency
 * moving right; stable source order keeps peers predictable. Only positions change. Sessions are
 * laid out at their compact presentation size; forms use their actual dimensions, which can
 * enlarge column and row spacing.
 */
export function arrangeNodePositions(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>): CanvasNode[] {
  const depths = nodeDepths(nodes, edges);
  const layers = new Map<number, CanvasNode[]>();
  for (const node of nodes) {
    const layer = depths.get(node.id)!;
    const peers = layers.get(layer) || [];
    peers.push(node);
    layers.set(layer, peers);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let x = 80;
  for (const [, peers] of [...layers.entries()].sort(([left], [right]) => left - right)) {
    let y = 80;
    let columnWidth: number = COMPACT_SESSION_SIZE.w;
    for (const node of peers) {
      positions.set(node.id, { x, y });
      const width = node.kind === 'form' ? node.w : COMPACT_SESSION_SIZE.w;
      const height = node.kind === 'form' ? node.h : COMPACT_SESSION_SIZE.h;
      columnWidth = Math.max(columnWidth, width);
      y += Math.max(COMPACT_SESSION_SIZE.h, height) + 68;
    }
    x += columnWidth + 100;
  }
  return nodes.map(node => {
    const position = positions.get(node.id)!;
    return node.x === position.x && node.y === position.y ? node : { ...node, ...position };
  });
}
