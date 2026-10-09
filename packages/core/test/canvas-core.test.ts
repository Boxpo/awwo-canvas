// Canvas logic core: typed ports + wiring rules, document persistence (fail-soft + honest
// status + legacy migration), zoom-driven level of detail, and spatial navigation.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANVAS_BACKUP_KEY,
  CANVAS_STORAGE_KEY,
  LEGACY_WORKFLOW_STORAGE_KEY,
  createFormNode,
  createSessionNode,
  emptyDocument,
  loadDocument,
  loadDocumentWithStatus,
  migrateFromLegacy,
  sanitizeDocument,
  saveDocument,
  type CanvasEdge,
  type SessionNode,
} from '../src/canvasDoc';
import {
  arePortTypesCompatible,
  boundsOfNodes,
  canConnect,
  edgeBezierPath,
  edgeId,
  portAnchorWorld,
  portsFor,
  reconcileEdges,
} from '../src/ports';
import { configureCanvasStorage } from '../src/storage';
import { LOD_CARD_MAX_PX, LOD_GLANCE_MAX_PX, TAIL_LINES, lodFor } from '../src/lod';
import { hitTestRect, nextIn, orderNodes } from '../src/spatialOrder';

function wire(from: { id: string }, fromPort: string, to: { id: string }, toPort: string, dataType: 'text' | 'image'): CanvasEdge {
  return { id: `${from.id}:${fromPort}->${to.id}:${toPort}`, fromNode: from.id, fromPort, toNode: to.id, toPort, dataType };
}

describe('ports: typed port derivation', () => {
  it('gives a form node one text output', () => {
    expect(portsFor(createFormNode({ x: 0, y: 0 }))).toEqual([{ id: 'data', side: 'output', dataType: 'text' }]);
  });

  it('gives llm and coding sessions a text context input and a text result output', () => {
    for (const kind of ['llm', 'coding'] as const) {
      const ports = portsFor(createSessionNode(kind, { x: 0, y: 0 }));
      expect(ports).toEqual([
        { id: 'context', side: 'input', dataType: 'text', multi: true },
        { id: 'result', side: 'output', dataType: 'text' },
      ]);
    }
  });

  it('gives an image session an extra image reference input and an image result output', () => {
    const ports = portsFor(createSessionNode('image', { x: 0, y: 0 }));
    expect(ports).toEqual([
      // context is MULTI (combine several sources); reference is one picture, so single.
      { id: 'context', side: 'input', dataType: 'text', multi: true },
      { id: 'reference', side: 'input', dataType: 'image' },
      { id: 'result', side: 'output', dataType: 'image' },
    ]);
  });

  it('anchors inputs on the left edge and outputs on the right, spread down the box', () => {
    const image = createSessionNode('image', { x: 100, y: 200 });
    const context = portAnchorWorld(image, 'context');
    const reference = portAnchorWorld(image, 'reference');
    const result = portAnchorWorld(image, 'result');
    expect(context).toEqual({ x: 100, y: 200 + image.h / 3 });
    expect(reference).toEqual({ x: 100, y: 200 + (image.h * 2) / 3 });
    expect(result).toEqual({ x: 100 + image.w, y: 200 + image.h / 2 });
  });

  it('returns null for a port the node does not expose (never an invented anchor)', () => {
    const llm = createSessionNode('llm', { x: 0, y: 0 });
    expect(portAnchorWorld(llm, 'reference')).toBeNull();
  });

  it('exact type matching only', () => {
    expect(arePortTypesCompatible('text', 'text')).toBe(true);
    expect(arePortTypesCompatible('image', 'image')).toBe(true);
    expect(arePortTypesCompatible('text', 'image')).toBe(false);
  });

  it('bounds and edge helpers stay world-space and origin-agnostic', () => {
    const a = { ...createFormNode({ x: 0, y: 0 }), w: 100, h: 50 };
    const b = { ...createFormNode({ x: 200, y: 100 }), w: 100, h: 50 };
    expect(boundsOfNodes([a, b])).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 150 });
    expect(edgeId({ nodeId: 'n1', portId: 'result' }, { nodeId: 'n2', portId: 'context' })).toBe('n1:result->n2:context');
    expect(edgeBezierPath({ x: 0, y: 0 }, { x: 100, y: 40 })).toBe('M 0 0 C 50 0, 50 40, 100 40');
  });
});

