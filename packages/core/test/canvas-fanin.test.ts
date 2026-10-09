// FAN-IN: several upstreams feeding one node.
//
// This is the shape people actually build — "combine the plan and the brand voice into the
// implementation" — and it is the reason to wire a graph at all rather than type into one chat.
// The run engine was always written for it (runGraph collects every incoming edge, and
// buildNodeMessage labels each upstream by its source), but canConnect refused the second wire,
// so the engine's capability was unreachable from the canvas.
//
// The order the upstream blocks appear in the prompt is part of the product, not an accident:
// it must follow the canvas reading order, never the sequence the wires happened to be drawn in.
import { describe, expect, it } from 'vitest';
import { canConnect, portsFor, reconcileEdges, edgeId } from '../src/ports';
import { buildNodeMessage, runGraph, type RunNodeStatus } from '../src/runGraph';
import {
  createFormNode,
  createSessionNode,
  type CanvasEdge,
  type CanvasNode,
  type SessionNode,
} from '../src/canvasDoc';

function form(id: string, label: string, value: string, at = { x: 0, y: 0 }): CanvasNode {
  return { ...createFormNode(at), id, title: label, fields: [{ id: `${id}-f`, label, value }] };
}

function agent(id: string, title: string, at = { x: 600, y: 0 }): SessionNode {
  return {
    ...createSessionNode('llm', at),
    id,
    title,
    binding: { companyId: 'c1', agentId: `ag-${id}`, agentName: title },
  };
}

function wire(from: CanvasNode, to: CanvasNode, toPort = 'context'): CanvasEdge {
  const ref = { nodeId: from.id, portId: 'data' };
  const target = { nodeId: to.id, portId: toPort };
  return { id: edgeId(ref, target), fromNode: from.id, fromPort: 'data', toNode: to.id, toPort, dataType: 'text' };
}

describe('multi-input ports', () => {
  it('marks context as multi and reference as single', () => {
    const llm = portsFor(agent('a', 'A'));
    expect(llm.find((p) => p.id === 'context')?.multi).toBe(true);

    const img = portsFor({ ...createSessionNode('image', { x: 0, y: 0 }), id: 'i' });
    expect(img.find((p) => p.id === 'context')?.multi).toBe(true);
    expect(img.find((p) => p.id === 'reference')?.multi).toBeFalsy();
  });

  it('accepts a SECOND upstream into context', () => {
    const a = form('f1', '目标', '做一个落地页');
    const b = form('f2', '语气', '克制、专业');
    const target = agent('s1', '实现');
    const nodes = [a, b, target];
    const edges = [wire(a, target)];

    expect(canConnect(nodes, edges, { nodeId: 'f2', portId: 'data' }, { nodeId: 's1', portId: 'context' })).toBe(true);
  });

  it('still refuses a second upstream into a SINGLE input', () => {
    const img = { ...createSessionNode('image', { x: 900, y: 0 }), id: 'img' };
    const a = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'src-a' };
    const b = { ...createSessionNode('image', { x: 0, y: 200 }), id: 'src-b' };
    const nodes = [a, b, img];
    const edges: CanvasEdge[] = [
      { id: 'e1', fromNode: 'src-a', fromPort: 'result', toNode: 'img', toPort: 'reference', dataType: 'image' },
    ];
    expect(
      canConnect(nodes, edges, { nodeId: 'src-b', portId: 'result' }, { nodeId: 'img', portId: 'reference' }),
    ).toBe(false);
  });

  it('refuses re-drawing a wire that already exists', () => {
    const a = form('f1', '目标', 'x');
    const target = agent('s1', '实现');
    const edges = [wire(a, target)];
    expect(canConnect([a, target], edges, { nodeId: 'f1', portId: 'data' }, { nodeId: 's1', portId: 'context' })).toBe(
      false,
    );
  });

  it('keeps every fan-in wire through reconciliation', () => {
    const a = form('f1', '目标', 'x');
    const b = form('f2', '语气', 'y');
    const target = agent('s1', '实现');
    const kept = reconcileEdges([a, b, target], [wire(a, target), wire(b, target)]);
    expect(kept).toHaveLength(2);
    expect(kept.every((e) => e.dataType === 'text')).toBe(true);
  });
});

describe('fan-in execution', () => {
  it('injects EVERY upstream output, in canvas reading order', async () => {
    // Deliberately built out of reading order: the lower node is wired FIRST.
    const low = form('f-low', '约束', '不要用渐变', { x: 0, y: 400 });
    const high = form('f-high', '目标', '做一个落地页', { x: 0, y: 0 });
    const mid = form('f-mid', '语气', '克制、专业', { x: 300, y: 200 });
    const target = agent('s1', '实现', { x: 900, y: 200 });

    const messages: string[] = [];
    const summary = await runGraph({
      nodes: [low, high, mid, target],
      edges: [wire(low, target), wire(high, target), wire(mid, target)],
      execAgent: async (_n, message) => {
        messages.push(message);
        return { ok: true, output: '完成', detail: '已完成' };
      },
      onStatus: () => {},
    });

    expect(summary).toMatchObject({ ok: true, done: 4, failed: 0, blocked: 0 });
    expect(messages).toHaveLength(1);
    const msg = messages[0];

    // All three upstreams present...
    expect(msg).toContain('做一个落地页');
    expect(msg).toContain('克制、专业');
    expect(msg).toContain('不要用渐变');
    // ...and ordered top-to-bottom by where their source sits, NOT by wiring order.
    expect(msg.indexOf('目标')).toBeLessThan(msg.indexOf('语气'));
    expect(msg.indexOf('语气')).toBeLessThan(msg.indexOf('约束'));
  });

  it('blocks the downstream when ANY of several upstreams fails', async () => {
    const good = form('f-ok', '目标', 'x', { x: 0, y: 0 });
    const upstreamAgent = agent('s-up', '会失败', { x: 300, y: 200 });
    const target = agent('s1', '实现', { x: 900, y: 100 });

    const statuses: Record<string, RunNodeStatus[]> = {};
    const summary = await runGraph({
      nodes: [good, upstreamAgent, target],
      edges: [
        wire(good, target),
        {
          id: 'e-up',
          fromNode: 's-up',
          fromPort: 'result',
          toNode: 's1',
          toPort: 'context',
          dataType: 'text',
        },
      ],
      execAgent: async (n) =>
        n.id === 's-up'
          ? { ok: false, output: '', detail: '上游炸了' }
          : { ok: true, output: 'ok', detail: '已完成' },
      onStatus: (id, st) => {
        (statuses[id] ??= []).push(st);
      },
    });

    expect(summary.ok).toBe(false);
    const last = statuses['s1'].at(-1)!;
    expect(last.state).toBe('blocked');
    expect(last.detail).toContain('上游');
  });

  it('a message with several upstreams keeps the with-upstream instruction', () => {
    const msg = buildNodeMessage(agent('s1', '实现'), [
      { fromTitle: '目标', toPort: 'context', output: 'A' },
      { fromTitle: '语气', toPort: 'context', output: 'B' },
    ]);
    expect(msg).toContain('来自「目标」');
    expect(msg).toContain('来自「语气」');
    expect(msg).toContain('请基于以上前置输入');
    expect(msg).not.toContain('没有上游输入');
  });
});
