import { describe, expect, it } from 'vitest';
import { createFormNode, createSessionNode, emptyDocument, type CanvasDocument, type CanvasEdge, type CanvasNode, type NodeOutput, type SessionNode } from '../src/canvasDoc';
import { invalidateOutputs } from '../src/invalidateOutputs';

function output(text: string, source: NodeOutput['source'] = 'run', at = 1): NodeOutput {
  return { text, source, at };
}

function agent(id: string): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }),
    id, title: id, runtime: 'runtime', model: 'model', effort: 'high', persona: 'Original task',
    binding: { agentId: id, companyId: 'company', agentName: id },
    lastOutput: output(`Old ${id}`),
    contract: { version: 1, inputs: [{ id: 'brief', label: 'Brief', type: 'text', required: true, value: 'Old input' }], outputs: [] },
  };
}

function wire(fromNode: string, toNode: string): CanvasEdge {
  return { id: `${fromNode}-${toNode}`, fromNode, toNode, fromPort: 'result', toPort: 'context', dataType: 'text' };
}

function graph(): CanvasDocument {
  return { ...emptyDocument(), nodes: [agent('a'), agent('b'), agent('c'), agent('independent')], edges: [wire('a', 'b'), wire('b', 'c')] };
}

function changeNode(doc: CanvasDocument, id: string, change: (node: CanvasNode) => CanvasNode): CanvasDocument {
  return { ...doc, nodes: doc.nodes.map((node) => node.id === id ? change(node) : node) };
}

function outputs(doc: CanvasDocument) {
  return Object.fromEntries(doc.nodes.map((node) => [node.id, node.lastOutput?.text ?? null]));
}