describe('ports: canConnect', () => {
  it('accepts output → input with matching types', () => {
    const form = createFormNode({ x: 0, y: 0 });
    const llm = createSessionNode('llm', { x: 400, y: 0 });
    expect(canConnect([form, llm], [], { nodeId: form.id, portId: 'data' }, { nodeId: llm.id, portId: 'context' })).toBe(true);
  });

  it('rejects a reversed direction (input as source, output as target)', () => {
    const form = createFormNode({ x: 0, y: 0 });
    const llm = createSessionNode('llm', { x: 400, y: 0 });
    expect(canConnect([form, llm], [], { nodeId: llm.id, portId: 'context' }, { nodeId: form.id, portId: 'data' })).toBe(false);
    expect(canConnect([form, llm], [], { nodeId: form.id, portId: 'data' }, { nodeId: llm.id, portId: 'result' })).toBe(false);
  });

  it('rejects a self-loop', () => {
    const llm = createSessionNode('llm', { x: 0, y: 0 });
    expect(canConnect([llm], [], { nodeId: llm.id, portId: 'result' }, { nodeId: llm.id, portId: 'context' })).toBe(false);
  });

  it('rejects a type mismatch', () => {
    const form = createFormNode({ x: 0, y: 0 });
    const image = createSessionNode('image', { x: 400, y: 0 });
    // form emits text; 'reference' wants image
    expect(canConnect([form, image], [], { nodeId: form.id, portId: 'data' }, { nodeId: image.id, portId: 'reference' })).toBe(false);
  });

  it('accepts a second upstream on a MULTI input, and the same output may feed several nodes', () => {
    // context is multi on purpose: combining sources is the reason to wire a graph at all.
    // (Full fan-in coverage, including prompt ordering, lives in canvas-fanin.test.ts.)
    const formA = createFormNode({ x: 0, y: 0 });
    const formB = createFormNode({ x: 0, y: 300 });
    const llm = createSessionNode('llm', { x: 400, y: 0 });
    const edges = [wire(formA, 'data', llm, 'context', 'text')];
    expect(canConnect([formA, formB, llm], edges, { nodeId: formB.id, portId: 'data' }, { nodeId: llm.id, portId: 'context' })).toBe(true);
    const other = createSessionNode('coding', { x: 800, y: 0 });
    expect(canConnect([formA, llm, other], edges, { nodeId: formA.id, portId: 'data' }, { nodeId: other.id, portId: 'context' })).toBe(true);
    // The SAME wire twice is still refused — re-dropping on a connected port is a no-op, not a dupe.
    expect(canConnect([formA, llm], edges, { nodeId: formA.id, portId: 'data' }, { nodeId: llm.id, portId: 'context' })).toBe(false);
  });

  it('still rejects a second upstream on a SINGLE input (an image reference is one picture)', () => {
    const srcA = createSessionNode('image', { x: 0, y: 0 });
    const srcB = createSessionNode('image', { x: 0, y: 300 });
    const target = createSessionNode('image', { x: 600, y: 0 });
    const edges = [wire(srcA, 'result', target, 'reference', 'image')];
    expect(canConnect([srcA, srcB, target], edges, { nodeId: srcB.id, portId: 'result' }, { nodeId: target.id, portId: 'reference' })).toBe(false);
  });

  it('rejects unknown nodes and unknown ports', () => {
    const form = createFormNode({ x: 0, y: 0 });
    const llm = createSessionNode('llm', { x: 400, y: 0 });
    expect(canConnect([form, llm], [], { nodeId: 'ghost', portId: 'data' }, { nodeId: llm.id, portId: 'context' })).toBe(false);
    expect(canConnect([form, llm], [], { nodeId: form.id, portId: 'data' }, { nodeId: llm.id, portId: 'reference' })).toBe(false);
  });
});

