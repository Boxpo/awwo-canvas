import { describe, expect, it } from 'vitest';
import { createSessionNode, emptyDocument, sanitizeDocument } from '../src/canvasDoc';

describe('review Graph document schema', () => {
  it('keeps old documents in workflow mode and retains all original sessions', () => {
    const node = createSessionNode('coding', { x: 10, y: 20 });
    const doc = sanitizeDocument({ ...emptyDocument(), nodes: [node] });
    expect(doc.execution).toBeUndefined(); expect(doc.nodes[0]).toMatchObject({ id: node.id, x: 10, y: 20 });
  });

  it('round-trips policy, draft selectors and explicit feedback edges', () => {
    const author = createSessionNode('coding', { x: 0, y: 0 });
    const reviewer = createSessionNode('coding', { x: 400, y: 0 });
    const edge = { id: 'feedback', fromNode: reviewer.id, fromPort: 'result', toNode: author.id, toPort: 'context', dataType: 'text', kind: 'feedback' };
    const policy = { mode: 'review', maxRounds: 3, reviewerNodeId: '', verdictFieldId: '' };
    const doc = sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [author, reviewer], edges: [edge], execution: policy })));
    expect(doc.execution).toEqual(policy); expect(doc.edges).toEqual([edge]);
  });

  it.each([false, 0, 'review', [], { mode: 'unknown', maxRounds: 3 }])('keeps malformed explicit policy %j blocked instead of silently switching execution mode', execution => {
    expect(sanitizeDocument({ ...emptyDocument(), execution }).execution).toEqual({ mode: 'review', maxRounds: 0, reviewerNodeId: '', verdictFieldId: '' });
  });

  it('does not silently increase, decrease or round a saved execution budget', () => {
    for (const maxRounds of [0, 6, 1.5]) {
      expect(sanitizeDocument({ ...emptyDocument(), execution: { mode: 'review', maxRounds, reviewerNodeId: 'r', verdictFieldId: 'approved' } }).execution?.maxRounds).toBe(maxRounds);
    }
  });
});
