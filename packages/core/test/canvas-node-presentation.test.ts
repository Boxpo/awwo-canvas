import { expect, it } from 'vitest';
import { createFormNode, type CanvasEdge, type CanvasNode, type SessionNode } from '../src/canvasDoc';
import { createAgentTemplate } from '../src/agentTemplates';
import { DELIVERY_DRAWER_WIDTH, FOCUSED_SESSION_MIN_SIZE, arrangeNodePositions, presentationNodes } from '../src/nodePresentation';
import { canConnect, edgeBezierPath, portAnchorWorld, portsFor } from '../src/ports';

function session(): SessionNode {
  return { ...createAgentTemplate('data', { x: 80, y: 120 }), w: 940, h: 660,
    binding: { companyId: 'company', agentId: 'real-agent', agentName: 'Data agent' },
    issueId: 'real-server-thread', preview: 'Latest reply', activeThreadId: 'local-thread',
    threads: [{ id: 'local-thread', title: 'Session 1', issueId: 'real-server-thread', preview: 'Latest reply', draft: 'Unsent message', createdAt: 42 }],
    lastOutput: { text: 'Actual delivery', at: 99, source: 'run' }, deliverablesOpen: true,
  };
}

it('compacts session geometry without mutating persisted workspace dimensions or metadata', () => {
  const node = session();
  const snapshot = structuredClone(node);
  Object.freeze(node);
  const nodes = Object.freeze([node]);
  const [compact] = presentationNodes(nodes, null);
  expect(compact).toMatchObject({ x: 80, y: 120, w: 260, h: 128 });
  expect({ ...compact, w: node.w, h: node.h }).toEqual(snapshot);
  expect(node).toEqual(snapshot);
  expect((compact as SessionNode).contract).toBe(node.contract);
  expect((compact as SessionNode).threads).toBe(node.threads);
  expect(compact.lastOutput).toBe(node.lastOutput);
  // The saved 940px width already exceeds the slim focused minimum plus its drawer (520 + 320).
  expect(presentationNodes(nodes, node.id)[0]).toMatchObject({ w: 940, h: node.h });
});

it('uses the slim focused geometry that fits a laptop stage with both rails open', () => {
  expect(FOCUSED_SESSION_MIN_SIZE).toEqual({ w: 520, h: 380 });
  expect(DELIVERY_DRAWER_WIDTH).toBe(320);
});

it('expands only the focused session and preserves form node geometry and identity', () => {
  const first = { ...session(), id: 'first', w: 300, h: 200, deliverablesOpen: false };
  const other = { ...session(), id: 'other' };
  const form = createFormNode({ x: 500, y: 100 });
  const rendered = presentationNodes([first, other, form], first.id);
  expect(rendered[0]).toMatchObject({ w: 520, h: 380, x: first.x, y: first.y });
  expect(rendered[1]).toMatchObject({ w: 260, h: 128 });
  expect(rendered[2]).toBe(form);
  expect(first).toMatchObject({ w: 300, h: 200 });
});

it('reserves drawer space only as a focused minimum without adding it again to saved expanded width', () => {
  const small = { ...session(), w: 520, h: 380 };
  expect(presentationNodes([small], small.id)[0]).toMatchObject({ w: 840, h: 380 });
  const large = { ...small, w: 1040, h: 720 };
  expect(presentationNodes([large], large.id)[0]).toMatchObject({ w: 1040, h: 720 });
  expect(presentationNodes([large], null)[0]).toMatchObject({ w: 260, h: 128 });
});

it('projects a narrow focused node to the available mobile stage without changing the saved size', () => {
  const original = { ...session(), w: 940, h: 380, deliverablesOpen: true };
  expect(presentationNodes([original], original.id, 334)[0]).toMatchObject({ w: 334, h: 380 });
  expect(original.w).toBe(940);
});

