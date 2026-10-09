import { describe, expect, it } from 'vitest';
import { applyCanvasPlan, canvasPlanRevision, onlyAddedNodes, parseCanvasPlan, type CanvasPlan, type CanvasPlanOperation } from '../src/canvasPlan';
import { createAgentTemplate } from '../src/agentTemplates';
import { createFormNode, createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvasDoc';
import { edgeId, reconcileEdges } from '../src/ports';
import { activeNodeThread, updateNodeDraft } from '../src/nodeThreads';

const plan = (...operations: CanvasPlanOperation[]): CanvasPlan => ({ version: 1, summary: '调整画布', operations });
const emptyField = { id: 'extra', label: '辅助字段', type: 'markdown' as const, required: false, value: '' };

function fixture(): CanvasDocument {
  const source = updateNodeDraft({ ...createAgentTemplate('data', { x: 100, y: 140 }), id: 'source',
    binding: { companyId: 'real-company', agentId: 'real-agent', agentName: 'Real agent' },
    issueId: 'real-thread', runtime: 'real-runtime', model: 'real-model', effort: 'high',
    lastOutput: { text: '{"schema":"Real schema"}', source: 'run' as const, at: 42 },
  }, 'Unsent user message');
  const target = { ...createAgentTemplate('backend', { x: 1400, y: 300 }), id: 'target',
    lastOutput: { text: '{"api":"Real API"}', source: 'manual' as const, at: 43 },
  };
  const from = { nodeId: source.id, portId: 'out:schema' };
  const to = { nodeId: target.id, portId: 'in:schema' };
  return { ...emptyDocument(), nodes: [source, target], edges: [{ id: edgeId(from, to), fromNode: source.id,
    fromPort: from.portId, toNode: target.id, toPort: to.portId, dataType: 'text' }],
  };
}

describe('strict canvas plan protocol', () => {
  it.each([
    { type: 'set_execution', mode: 'review', reviewerNodeId: 'target', verdictFieldId: 'approved' },
    { type: 'set_execution', mode: 'review', maxRounds: 0, reviewerNodeId: 'target', verdictFieldId: 'approved' },
    { type: 'set_execution', mode: 'review', maxRounds: 6, reviewerNodeId: 'target', verdictFieldId: 'approved' },
    { type: 'set_execution', mode: 'review', maxRounds: 2.5, reviewerNodeId: 'target', verdictFieldId: 'approved' },
    { type: 'set_execution', mode: 'review', maxRounds: '3', reviewerNodeId: 'target', verdictFieldId: 'approved' },
    { type: 'set_execution', mode: 'review', maxRounds: 3, verdictFieldId: 'approved' },
    { type: 'set_execution', mode: 'review', maxRounds: 3, reviewerNodeId: 'target' },
    { type: 'set_execution', mode: 'workflow', maxRounds: 3 },
    { type: 'set_execution', mode: 'workflow', reviewerNodeId: 'target' },
    { type: 'set_execution', mode: 'autonomous' },
    { type: 'set_execution', mode: 'review', maxRounds: 3, reviewerNodeId: 'target', verdictFieldId: 'approved', runNow: true },
    { type: 'connect', fromNode: 'source', fromField: 'schema', toNode: 'target', toField: 'schema', kind: 'recursive' },
    { type: 'set_edge_kind', edgeId: 'edge', kind: 'recursive' },
  ])('rejects unsupported execution policy or edge semantics: %j', operation => {
    expect(() => parseCanvasPlan({ ...plan(), operations: [operation] })).toThrow('画布方案');
  });

  it('accepts exact JSON objects and fenced JSON without allowing surrounding prose', () => {
    const wanted = plan({ type: 'add_node', ref: 'new-data', templateId: 'data', inputValues: { brief: 'A real requested brief' } });
    expect(parseCanvasPlan(JSON.stringify(wanted))).toEqual(wanted);
    expect(parseCanvasPlan(`\`\`\`json\n${JSON.stringify(wanted)}\n\`\`\``)).toEqual(wanted);
    expect(() => parseCanvasPlan(`Here is a plan: ${JSON.stringify(wanted)}`)).toThrow('JSON');
  });

  it.each(['binding', 'runtime', 'model', 'effort', 'threads', 'issueId', 'preview', 'lastOutput', 'x', 'y', 'w', 'templateId'])('rejects %s outside the node edit whitelist', key => {
    expect(() => parseCanvasPlan({ ...plan(), operations: [{ type: 'update_node', nodeId: 'source', title: 'Rename', [key]: 'forbidden' }] })).toThrow(`不允许字段「${key}」`);
  });

  it('rejects unknown operations, versions, extra root keys and duplicate references', () => {
    expect(() => parseCanvasPlan({ ...plan(), version: 2 })).toThrow('version');
    expect(() => parseCanvasPlan({ ...plan(), command: 'run' })).toThrow('command');
    expect(() => parseCanvasPlan({ ...plan(), operations: [{ type: 'run_node', nodeId: 'source' }] })).toThrow('不支持操作');
    expect(() => parseCanvasPlan(plan({ type: 'add_node', ref: 'same', templateId: 'data' }, { type: 'add_node', ref: 'same', templateId: 'backend' }))).toThrow('重复');
    expect(() => parseCanvasPlan({ ...plan(), operations: [{ type: 'add_node', ref: 'a', templateId: 'unknown' }] })).toThrow('templateId');
  });

  it('bounds payload size, operation count, strings and dangerous dictionary keys', () => {
    expect(() => parseCanvasPlan(' '.repeat(120001))).toThrow('120000');
    expect(() => parseCanvasPlan({ ...plan(), operations: Array.from({ length: 101 }, () => ({ type: 'remove_node', nodeId: 'source' })) })).toThrow('100');
    expect(() => parseCanvasPlan(plan({ type: 'update_node', nodeId: 'source', title: 'x'.repeat(201) }))).toThrow('200');
    expect(() => parseCanvasPlan(plan({ type: 'set_input', nodeId: 'source', fieldId: 'brief', value: 'x'.repeat(16001) }))).toThrow('16000');
    expect(() => parseCanvasPlan('{"version":1,"summary":"test","operations":[{"type":"add_node","ref":"a","templateId":"data","inputValues":{"__proto__":"bad"}}]}')).toThrow('有效 ID');
  });

  it('requires empty new field values and rejects output value edits through every schema path', () => {
    expect(() => parseCanvasPlan(plan({ type: 'add_field', nodeId: 'source', side: 'output', field: { ...emptyField, value: 'Invented output' } }))).toThrow('禁止生成输出值');
    expect(() => parseCanvasPlan({ ...plan(), operations: [{ type: 'update_field', nodeId: 'source', side: 'output', fieldId: 'schema', changes: { value: 'Invented output' } }] })).toThrow('value');
    expect(() => applyCanvasPlan(fixture(), plan({ type: 'set_input', nodeId: 'source', fieldId: 'schema', value: 'Invented output' }))).toThrow('没有输入字段');
    expect(() => parseCanvasPlan({ ...plan(), operations: [{ type: 'add_node', ref: 'new', templateId: 'data', outputValues: { schema: 'Invented' } }] })).toThrow('outputValues');
  });
});

describe('AI review graph and document format editing', () => {
  function reviewPlan(): CanvasPlan {
    return plan(
      { type: 'add_node', ref: 'producer', templateId: 'general', inputValues: { brief: '制作完整 HTML 页面' } },
      { type: 'update_field', nodeId: 'producer', side: 'output', fieldId: 'result', changes: { type: 'html' } },
      { type: 'add_node', ref: 'reviewer', templateId: 'general', persona: '独立验证并质疑收到的页面，列出具体修改意见。' },
      { type: 'add_field', nodeId: 'reviewer', side: 'output', field: { id: 'approved', label: '是否通过', type: 'boolean', required: true, value: '' } },
      { type: 'connect', fromNode: 'producer', fromField: 'result', toNode: 'reviewer', toField: 'brief', kind: 'data' },
      { type: 'connect', fromNode: 'reviewer', fromField: 'result', toNode: 'producer', toField: 'constraints', kind: 'feedback' },
      { type: 'set_execution', mode: 'review', maxRounds: 3, reviewerNodeId: 'reviewer', verdictFieldId: 'approved' },
    );
  }

  it('builds a bounded review loop with HTML delivery and real added-node references without executing or binding it', () => {
    const doc = fixture();
    const before = structuredClone(doc);
    const applied = applyCanvasPlan(doc, reviewPlan());
    const [producer, reviewer] = applied.doc.nodes.slice(2) as SessionNode[];
    expect(applied.doc.execution).toEqual({ mode: 'review', maxRounds: 3, reviewerNodeId: reviewer.id, verdictFieldId: 'approved' });
    expect(producer.contract!.outputs.find(field => field.id === 'result')).toMatchObject({ type: 'html', value: '' });
    expect(reviewer.x).toBeGreaterThan(producer.x);
    expect(applied.doc.edges.slice(1)).toMatchObject([
      { fromNode: producer.id, toNode: reviewer.id, kind: 'data', dataType: 'text' },
      { fromNode: reviewer.id, toNode: producer.id, kind: 'feedback', dataType: 'text' },
    ]);
    expect(producer.binding).toBeNull();
    expect(reviewer.binding).toBeNull();
    expect(producer.issueId).toBeNull();
    expect(reviewer.issueId).toBeNull();
    expect(activeNodeThread(applied.doc.nodes[0] as SessionNode).draft).toBe('Unsent user message');
    expect((applied.doc.nodes[0] as SessionNode).binding).toEqual((doc.nodes[0] as SessionNode).binding);
    expect((applied.doc.nodes[0] as SessionNode).threads).toEqual((doc.nodes[0] as SessionNode).threads);
    expect(doc).toEqual(before);
  });

  it('switches back to workflow while retaining inactive feedback and can edit the existing edge kind', () => {
    const review = applyCanvasPlan(emptyDocument(), reviewPlan()).doc;
    const feedback = review.edges.find(edge => edge.kind === 'feedback')!;
    const workflow = applyCanvasPlan(review, plan({ type: 'set_execution', mode: 'workflow' })).doc;
    expect(workflow.execution).toBeUndefined();
    expect(workflow.edges).toEqual(review.edges);
    const before = structuredClone(workflow);
    expect(() => applyCanvasPlan(workflow, plan({ type: 'set_edge_kind', edgeId: feedback.id, kind: 'data' }))).toThrow('回环');
    expect(workflow).toEqual(before);
    const data = workflow.edges.find(edge => edge.kind === 'data')!;
    const reversed = applyCanvasPlan(workflow, plan(
      { type: 'set_edge_kind', edgeId: data.id, kind: 'feedback' },
      { type: 'set_edge_kind', edgeId: feedback.id, kind: 'data' },
    )).doc;
    expect(reversed.edges.find(edge => edge.id === feedback.id)?.kind).toBe('data');
    expect(reversed.edges.find(edge => edge.id === data.id)?.kind).toBe('feedback');
    expect(() => applyCanvasPlan(workflow, plan({ type: 'set_edge_kind', edgeId: 'another-project-edge', kind: 'data' }))).toThrow('不在当前画布');
  });

  it('can save an incomplete loop for manual completion but rejects unresolved or nonboolean reviewers', () => {
    const doc = fixture();
    const setup: CanvasPlanOperation = { type: 'add_field', nodeId: 'target', side: 'output', field: { ...emptyField, id: 'approved', type: 'boolean' } };
    const policy: CanvasPlanOperation = { type: 'set_execution', mode: 'review', maxRounds: 2, reviewerNodeId: 'target', verdictFieldId: 'approved' };
    expect(applyCanvasPlan(doc, plan(setup, policy)).doc.execution?.maxRounds).toBe(2);
    expect(() => applyCanvasPlan(doc, plan(policy, setup))).toThrow('boolean');
    expect(() => applyCanvasPlan(doc, plan({ ...policy, reviewerNodeId: 'future' }, { type: 'add_node', ref: 'future', templateId: 'review' }))).toThrow('尚未创建');
    expect(() => applyCanvasPlan(doc, plan({ ...policy, verdictFieldId: 'api' }))).toThrow('boolean');
    expect(() => applyCanvasPlan(doc, plan(setup, policy, { type: 'remove_node', nodeId: 'target' }))).toThrow('最终评审');
    expect(() => applyCanvasPlan(doc, plan(setup, policy, { type: 'update_field', nodeId: 'target', side: 'output', fieldId: 'approved', changes: { type: 'markdown' } }))).toThrow('boolean');
    expect(applyCanvasPlan(doc, plan(setup, policy, { type: 'set_execution', mode: 'workflow' }, { type: 'remove_node', nodeId: 'target' })).doc.execution).toBeUndefined();
  });

  it('supports added and edited HTML fields without permitting fabricated output values or unknown types', () => {
    const doc = fixture();
    const htmlField: CanvasPlanOperation = { type: 'add_field', nodeId: 'source', side: 'output', field: { ...emptyField, id: 'page', type: 'html' } };
    const result = applyCanvasPlan(doc, plan(htmlField, { type: 'update_field', nodeId: 'source', side: 'output', fieldId: 'schema', changes: { type: 'html' } })).doc;
    expect((result.nodes[0] as SessionNode).contract?.outputs.filter(field => field.type === 'html')).toHaveLength(2);
    expect(result.nodes[0].lastOutput).toBeNull();
    expect(() => parseCanvasPlan({ ...plan(), operations: [{ ...htmlField, field: { ...htmlField.field, value: '<html>Invented</html>' } }] })).toThrow('禁止生成输出值');
    expect(() => parseCanvasPlan({ ...plan(), operations: [{ ...htmlField, field: { ...htmlField.field, type: 'executable' } }] })).toThrow('不是支持的字段类型');
  });
});

describe('atomic graph application', () => {
  it('adds full template chains on the right while preserving old layout, sessions, fields and genuine outputs', () => {
    const doc = fixture();
    const before = structuredClone(doc);
    const applied = applyCanvasPlan(Object.freeze(doc), plan(
      { type: 'add_node', ref: 'front', templateId: 'frontend', title: 'Requested frontend' },
      { type: 'add_node', ref: 'reviewer', templateId: 'review' },
      { type: 'connect', fromNode: 'target', fromField: 'api', toNode: 'front', toField: 'api' },
      { type: 'connect', fromNode: 'front', fromField: 'delivery', toNode: 'reviewer', toField: 'delivery' },
    ));
    expect(doc).toEqual(before);
    expect(applied.doc.nodes.slice(0, 2)).toEqual(before.nodes);
    expect(applied.doc.nodes[0]).not.toBe(doc.nodes[0]);
    expect(activeNodeThread(applied.doc.nodes[0] as SessionNode).draft).toBe('Unsent user message');
    expect(applied.addedNodeIds).toHaveLength(2);
    const [front, review] = applied.doc.nodes.slice(2) as SessionNode[];
    expect(front).toMatchObject({ title: 'Requested frontend', templateId: 'frontend', templateVersion: 1, binding: null, issueId: null, runtime: '' });
    expect(front.contract!.inputs.length).toBeGreaterThan(1);
    expect(front.contract!.outputs.every(field => field.value === '')).toBe(true);
    expect(front.x).toBeGreaterThanOrEqual(before.nodes[1].x + before.nodes[1].w + 100);
    expect(review.x).toBeGreaterThan(front.x);
    expect(reconcileEdges(applied.doc.nodes, applied.doc.edges)).toEqual(applied.doc.edges);
  });

  it('allows only title/persona edits and invalidates affected results without changing real session identities', () => {
    const doc = fixture();
    const applied = applyCanvasPlan(doc, plan({ type: 'update_node', nodeId: 'source', title: 'Governed data', persona: 'New requested scope' }));
    const changed = applied.doc.nodes[0] as SessionNode;
    expect(changed).toMatchObject({ title: 'Governed data', persona: 'New requested scope', binding: doc.nodes[0].kind === 'session' ? doc.nodes[0].binding : null,
      issueId: 'real-thread', runtime: 'real-runtime', model: 'real-model', effort: 'high', x: 100, y: 140 });
    expect(changed.threads).toEqual((doc.nodes[0] as SessionNode).threads);
    expect(changed.contract).toEqual((doc.nodes[0] as SessionNode).contract);
    expect(applied.doc.nodes.every(node => node.lastOutput == null)).toBe(true);
    expect(doc.nodes[0].lastOutput?.text).toBe('{"schema":"Real schema"}');
  });

  it('never partially mutates a document when a later operation fails', () => {
    const doc = fixture();
    const before = structuredClone(doc);
    expect(() => applyCanvasPlan(doc, plan({ type: 'update_node', nodeId: 'source', title: 'Would change' }, { type: 'set_input', nodeId: 'outside-scope', fieldId: 'brief', value: 'bad' }))).toThrow('不在当前画布');
    expect(doc).toEqual(before);
  });

  it('rejects scope escapes, forward refs, collisions and stale deleted references', () => {
    const doc = fixture();
    expect(() => applyCanvasPlan(doc, plan({ type: 'remove_node', nodeId: 'other-project-node' }))).toThrow('不在当前画布');
    expect(() => applyCanvasPlan(doc, plan({ type: 'set_input', nodeId: 'future', fieldId: 'brief', value: 'x' }, { type: 'add_node', ref: 'future', templateId: 'data' }))).toThrow('尚未创建');
    expect(() => applyCanvasPlan(doc, plan({ type: 'add_node', ref: 'source', templateId: 'data' }))).toThrow('冲突');
    expect(() => applyCanvasPlan(doc, plan({ type: 'remove_node', nodeId: 'source' }, { type: 'update_node', nodeId: 'source', title: 'Gone' }))).toThrow('已删除');
    expect(() => applyCanvasPlan(doc, { ...plan(), operations: [{ type: 'update_node', nodeId: 'source', binding: null } as unknown as CanvasPlanOperation] })).toThrow('binding');
  });

  it('rejects cycles, duplicate connections and occupied single input fields', () => {
    const doc = fixture();
    expect(() => applyCanvasPlan(doc, plan({ type: 'connect', fromNode: 'target', fromField: 'api', toNode: 'source', toField: 'brief' }))).toThrow('回环');
    expect(() => applyCanvasPlan(doc, plan({ type: 'connect', fromNode: 'source', fromField: 'schema', toNode: 'target', toField: 'schema' }))).toThrow('重复');
    expect(() => applyCanvasPlan(doc, plan({ type: 'add_node', ref: 'second-source', templateId: 'data' }, { type: 'connect', fromNode: 'second-source', fromField: 'schema', toNode: 'target', toField: 'schema' }))).toThrow('占用');
    expect(() => applyCanvasPlan(doc, plan({ type: 'connect', fromNode: 'source', fromField: 'missing', toNode: 'target', toField: 'rules' }))).toThrow('不存在');
  });

  it('requires explicit disconnection before a linked field is removed or made incompatible', () => {
    const doc = fixture();
    expect(() => applyCanvasPlan(doc, plan({ type: 'remove_field', nodeId: 'source', side: 'output', fieldId: 'schema' }))).toThrow('显式 disconnect');
    expect(() => applyCanvasPlan(doc, plan({ type: 'update_field', nodeId: 'source', side: 'output', fieldId: 'schema', changes: { type: 'number' } }))).toThrow('类型不匹配');
    const applied = applyCanvasPlan(doc, plan(
      { type: 'disconnect', edgeId: doc.edges[0].id },
      { type: 'update_field', nodeId: 'source', side: 'output', fieldId: 'schema', changes: { type: 'number', label: 'Count' } },
      { type: 'update_field', nodeId: 'target', side: 'input', fieldId: 'schema', changes: { type: 'number' } },
      { type: 'connect', fromNode: 'source', fromField: 'schema', toNode: 'target', toField: 'schema' },
    ));
    expect(applied.doc.edges[0].dataType).toBe('number');
    expect(doc.edges[0].dataType).toBe('text');
  });

  it('supports schema changes and typed input values without generating outputs', () => {
    const doc = fixture();
    const applied = applyCanvasPlan(doc, plan(
      { type: 'add_field', nodeId: 'source', side: 'input', field: { ...emptyField, id: 'count', type: 'number', help: 'Requested sample count' } },
      { type: 'set_input', nodeId: 'source', fieldId: 'count', value: '12' },
      { type: 'add_field', nodeId: 'source', side: 'output', field: emptyField },
      { type: 'update_field', nodeId: 'source', side: 'output', fieldId: 'extra', changes: { label: 'Requested extra report', placeholder: 'Evidence:' } },
      { type: 'remove_field', nodeId: 'source', side: 'input', fieldId: 'sources' },
    ));
    const node = applied.doc.nodes[0] as SessionNode;
    expect(node.contract!.inputs.find(field => field.id === 'count')?.value).toBe('12');
    expect(node.contract!.inputs.some(field => field.id === 'sources')).toBe(false);
    expect(node.contract!.outputs.find(field => field.id === 'extra')).toMatchObject({ value: '', label: 'Requested extra report', placeholder: 'Evidence:' });
    expect(() => applyCanvasPlan(applied.doc, plan({ type: 'set_input', nodeId: 'source', fieldId: 'count', value: 'not a number' }))).toThrow('有效数字');
    expect(() => applyCanvasPlan(applied.doc, plan({ type: 'add_field', nodeId: 'source', side: 'input', field: { ...emptyField, id: 'count' } }))).toThrow('重复');
  });

  it('allows explicit node deletion with incident edges but rejects nonexistent disconnects', () => {
    const doc = fixture();
    const applied = applyCanvasPlan(doc, plan({ type: 'remove_node', nodeId: 'source' }));
    expect(applied.doc.nodes.map(node => node.id)).toEqual(['target']);
    expect(applied.doc.edges).toEqual([]);
    expect(applied.doc.nodes[0].lastOutput).toBeNull();
    expect(() => applyCanvasPlan(doc, plan({ type: 'disconnect', edgeId: 'foreign-edge' }))).toThrow('不在当前画布');
  });

  it('does not silently discard legacy ports while adding a new contract', () => {
    const first = { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'legacy' };
    const target = { ...createSessionNode('coding', { x: 800, y: 0 }), id: 'legacy-target' };
    const doc = { ...emptyDocument(), nodes: [first, target], edges: [{ id: 'legacy-edge', fromNode: first.id, fromPort: 'result', toNode: target.id, toPort: 'context', dataType: 'text' as const }] };
    expect(() => applyCanvasPlan(doc, plan({ type: 'add_field', nodeId: first.id, side: 'output', field: emptyField }))).toThrow('显式 disconnect');
    const form = createFormNode({ x: 0, y: 0 });
    const formDoc = { ...emptyDocument(), nodes: [form] };
    expect(applyCanvasPlan(formDoc, plan({ type: 'set_input', nodeId: form.id, fieldId: 'f1', value: 'New requirement' })).doc.nodes[0]).toMatchObject({ fields: [{ ...form.fields[0], value: 'New requirement' }, form.fields[1]] });
    expect(() => applyCanvasPlan(formDoc, plan({ type: 'update_node', nodeId: form.id, persona: 'Not an agent' }))).toThrow('不能设置 persona');
  });
});

it('creates a stable revision that detects edits and layout changes while ignoring viewport timestamps', () => {
  const doc = fixture();
  const original = canvasPlanRevision(doc);
  expect(canvasPlanRevision(structuredClone(doc))).toBe(original);
  const reorderedKeys = { ...doc, nodes: doc.nodes.map(node => Object.fromEntries(Object.entries(node).reverse()) as unknown as typeof node) };
  expect(canvasPlanRevision(reorderedKeys)).toBe(original);
  expect(canvasPlanRevision({ ...doc, updatedAt: doc.updatedAt + 1, view: { x: 99, y: 12, scale: 2 }, waypoints: [{ slot: 1, view: { x: 1, y: 1, scale: 1 } }] })).toBe(original);
  for (const change of [
    (copy: CanvasDocument) => { copy.nodes[0].title = 'Renamed'; },
    (copy: CanvasDocument) => { copy.nodes[0].x += 100; },
    (copy: CanvasDocument) => { copy.nodes[0].w += 100; },
    (copy: CanvasDocument) => { (copy.nodes[0] as SessionNode).contract!.inputs[0].value = 'Manual edit during request'; },
    (copy: CanvasDocument) => { copy.edges = []; },
    (copy: CanvasDocument) => { copy.edges[0].kind = 'feedback'; },
    (copy: CanvasDocument) => { copy.execution = { mode: 'review', maxRounds: 3, reviewerNodeId: 'target', verdictFieldId: 'approved' }; },
  ]) {
    const copy = structuredClone(doc); change(copy);
    expect(canvasPlanRevision(copy)).not.toBe(original);
  }
  const review = { ...doc, execution: { mode: 'review' as const, maxRounds: 3, reviewerNodeId: 'target', verdictFieldId: 'approved' } };
  expect(canvasPlanRevision({ ...review, execution: { ...review.execution, maxRounds: 4 } })).not.toBe(canvasPlanRevision(review));
});

it('knows a plan that changed nothing but the nodes it added', () => {
  const doc = fixture();
  const onlyAdds = (value: CanvasPlan) => { const applied = applyCanvasPlan(doc, value); return onlyAddedNodes(doc, applied.doc, applied.addedNodeIds); };
  // New nodes only, one of them fed by an existing node: deleting them gives the canvas back.
  expect(onlyAdds(plan({ type: 'add_node', ref: 'n', templateId: 'general', title: '新节点' }))).toBe(true);
  expect(onlyAdds(plan({ type: 'add_node', ref: 'n', templateId: 'backend' },
    { type: 'connect', fromNode: 'source', fromField: 'schema', toNode: 'n', toField: 'schema' }))).toBe(true);
  // An existing node changed or removed stays so once the new nodes are gone.
  expect(onlyAdds(plan({ type: 'add_node', ref: 'n', templateId: 'general' }, { type: 'update_node', nodeId: 'target', title: '改名' }))).toBe(false);
  expect(onlyAdds(plan({ type: 'add_node', ref: 'n', templateId: 'general' }, { type: 'remove_node', nodeId: 'target' }))).toBe(false);
  // Nothing added: no node can tell.
  expect(onlyAdds(plan({ type: 'update_node', nodeId: 'target', title: '改名' }))).toBe(false);
  expect(onlyAddedNodes(doc, doc, [])).toBe(false);
});