describe('ports: reconcileEdges', () => {
  it('re-derives dataType from the real source port (never trusts the stored value)', () => {
    const form = createFormNode({ x: 0, y: 0 });
    const coding = createSessionNode('coding', { x: 400, y: 0 });
    const out = reconcileEdges([form, coding], [
      { ...wire(form, 'data', coding, 'context', 'text'), dataType: 'image' as const },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dataType).toBe('text');
  });

  it('drops an edge whose port vanished after an agentKind switch', () => {
    const form = createFormNode({ x: 0, y: 0 });
    const image = createSessionNode('image', { x: 400, y: 0 });
    const upstream = createSessionNode('image', { x: 0, y: 400 });
    const edges = [
      wire(form, 'data', image, 'context', 'text'),
      // 'reference' is an image-typed input that ONLY image sessions have
      wire(upstream, 'result', image, 'reference', 'image'),
    ];
    expect(reconcileEdges([form, image, upstream], edges).map((e) => e.id)).toEqual(edges.map((e) => e.id));

    const asLlm: SessionNode = { ...image, agentKind: 'llm' };
    const out = reconcileEdges([form, asLlm, upstream], edges);
    expect(out.map((e) => e.id)).toEqual([edges[0].id]);
  });

  it('drops type-mismatched edges and edges to nodes that are gone', () => {
    const form = createFormNode({ x: 0, y: 0 });
    const image = createSessionNode('image', { x: 400, y: 0 });
    expect(reconcileEdges([form, image], [wire(form, 'data', image, 'reference', 'text')])).toEqual([]);
    expect(reconcileEdges([form], [wire(form, 'data', image, 'context', 'text')])).toEqual([]);
  });
});

describe('canvasDoc: creation defaults', () => {
  beforeEach(() => localStorage.clear());

  it('creates session nodes of each kind unbound, with nothing back-filled', () => {
    for (const kind of ['llm', 'coding', 'image'] as const) {
      const node = createSessionNode(kind, { x: 3, y: 4 });
      expect(node.kind).toBe('session');
      expect(node.agentKind).toBe(kind);
      expect(node.x).toBe(3);
      expect(node.y).toBe(4);
      expect(node.w).toBeGreaterThan(0);
      expect(node.h).toBeGreaterThan(0);
      expect(node.binding).toBeNull();
      expect(node.bindAttempt).toBeNull();
      expect(node.issueId).toBeNull();
      expect(node.preview).toBe('');
      // fail-closed: runtime/model/effort come from the server contract, never from here
      expect(node.runtime).toBe('');
      expect(node.model).toBe('');
      expect(node.effort).toBe('');
    }
  });

  it('creates a form node with editable seed fields', () => {
    const form = createFormNode({ x: 10, y: 20 });
    expect(form.kind).toBe('form');
    expect(form.fields.length).toBeGreaterThan(0);
  });

  it('mints unique node ids', () => {
    const ids = new Set([
      ...Array.from({ length: 40 }, () => createSessionNode('llm', { x: 0, y: 0 }).id),
      ...Array.from({ length: 40 }, () => createFormNode({ x: 0, y: 0 }).id),
    ]);
    expect(ids.size).toBe(80);
  });
});

describe('canvasDoc: sanitize', () => {
  beforeEach(() => localStorage.clear());

  it('drops malformed nodes and dangling edges, and coerces a bad agentKind', () => {
    const good = createSessionNode('llm', { x: 0, y: 0 });
    const doc = sanitizeDocument({
      nodes: [
        good,
        { kind: 'session', id: 'weird', x: 0, y: 0, title: 't', agentKind: 'quantum' },
        { kind: 'mystery', id: 'm1' },
        null,
        'nope',
        { kind: 'form' }, // no id → dropped
      ],
      edges: [
        { id: 'e1', fromNode: good.id, fromPort: 'result', toNode: 'weird', toPort: 'context', dataType: 'text' },
        { id: 'e2', fromNode: good.id, fromPort: 'result', toNode: 'ghost', toPort: 'context', dataType: 'text' },
        { id: '', fromNode: good.id, fromPort: 'result', toNode: 'weird', toPort: 'context', dataType: 'text' },
      ],
    });
    expect(doc.nodes.map((n) => n.id).sort()).toEqual([good.id, 'weird'].sort());
    const coerced = doc.nodes.find((n) => n.id === 'weird') as SessionNode;
    expect(coerced.agentKind).toBe('llm');
    expect(coerced.w).toBeGreaterThan(0);
    expect(coerced.h).toBeGreaterThan(0);
    // e1 survives (both endpoints and both ports exist); e2 dangles; the id-less edge is dropped.
    expect(doc.edges.map((e) => e.id)).toEqual(['e1']);
    expect(doc.version).toBe(2);
  });

  it('drops a surviving edge whose ports no longer type-match (reconciled on load)', () => {
    const form = createFormNode({ x: 0, y: 0 });
    const image = createSessionNode('image', { x: 400, y: 0 });
    const doc = sanitizeDocument({
      nodes: [form, image],
      edges: [wire(form, 'data', image, 'reference', 'text')],
    });
    expect(doc.edges).toEqual([]);
  });

  it('keeps a binding only when it names a real agent', () => {
    const doc = sanitizeDocument({
      nodes: [
        { kind: 'session', id: 'a', x: 0, y: 0, title: 't', agentKind: 'llm', binding: { companyId: 'c' } },
        { kind: 'session', id: 'b', x: 0, y: 0, title: 't', agentKind: 'llm', binding: { companyId: 'c', agentId: 'x' } },
      ],
      edges: [],
    });
    const [a, b] = doc.nodes as SessionNode[];
    expect(a.binding).toBeNull();
    expect(b.binding).toMatchObject({ companyId: 'c', agentId: 'x', agentName: 'agent' });
  });

  it('keeps bindAttempt only when it is literally "unknown"', () => {
    const doc = sanitizeDocument({
      nodes: [
        { kind: 'session', id: 'a', x: 0, y: 0, agentKind: 'llm', bindAttempt: 'unknown' },
        { kind: 'session', id: 'b', x: 0, y: 0, agentKind: 'llm', bindAttempt: 'created' },
        { kind: 'session', id: 'c', x: 0, y: 0, agentKind: 'llm' },
      ],
      edges: [],
    });
    const [a, b, c] = doc.nodes as SessionNode[];
    expect(a.bindAttempt).toBe('unknown');
    expect(b.bindAttempt).toBeNull();
    expect(c.bindAttempt).toBeNull();
  });

  it('clamps waypoint slots into 1-9 and drops ones without a usable viewport', () => {
    const view = { x: 1, y: 2, scale: 0.5 };
    const doc = sanitizeDocument({
      nodes: [],
      edges: [],
      waypoints: [
        { slot: 0, view },
        { slot: 42, view, label: 'far' },
        { slot: 3, view: { x: 0, y: 0, scale: 0 } },
        { slot: 4, view: 'nope' },
        null,
      ],
    });
    expect(doc.waypoints.map((w) => w.slot)).toEqual([1, 9]);
    expect(doc.waypoints[1].label).toBe('far');
  });

  it('keeps a valid saved viewport and rejects a broken one', () => {
    expect(sanitizeDocument({ nodes: [], edges: [], view: { x: 5, y: 6, scale: 1.5 } }).view).toEqual({ x: 5, y: 6, scale: 1.5 });
    expect(sanitizeDocument({ nodes: [], edges: [], view: { x: 5, y: 6, scale: Number.NaN } }).view).toBeNull();
    expect(sanitizeDocument({ nodes: [], edges: [] }).view).toBeNull();
  });
});

describe('canvasDoc: persistence', () => {
  beforeEach(() => localStorage.clear());

  // Upstream observed this through AwwO's cloud-autosaver broadcast, which this edition does not
  // have; the invariant itself — an identical document is not written twice — is checked directly.
  it('does not write a second time for an identical saved document', () => {
    const document = { ...emptyDocument(), updatedAt: 123 };
    const writes: string[] = [];
    configureCanvasStorage({
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => { writes.push(key); localStorage.setItem(key, value); },
      removeItem: key => localStorage.removeItem(key),
      keys: () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!),
    });
    try {
      expect(saveDocument(document)).toBe(true);
      expect(saveDocument(document)).toBe(true);
      expect(writes).toHaveLength(1);
      expect(saveDocument({ ...document, updatedAt: 124 })).toBe(true);
      expect(writes).toHaveLength(2);
    } finally {
      configureCanvasStorage(null);
    }
  });

  it('first run with neither key is an EMPTY canvas (nothing seeded)', () => {
    const { doc, status } = loadDocumentWithStatus();
    expect(status).toBe('empty');
    expect(doc.nodes).toEqual([]);
    expect(doc.edges).toEqual([]);
    expect(doc.waypoints).toEqual([]);
    expect(doc.view).toBeNull();
  });

  it('round-trips a session tile including issueId, preview and bindAttempt', () => {
    const form = createFormNode({ x: 1, y: 2 });
    const session: SessionNode = {
      ...createSessionNode('coding', { x: 5, y: 6 }),
      runtime: 'claude_local',
      model: 'claude-sonnet-5',
      effort: 'high',
      persona: '资深前端工程师',
      binding: { companyId: 'c1', agentId: 'a1', agentName: '前端实现' },
      bindAttempt: 'unknown',
      issueId: 'issue-77',
      preview: '最后一行输出',
    };
    saveDocument({
      version: 2,
      updatedAt: 123,
      nodes: [form, session],
      edges: [wire(form, 'data', session, 'context', 'text')],
      waypoints: [{ slot: 2, view: { x: 10, y: 20, scale: 0.8 } }],
      view: { x: 3, y: 4, scale: 1.2 },
    });
    const loaded = loadDocument();
    const back = loaded.nodes.find((n) => n.kind === 'session') as SessionNode;
    expect(back.runtime).toBe('claude_local');
    expect(back.effort).toBe('high');
    expect(back.binding).toEqual({ companyId: 'c1', agentId: 'a1', agentName: '前端实现' });
    // The unknown-outcome warning must survive reloads: a blind retry could hire a duplicate.
    expect(back.bindAttempt).toBe('unknown');
    expect(back.issueId).toBe('issue-77');
    expect(back.preview).toBe('最后一行输出');
    expect(loaded.edges).toHaveLength(1);
    expect(loaded.waypoints).toEqual([{ slot: 2, view: { x: 10, y: 20, scale: 0.8 } }]);
    expect(loaded.view).toEqual({ x: 3, y: 4, scale: 1.2 });
    expect(loadDocumentWithStatus().status).toBe('ok');
  });

  it('preserves a corrupt payload to the backup key BEFORE anything can overwrite it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      localStorage.setItem(CANVAS_STORAGE_KEY, '{definitely not json');
      const { doc, status } = loadDocumentWithStatus();
      expect(status).toBe('corrupt');
      expect(doc.nodes).toEqual([]);
      expect(localStorage.getItem(CANVAS_BACKUP_KEY)).toBe('{definitely not json');
      // The unreadable original stays recoverable even after the surface's mount-time
      // auto-save clobbers the primary key with an empty document.
      saveDocument(emptyDocument());
      expect(localStorage.getItem(CANVAS_BACKUP_KEY)).toBe('{definitely not json');
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  // Parsing is only half of "readable". These payloads all parse fine and would otherwise
  // sanitise down to an empty document — which the surface persists over the original on mount,
  // wiping the user's graph with no trace and no message.
  it('treats a payload that parses but yields NOTHING as corrupt, not as an empty canvas', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const payload of ['"just a string"', '42', 'null', '[1,2,3]']) {
        localStorage.removeItem(CANVAS_BACKUP_KEY);
        localStorage.setItem(CANVAS_STORAGE_KEY, payload);
        const { doc, status } = loadDocumentWithStatus();
        expect({ payload, status }).toEqual({ payload, status: 'corrupt' });
        expect(doc.nodes).toEqual([]);
        expect(localStorage.getItem(CANVAS_BACKUP_KEY)).toBe(payload);
      }
    } finally {
      err.mockRestore();
    }
  });

  it('treats "every stored node failed sanitisation" as corrupt, so the graph is not wiped', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Shape from some other/older writer: real entries, none of them a node we can read.
      const payload = JSON.stringify({ version: 2, nodes: [{ oops: 1 }, { oops: 2 }], edges: [] });
      localStorage.setItem(CANVAS_STORAGE_KEY, payload);
      const { doc, status } = loadDocumentWithStatus();
      expect(status).toBe('corrupt');
      expect(doc.nodes).toEqual([]);
      expect(localStorage.getItem(CANVAS_BACKUP_KEY)).toBe(payload);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('keeps the survivors on PARTIAL loss, but still preserves the original for recovery', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const good = createSessionNode('llm', { x: 0, y: 0 });
      const payload = JSON.stringify({ version: 2, nodes: [good, { oops: 1 }], edges: [] });
      localStorage.setItem(CANVAS_STORAGE_KEY, payload);
      const { doc, status } = loadDocumentWithStatus();
      // Dropping the survivor too would turn a small defect into a total wipe.
      expect(status).toBe('ok');
      expect(doc.nodes).toHaveLength(1);
      expect(doc.nodes[0].id).toBe(good.id);
      // ...and the dropped one is still recoverable rather than gone silently.
      expect(localStorage.getItem(CANVAS_BACKUP_KEY)).toBe(payload);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('save failures never throw (quota / privacy mode)', () => {
    const orig = localStorage.setItem.bind(localStorage);
    (localStorage as unknown as { setItem: unknown }).setItem = () => {
      throw new Error('quota');
    };
    try {
      expect(() => saveDocument(emptyDocument())).not.toThrow();
    } finally {
      (localStorage as unknown as { setItem: unknown }).setItem = orig;
    }
  });
});

describe('canvasDoc: legacy migration', () => {
  const legacyDoc = {
    version: 1,
    updatedAt: 7,
    nodes: [
      { id: 'n1', kind: 'form', x: 1, y: 2, title: '需求', fields: [{ id: 'f1', label: '目标', value: 'v' }] },
      {
        id: 'n2',
        kind: 'agent',
        x: 10,
        y: 20,
        title: '图像 Agent',
        agentType: 'image',
        runtime: 'claude_local',
        model: 'm1',
        effort: 'medium',
        persona: 'p',
        binding: { companyId: 'c1', agentId: 'a1', agentName: '设计' },
        bindAttempt: 'unknown',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', fromPort: 'data', toNode: 'n2', toPort: 'context', dataType: 'text' }],
  };

  beforeEach(() => localStorage.clear());

  it('converts a legacy document with a bound agent node (real bindings must not be orphaned)', () => {
    localStorage.setItem(LEGACY_WORKFLOW_STORAGE_KEY, JSON.stringify(legacyDoc));
    const doc = migrateFromLegacy();
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(2);
    expect(doc!.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);

    const session = doc!.nodes.find((n) => n.id === 'n2') as SessionNode;
    expect(session.kind).toBe('session');
    expect(session.agentKind).toBe('image');
    expect(session.runtime).toBe('claude_local');
    expect(session.effort).toBe('medium');
    expect(session.binding).toEqual({ companyId: 'c1', agentId: 'a1', agentName: '设计' });
    expect(session.bindAttempt).toBe('unknown');
    // The legacy family had no per-node thread and no persisted preview.
    expect(session.issueId).toBeNull();
    expect(session.preview).toBe('');
    expect(session.w).toBeGreaterThan(0);
    expect(session.h).toBeGreaterThan(0);

    expect(doc!.edges).toHaveLength(1);
    expect(doc!.edges[0].dataType).toBe('text');
    expect(doc!.waypoints).toEqual([]);
    expect(doc!.view).toBeNull();
    // Read-only: the legacy key is never rewritten or deleted.
    expect(localStorage.getItem(LEGACY_WORKFLOW_STORAGE_KEY)).toBe(JSON.stringify(legacyDoc));
  });

  it('loadDocumentWithStatus migrates when this canvas has no document of its own', () => {
    localStorage.setItem(LEGACY_WORKFLOW_STORAGE_KEY, JSON.stringify(legacyDoc));
    const { doc, status } = loadDocumentWithStatus();
    expect(status).toBe('ok');
    expect(doc.nodes).toHaveLength(2);
  });

  it('never migrates over an existing canvas document', () => {
    saveDocument(emptyDocument());
    localStorage.setItem(LEGACY_WORKFLOW_STORAGE_KEY, JSON.stringify(legacyDoc));
    expect(migrateFromLegacy()).toBeNull();
    expect(loadDocument().nodes).toEqual([]);
  });

  it('returns null with nothing to migrate, and preserves an unreadable legacy payload', () => {
    expect(migrateFromLegacy()).toBeNull();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      localStorage.setItem(LEGACY_WORKFLOW_STORAGE_KEY, '{not json either');
      expect(migrateFromLegacy()).toBeNull();
      expect(localStorage.getItem(CANVAS_BACKUP_KEY)).toBe('{not json either');
    } finally {
      err.mockRestore();
    }
  });
});

describe('lod', () => {
  it('focus outranks the size heuristic at any zoom', () => {
    expect(lodFor({ h: 260 }, 0.01, true)).toBe('focus');
    expect(lodFor({ h: 260 }, 4, true)).toBe('focus');
  });

  it('tiers on effective pixel height', () => {
    expect(lodFor({ h: 260 }, 0.3, false)).toBe('glance'); // 78px
    expect(lodFor({ h: 260 }, 0.35, false)).toBe('card'); // 91px
    expect(lodFor({ h: 260 }, 0.8, false)).toBe('open'); // 208px
    expect(lodFor({ h: 260 }, 1, false)).toBe('open');
  });

  it('treats the thresholds as inclusive lower bounds of the next tier', () => {
    expect(lodFor({ h: LOD_GLANCE_MAX_PX }, 1, false)).toBe('card'); // exactly 90 → card
    expect(lodFor({ h: LOD_GLANCE_MAX_PX - 1 }, 1, false)).toBe('glance');
    expect(lodFor({ h: LOD_CARD_MAX_PX }, 1, false)).toBe('open'); // exactly 200 → open
    expect(lodFor({ h: LOD_CARD_MAX_PX - 1 }, 1, false)).toBe('card');
  });

  it('a tall tile stays readable at a zoom where a short one does not', () => {
    expect(lodFor({ h: 600 }, 0.25, false)).toBe('card'); // 150px
    expect(lodFor({ h: 120 }, 0.25, false)).toBe('glance'); // 30px
  });

  it('renders more transcript the closer you get', () => {
    expect(TAIL_LINES.glance).toBe(0);
    expect(TAIL_LINES.card).toBe(3);
    expect(TAIL_LINES.open).toBe(12);
    expect(TAIL_LINES.focus).toBe(Infinity);
  });
});

describe('spatialOrder', () => {
  const nodes = [
    { id: 'c', x: 700, y: 12 }, // same row band as a/b despite the 12px drift
    { id: 'a', x: 0, y: 0 },
    { id: 'd', x: 100, y: 600 }, // second row
    { id: 'b', x: 350, y: 5 },
    { id: 'e', x: 0, y: 640 },
  ];

  it('reads left-to-right within a row band, then top-to-bottom', () => {
    expect(orderNodes(nodes).map((n) => n.id)).toEqual(['a', 'b', 'c', 'e', 'd']);
  });

  it('starts a new band once the vertical gap exceeds the tolerance', () => {
    const tight = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 100, y: 90 },
    ];
    expect(orderNodes(tight, 80).map((n) => n.id)).toEqual(['a', 'b']); // separate bands, a first
    expect(orderNodes([{ id: 'b', x: 100, y: 90 }, { id: 'a', x: 0, y: 0 }], 200).map((n) => n.id)).toEqual(['a', 'b']);
    // Same band, ordered by x: the later-listed node with a smaller x comes first.
    expect(orderNodes([{ id: 'b', x: 100, y: 90 }, { id: 'a', x: 0, y: 100 }], 200).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('nextIn steps and wraps in both directions', () => {
    const order = orderNodes(nodes);
    expect(nextIn(order, 'a', 1)).toBe('b');
    expect(nextIn(order, 'd', 1)).toBe('a'); // wraps forward off the end
    expect(nextIn(order, 'a', -1)).toBe('d'); // wraps backward off the front
    expect(nextIn(order, 'b', -1)).toBe('a');
  });

  it('nextIn starts at the near end when nothing (or an unknown node) is current', () => {
    const order = orderNodes(nodes);
    expect(nextIn(order, null, 1)).toBe('a');
    expect(nextIn(order, null, -1)).toBe('d');
    expect(nextIn(order, 'ghost', 1)).toBe('a');
    expect(nextIn([], 'a', 1)).toBeNull();
  });

  it('hitTestRect selects every overlapping box', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 200, y: 0, w: 100, h: 100 },
      { id: 'c', x: 0, y: 200, w: 100, h: 100 },
    ];
    expect(hitTestRect(boxes, { x: -10, y: -10, w: 60, h: 60 })).toEqual(['a']);
    expect(hitTestRect(boxes, { x: 50, y: 50, w: 200, h: 200 })).toEqual(['a', 'b', 'c']);
    expect(hitTestRect(boxes, { x: 500, y: 500, w: 50, h: 50 })).toEqual([]);
  });

  it('hitTestRect normalises a marquee dragged up/left and ignores a zero-area drag', () => {
    const boxes = [{ id: 'a', x: 0, y: 0, w: 100, h: 100 }];
    expect(hitTestRect(boxes, { x: 60, y: 60, w: -50, h: -50 })).toEqual(['a']);
    expect(hitTestRect(boxes, { x: 50, y: 50, w: 0, h: 0 })).toEqual([]);
    // Grazing the border is not an overlap.
    expect(hitTestRect(boxes, { x: 100, y: 0, w: 50, h: 50 })).toEqual([]);
  });
});