it('anchors real contract ports to the projected card geometry while keeping connection rules unchanged', () => {
  const source = session();
  const target = createAgentTemplate('backend', { x: 600, y: 120 });
  const [compactSource, compactTarget] = presentationNodes([source, target], null);
  expect(portsFor(compactSource)).toEqual(portsFor(source));
  const from = portAnchorWorld(compactSource, 'out:schema')!;
  const to = portAnchorWorld(compactTarget, 'in:schema')!;
  const expandedFrom = portAnchorWorld(source, 'out:schema')!;
  const expandedTo = portAnchorWorld(target, 'in:schema')!;
  expect(from.x).toBe(340);
  expect(to.x).toBe(600);
  expect((from.y - compactSource.y) / compactSource.h).toBeCloseTo((expandedFrom.y - source.y) / source.h);
  expect((to.y - compactTarget.y) / compactTarget.h).toBeCloseTo((expandedTo.y - target.y) / target.h);
  const path = edgeBezierPath(from, to);
  expect(path.startsWith(`M ${from.x} ${from.y} C `)).toBe(true);
  expect(path.endsWith(`, ${to.x} ${to.y}`)).toBe(true);
  const outputAnchors = portsFor(compactSource).filter(port => port.side === 'output')
    .map(port => portAnchorWorld(compactSource, port.id)!);
  expect(new Set(outputAnchors.map(anchor => anchor.y)).size).toBe(source.contract!.outputs.length);
  expect(outputAnchors.every(anchor => anchor.x === 340 && anchor.y > 120 && anchor.y < 248)).toBe(true);
  expect(canConnect([compactSource, compactTarget], [], { nodeId: source.id, portId: 'out:schema' }, { nodeId: target.id, portId: 'in:schema' })).toBe(true);
  expect(expandedFrom.x).toBe(1020);
});

it('handles an empty canvas and a focus ID that no longer exists', () => {
  expect(presentationNodes([], null)).toEqual([]);
  const nodes: CanvasNode[] = [session()];
  expect(presentationNodes(nodes, 'deleted-node')[0]).toMatchObject({ w: 260, h: 128 });
});

function edge(fromNode: string, toNode: string): CanvasEdge {
  return { id: `${fromNode}-${toNode}`, fromNode, toNode, fromPort: 'result', toPort: 'context', dataType: 'text' };
}

it('arranges a DAG by longest dependency path with stable peers, changing only positions', () => {
  const nodes = ['data', 'backend', 'frontend', 'materials', 'review'].map(id => Object.freeze({ ...session(), id }));
  const before = structuredClone(nodes);
  const wires = [edge('data', 'backend'), edge('backend', 'frontend'), edge('materials', 'frontend'), edge('frontend', 'review'), edge('backend', 'review')];
  const arranged = arrangeNodePositions(Object.freeze(nodes), Object.freeze(wires));
  expect(arranged.map(node => [node.id, node.x, node.y])).toEqual([
    ['data', 80, 80], ['backend', 440, 80], ['frontend', 800, 80], ['materials', 80, 276], ['review', 1160, 80],
  ]);
  expect(nodes).toEqual(before);
  arranged.forEach((node, index) => {
    expect({ ...node, x: nodes[index].x, y: nodes[index].y }).toEqual(before[index]);
    expect((node as SessionNode).threads).toBe(nodes[index].threads);
    expect((node as SessionNode).contract).toBe(nodes[index].contract);
  });
  expect(arrangeNodePositions(arranged, wires)).toEqual(arranged);
});

it('uses form geometry to keep compact cards clear of large form rows and columns', () => {
  const form = { ...createFormNode({ x: 900, y: 900 }), id: 'form', w: 640, h: 300 };
  const peer = { ...session(), id: 'peer' };
  const downstream = { ...session(), id: 'downstream' };
  const arranged = arrangeNodePositions([form, peer, downstream], [edge(form.id, downstream.id)]);
  expect(arranged[0]).toMatchObject({ x: 80, y: 80, w: 640, h: 300 });
  expect(arranged[1]).toMatchObject({ x: 80, y: 448 });
  expect(arranged[2]).toMatchObject({ x: 820, y: 80 });
});

it('places cycles and their unresolved descendants in a bounded final column', () => {
  const nodes = ['root', 'cycle-a', 'cycle-b', 'descendant'].map(id => ({ ...session(), id }));
  const wires = [edge('cycle-a', 'cycle-b'), edge('cycle-b', 'cycle-a'), edge('cycle-b', 'descendant')];
  const arranged = arrangeNodePositions(nodes, wires);
  expect(arranged.map(node => [node.x, node.y])).toEqual([[80, 80], [440, 80], [440, 276], [440, 472]]);
  expect(arrangeNodePositions(nodes, [...wires].reverse())).toEqual(arranged);
  expect(arrangeNodePositions([nodes[1]], [edge('cycle-a', 'cycle-a')])[0]).toMatchObject({ x: 80, y: 80 });
});

it('ignores dangling edges and handles duplicate dependencies and an empty graph', () => {
  const nodes = ['first', 'second'].map(id => ({ ...session(), id }));
  const wires = [edge('missing', 'first'), edge('first', 'missing'), edge('first', 'second'), edge('first', 'second')];
  expect(arrangeNodePositions(nodes, wires).map(node => node.x)).toEqual([80, 440]);
  expect(arrangeNodePositions([], wires)).toEqual([]);
});