describe('execution output invalidation', () => {
  it.each([
    ['title', (node: SessionNode) => ({ ...node, title: 'New task framing' })],
    ['persona', (node: SessionNode) => ({ ...node, persona: 'New task' })],
    ['runtime', (node: SessionNode) => ({ ...node, runtime: 'other' })],
    ['model', (node: SessionNode) => ({ ...node, model: 'other' })],
    ['effort', (node: SessionNode) => ({ ...node, effort: 'low' })],
    ['kind', (node: SessionNode) => ({ ...node, agentKind: 'llm' as const })],
    ['binding', (node: SessionNode) => ({ ...node, binding: { ...node.binding!, agentId: 'other' } })],
    ['conversation', (node: SessionNode) => ({ ...node, issueId: 'other-conversation' })],
    ['contract value', (node: SessionNode) => ({ ...node, contract: { ...node.contract!, inputs: [{ ...node.contract!.inputs[0], value: 'New input' }] } })],
    ['field guidance', (node: SessionNode) => ({ ...node, contract: { ...node.contract!, inputs: [{ ...node.contract!.inputs[0], help: 'Only use confirmed records' }] } })],
    ['contract schema', (node: SessionNode) => ({ ...node, contract: { ...node.contract!, outputs: [{ id: 'new', label: 'New result', type: 'number' as const, required: true, value: '' }] } })],
  ])('clears changed %s and its downstream while preserving unrelated nodes', (_label, change) => {
    const prev = graph();
    const next = changeNode(prev, 'a', (node) => change(node as SessionNode));
    const resolved = invalidateOutputs(prev, next);
    expect(outputs(resolved)).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
    expect(prev.nodes[0].lastOutput?.text).toBe('Old a');
    expect(next.nodes[0].lastOutput?.text).toBe('Old a');
    expect(resolved.nodes[3]).toBe(next.nodes[3]);
  });

  it('clears legacy form results when a field changes', () => {
    const prev = graph();
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'a', lastOutput: output('Old form') };
    prev.nodes[0] = form;
    const next = changeNode(prev, 'a', () => ({ ...form, fields: [{ id: 'f1', label: 'Brief', value: 'New brief' }] }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  it('preserves layout, preview, viewport and semantically cloned configuration changes', () => {
    const prev = graph();
    const next = changeNode(JSON.parse(JSON.stringify(prev)), 'a', (node) => ({ ...node, x: 200, y: 300, w: 500, h: 400, preview: 'Latest chat', bindAttempt: 'unknown' } as SessionNode));
    next.view = { x: 300, y: 200, scale: 1.5 };
    next.updatedAt += 1;
    const resolved = invalidateOutputs(prev, next);
    expect(resolved).toBe(next);
    expect(outputs(resolved)).toEqual({ a: 'Old a', b: 'Old b', c: 'Old c', independent: 'Old independent' });
  });

  it('preserves a newly published manual result and clears downstream even when configuration also changes', () => {
    const prev = graph();
    const fresh = output('Hand picked result', 'manual', 2);
    const next = changeNode(prev, 'a', (node) => ({ ...node, persona: 'Updated task', lastOutput: fresh } as SessionNode));
    const resolved = invalidateOutputs(prev, next);
    expect(outputs(resolved)).toEqual({ a: 'Hand picked result', b: null, c: null, independent: 'Old independent' });
    expect(resolved.nodes[0].lastOutput).toBe(fresh);
  });

  it('clears an old manual result when its task changes without republishing', () => {
    const prev = changeNode(graph(), 'a', (node) => ({ ...node, lastOutput: output('Old manual', 'manual') }));
    const next = changeNode(prev, 'a', (node) => ({ ...node, persona: 'Updated task' } as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  it.each([
    ['completed rerun', output('New run', 'run', 2)],
    ['failed rerun evidence', { ...output('Partial text', 'run', 2), partial: true }],
    ['removed result', null],
  ])('clears downstream after %s', (_label, fresh) => {
    const prev = graph();
    const next = changeNode(prev, 'a', (node) => ({ ...node, lastOutput: fresh }));
    const resolved = invalidateOutputs(prev, next);
    expect(outputs(resolved)).toEqual({ a: fresh?.text ?? null, b: null, c: null, independent: 'Old independent' });
  });

  it.each([
    ['added wire', (edges: CanvasEdge[]) => [...edges, wire('independent', 'b')]],
    ['removed wire', (edges: CanvasEdge[]) => edges.filter((edge) => edge.fromNode !== 'a')],
    ['changed source port', (edges: CanvasEdge[]) => edges.map((edge) => edge.fromNode === 'a' ? { ...edge, fromPort: 'out:other' } : edge)],
    ['changed channel', (edges: CanvasEdge[]) => edges.map((edge) => edge.fromNode === 'a' ? { ...edge, dataType: 'number' as const } : edge)],
  ])('invalidates the receiving node and downstream after an %s', (_label, change) => {
    const prev = graph();
    const next = { ...prev, edges: change(prev.edges) };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'Old a', b: null, c: null, independent: 'Old independent' });
  });

  it('does not invalidate results when edge order or generated identifiers change', () => {
    const prev = graph();
    const next = { ...prev, edges: [...prev.edges].reverse().map((edge) => ({ ...edge, id: `new-${edge.id}` })) };
    expect(invalidateOutputs(prev, next)).toBe(next);
  });

  it('uses the previous graph to clear descendants of a removed node and removed wires', () => {
    const prev = graph();
    const next = { ...prev, nodes: prev.nodes.filter((node) => node.id !== 'a'), edges: [] };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ b: null, c: null, independent: 'Old independent' });
  });

  it('terminates on cycles while preserving explicitly published manual outputs', () => {
    const prev = graph();
    prev.edges.push(wire('c', 'a'));
    const next = changeNode(prev, 'a', (node) => ({ ...node, lastOutput: output('New manual', 'manual', 2) }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'New manual', b: null, c: null, independent: 'Old independent' });
  });

  it('preserves cached upstream and current output when Workflow retains a feedback cycle', () => {
    const prev = graph(); prev.edges.push({ ...wire('c', 'a'), kind: 'feedback' });
    const next = changeNode(prev, 'c', node => ({ ...node, lastOutput: output('Reviewed current result', 'run', 2) }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'Old a', b: 'Old b', c: 'Reviewed current result', independent: 'Old independent' });
    expect(invalidateOutputs(prev, next)).toBe(next);
  });

  it.each(['add', 'remove', 'change'] as const)('ignores %s of an inactive Workflow feedback edge when comparing dependency counts', action => {
    const prev = graph();
    const feedback: CanvasEdge = { ...wire('c', 'a'), kind: 'feedback' };
    if (action !== 'add') prev.edges.push(feedback);
    const next = { ...prev, edges: action === 'add' ? [...prev.edges, feedback]
      : action === 'remove' ? prev.edges.filter(edge => edge.kind !== 'feedback')
        : prev.edges.map(edge => edge.kind === 'feedback' ? { ...edge, toNode: 'independent' } : edge) };
    expect(invalidateOutputs(prev, next)).toBe(next);
  });

  it.each(['publish', 'remove-feedback'] as const)('keeps review feedback invalidation strict after %s', action => {
    const prev = graph(); prev.edges.push({ ...wire('c', 'a'), kind: 'feedback' });
    prev.execution = { mode: 'review', maxRounds: 3, reviewerNodeId: 'c', verdictFieldId: 'approved' };
    const next = action === 'publish' ? changeNode(prev, 'c', node => ({ ...node, lastOutput: output('Unapproved revision', 'run', 2) }))
      : { ...prev, edges: prev.edges.filter(edge => edge.kind !== 'feedback') };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  it.each(['workflow-to-review', 'review-to-workflow'] as const)('invalidates the whole graph when switching %s even with unchanged saved feedback', direction => {
    const prev = graph(); prev.edges.push({ ...wire('c', 'a'), kind: 'feedback' });
    const policy = { mode: 'review' as const, maxRounds: 3, reviewerNodeId: 'c', verdictFieldId: 'approved' };
    if (direction === 'review-to-workflow') prev.execution = policy;
    const next = { ...prev, execution: direction === 'workflow-to-review' ? policy : undefined };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: null });
  });
});


it('invalidates old publications when output structure guidance changes', () => {
  const prev = graph();
  const target = prev.nodes[0] as SessionNode;
  target.contract!.outputs = [{ id: 'result', label: 'Result', type: 'markdown', required: true, value: '', placeholder: 'Summary' }];
  const next = changeNode(prev, 'a', node => ({ ...node, contract: { ...target.contract!, outputs: [{ ...target.contract!.outputs[0], placeholder: 'Summary plus verification evidence' }] } }));
  expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
});
