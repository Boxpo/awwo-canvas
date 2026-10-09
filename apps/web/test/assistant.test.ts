import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphEvent, GraphRunRecord } from '../src/api';
import { exampleDocument } from '../src/examples';
import { PlanFailure, requestPlan } from '../src/useAssistant';
import { reduceRun, runFromRecord, settleOutputs } from '../src/useGraphRun';

const sse = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const emptyPlan = { version: 1, summary: 'ok', operations: [] };
const signal = () => new AbortController().signal;

afterEach(() => { vi.unstubAllGlobals(); });

describe('requestPlan', () => {
  it('retries a malformed plan exactly once, restarting the counts under attempt 2', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(sse([{ type: 'progress', stage: 'streaming', characters: 40, nodes: 1, edges: 0, reasoning: 0 },
        { type: 'error', code: 'invalid_canvas_plan', error: 'bad json' }]))
      .mockResolvedValueOnce(sse([{ type: 'progress', stage: 'streaming', characters: 12, nodes: 0, edges: 0, reasoning: 0 }, { type: 'plan', plan: emptyPlan }]));
    vi.stubGlobal('fetch', fetch);
    const seen: Array<{ stage: string; attempt: number; characters: number }> = [];
    const plan = await requestPlan('do it', 'context', signal(), progress => seen.push(progress));
    expect(plan.summary).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(seen).toContainEqual(expect.objectContaining({ stage: 'retrying', attempt: 2, characters: 0 }));
    expect(seen.at(-1)).toEqual(expect.objectContaining({ stage: 'validating', attempt: 2, characters: 12 }));
  });

  it('never retries a runtime fault', async () => {
    const fetch = vi.fn().mockResolvedValue(sse([{ type: 'error', code: 'runtime_unavailable', error: 'down' }]));
    vi.stubGlobal('fetch', fetch);
    await expect(requestPlan('x', 'c', signal(), () => {})).rejects.toMatchObject({ code: 'runtime_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a client-side schema miss as malformed and reports the FIRST failure when the retry fails too', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(sse([{ type: 'plan', plan: { version: 1, summary: 'x', operations: [{ type: 'explode' }] } }]))
      .mockResolvedValueOnce(sse([{ type: 'error', code: 'model_unavailable', error: 'gone' }]));
    vi.stubGlobal('fetch', fetch);
    const failure = await requestPlan('x', 'c', signal(), () => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanFailure);
    expect((failure as PlanFailure).code).toBe('invalid_canvas_plan');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails a stream that ends without a proposal instead of returning an empty plan', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([{ type: 'progress', stage: 'running' }])));
    await expect(requestPlan('x', 'c', signal(), () => {})).rejects.toMatchObject({ code: 'interrupted' });
  });
});

describe('example canvases', () => {
  it.each(['workflow', 'review', 'team'] as const)('builds the %s example in both languages, every unwired required input filled', id => {
    for (const locale of ['en', 'zh'] as const) {
      const example = exampleDocument(id, locale);
      expect(example.nodes.length).toBeGreaterThan(0);
      const wired = new Set(example.edges.map(edge => `${edge.toNode}|${edge.toPort}`));
      for (const node of example.nodes) {
        if (node.kind !== 'session' || !node.contract) continue;
        for (const field of node.contract.inputs) {
          if (field.required && !wired.has(`${node.id}|in:${field.id}`)) expect(field.value.trim(), `${node.title}.${field.id}`).not.toBe('');
        }
      }
      if (id === 'review') expect(example.execution?.mode).toBe('review');
    }
  });
});

describe('graph run results', () => {
  const base = exampleDocument('workflow', 'en');
  const [goal, make, check] = base.nodes;
  const old = { text: 'old', at: 1, source: 'run' as const };
  const doc = { ...base, nodes: base.nodes.map(node => ({ ...node, lastOutput: old })) };
  const record = (nodes: GraphRunRecord['nodes']): GraphRunRecord =>
    ({ id: 'r1', operationId: 'op', mode: 'workflow', scope: [goal.id], status: 'completed', createdAt: 0, updatedAt: 0, nodes });

  it('stores a fresh output and clears the downstream results derived from the replaced one', () => {
    const settled = settleOutputs(doc, record({ [goal.id]: { state: 'done', output: 'fresh' } }), 5);
    expect(settled.nodes.find(node => node.id === goal.id)?.lastOutput).toEqual({ text: 'fresh', at: 5, source: 'run' });
    expect(settled.nodes.find(node => node.id === make.id)?.lastOutput).toBeNull();
    expect(settled.nodes.find(node => node.id === check.id)?.lastOutput).toBeNull();
  });

  it('keeps a failed node text only as a partial, and leaves the document alone when nothing ran', () => {
    const settled = settleOutputs(doc, record({ [goal.id]: { state: 'failed', output: 'half', detail: 'boom' } }), 7);
    expect(settled.nodes.find(node => node.id === goal.id)?.lastOutput).toEqual({ text: 'half', at: 7, source: 'run', partial: true });
    expect(settleOutputs(doc, record({ [goal.id]: { state: 'blocked', detail: 'missing input' } }))).toBe(doc);
  });

  it('folds events by sequence and restarts live text when a node runs again', () => {
    let state = runFromRecord(record({ [goal.id]: { state: 'waiting' } }));
    const events: GraphEvent[] = [
      { seq: 1, type: 'node', nodeId: goal.id, status: { state: 'running' } },
      { seq: 2, type: 'delta', nodeId: goal.id, delta: 'first' },
      { seq: 3, type: 'node', nodeId: goal.id, status: { state: 'done', output: 'first' } },
      { seq: 4, type: 'round', round: 2 },
      { seq: 5, type: 'node', nodeId: goal.id, status: { state: 'running' } },
    ];
    state = events.reduce(reduceRun, state);
    expect(state.round).toBe(2);
    expect(state.live[goal.id]).toBe('');
    expect(state.nodes[goal.id]).toEqual({ state: 'running' });
  });
});
