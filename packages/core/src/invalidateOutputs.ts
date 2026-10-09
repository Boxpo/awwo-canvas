import type { CanvasDocument, CanvasEdge, CanvasNode, NodeOutput } from './canvasDoc';
import type { ContractField } from './nodeContracts';
import { nodeTeamFingerprint } from './nodeTeam';
import { taskFrameFingerprint } from './taskFrame';

function fieldKey(field: ContractField, output = false): unknown[] {
  return [field.id, field.label, field.type, field.required, field.value, field.help?.trim() || '', output ? field.placeholder?.trim() || '' : ''];
}

/** Only fields that shape execution or its prompt belong here; layout and previews do not. */
function executionKey(node: CanvasNode): string {
  if (node.kind === 'form') {
    return JSON.stringify([node.kind, node.title, node.fields.map((field) => [field.id, field.label, field.value])]);
  }
  const binding = node.binding ? [node.binding.companyId, node.binding.agentId, node.binding.agentName] : null;
  const contract = node.contract
    ? [node.contract.version, node.contract.inputs.map(field => fieldKey(field)), node.contract.outputs.map(field => fieldKey(field, true))]
    : null;
  return JSON.stringify([
    node.kind, node.title, node.agentKind, node.runtime, node.model, node.effort,
    node.persona, binding, node.issueId, node.activeThreadId || 'default', contract, nodeTeamFingerprint(node.team), node.agentRef ?? null, taskFrameFingerprint(node.taskFrame),
  ]);
}

function outputKey(output: NodeOutput | null | undefined): string {
  return JSON.stringify(output ? [output.text, output.source, output.at, output.partial === true] : null);
}

/** Saved feedback is inactive in Workflow, so it cannot invalidate same-turn outputs. */
function executionEdges(doc: CanvasDocument): CanvasEdge[] {
  return doc.edges.filter(edge => edge.kind !== 'feedback' || doc.execution?.mode === 'review');
}

/** Multiplicity matters to prompt input, while storage ids and wire-list order do not. */
function edgeCounts(edges: ReadonlyArray<CanvasEdge>): Map<string, { count: number; toNode: string }> {
  const counts = new Map<string, { count: number; toNode: string }>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.fromNode, edge.fromPort, edge.toNode, edge.toPort, edge.dataType, edge.kind ?? 'data']);
    counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, toNode: edge.toNode });
  }
  return counts;
}

/**
 * Clear stale results after a document mutation, without mutating either document.
 *
 * Config edits invalidate the node and its descendants. Output replacements (manual or run,
 * including partial/removed output) invalidate descendants. Wire edits start at the receiving
 * node. Traversal includes both graphs, so deletion cannot hide an old dependency. An explicit
 * new manual publication is retained even when a simultaneous edit would invalidate that node.
 * The caller validates manual publications before applying this freshness policy.
 *
 * A case recording (`source: 'case'`) is a copied case's delivery, kept for reference rather than
 * produced by this node's settings, so settings, wires and structure leave it in place; only a
 * replaced upstream output, on which it no longer stands, clears it.
 */
export function invalidateOutputs(prev: CanvasDocument, next: CanvasDocument): CanvasDocument {
  const before = new Map(prev.nodes.map((node) => [node.id, node]));
  const after = new Map(next.nodes.map((node) => [node.id, node]));
  const previousEdges = executionEdges(prev);
  const nextEdges = executionEdges(next);
  const downstream = new Map<string, Set<string>>();
  for (const edge of [...previousEdges, ...nextEdges]) {
    const targets = downstream.get(edge.fromNode) ?? new Set<string>();
    targets.add(edge.toNode);
    downstream.set(edge.fromNode, targets);
  }

  const invalid = new Set<string>();
  // Downstream of a replaced output: the only staleness a case recording has.
  const replaced = new Set<string>();
  if (JSON.stringify(prev.execution) !== JSON.stringify(next.execution)) next.nodes.forEach(node => invalid.add(node.id));
  const published = new Set<string>();
  for (const node of prev.nodes) {
    if (!after.has(node.id)) invalid.add(node.id);
  }
  for (const node of next.nodes) {
    const old = before.get(node.id);
    if (old && executionKey(old) !== executionKey(node)) invalid.add(node.id);
    if (outputKey(old?.lastOutput) !== outputKey(node.lastOutput)) {
      if (node.lastOutput?.source === 'manual') published.add(node.id);
      for (const id of downstream.get(node.id) ?? []) { invalid.add(id); replaced.add(id); }
    }
  }

  const oldEdges = edgeCounts(previousEdges);
  const newEdges = edgeCounts(nextEdges);
  for (const key of new Set([...oldEdges.keys(), ...newEdges.keys()])) {
    const old = oldEdges.get(key);
    const current = newEdges.get(key);
    if (old?.count !== current?.count) invalid.add((current ?? old)!.toNode);
  }

  for (const marked of [invalid, replaced]) {
    const queue = [...marked];
    for (let i = 0; i < queue.length; i += 1) {
      for (const id of downstream.get(queue[i]) ?? []) {
        if (marked.has(id)) continue;
        marked.add(id);
        invalid.add(id);
        queue.push(id);
      }
    }
  }
  let changed = false;
  const nodes = next.nodes.map((node) => {
    if (!invalid.has(node.id) || published.has(node.id) || node.lastOutput == null) return node;
    if (node.lastOutput.source === 'case' && !replaced.has(node.id)) return node;
    changed = true;
    return { ...node, lastOutput: null };
  });
  return changed ? { ...next, nodes } : next;
}
