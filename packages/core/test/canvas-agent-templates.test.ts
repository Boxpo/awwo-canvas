import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TEMPLATES, createAgentTemplate, createDevelopmentTemplate, getAgentTemplateForNode, type AgentTemplateId } from '../src/agentTemplates';
import { createFormNode, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeDocument, saveDocument, type CanvasEdge, type SessionNode } from '../src/canvasDoc';
import { canConnect, portsFor, reconcileEdges } from '../src/ports';
import { normalizeContract } from '../src/nodeContracts';
import { preflightGraph, runGraph } from '../src/runGraph';

const corePorts: Record<AgentTemplateId, [string, string]> = {
  general: ['brief', 'result'], frontend: ['api', 'delivery'], backend: ['schema', 'api'],
  data: ['brief', 'schema'], users: ['brief', 'identity'], materials: ['brief', 'assets'], review: ['delivery', 'report'],
};

beforeEach(() => localStorage.clear());

describe('complete role templates', () => {
  it.each(AGENT_TEMPLATES)('$id has distinct empty forms, complete guidance, and stable core ports', template => {
    const node = createAgentTemplate(template.id, { x: 10, y: 20 });
    const contract = node.contract!;
    expect(node).toMatchObject({ templateId: template.id, templateVersion: 1, binding: null, issueId: null, runtime: '', model: '', effort: '' });
    expect(node.lastOutput).toBeUndefined();
    expect(contract.inputs.length).toBeGreaterThanOrEqual(3);
    expect(contract.inputs.length).toBeLessThanOrEqual(4);
    expect(contract.outputs.length).toBeGreaterThanOrEqual(2);
    expect(contract.outputs.length).toBeLessThanOrEqual(3);
    expect([contract.inputs[0].id, contract.outputs[0].id]).toEqual(corePorts[template.id]);
    for (const fields of [contract.inputs, contract.outputs]) {
      expect(fields.filter(field => field.required)).toHaveLength(1);
      expect(fields[0].required).toBe(true);
      expect(new Set(fields.map(field => field.id)).size).toBe(fields.length);
      expect(fields.every(field => field.value === '' && Boolean(field.help) && Boolean(field.placeholder))).toBe(true);
    }
    expect(normalizeContract(contract)).toEqual(contract);
    expect(portsFor(node)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `in:${corePorts[template.id][0]}`, side: 'input', dataType: 'text' }),
      expect.objectContaining({ id: `out:${corePorts[template.id][1]}`, side: 'output', dataType: 'text' }),
    ]));
    expect(template.workflow.length).toBeGreaterThanOrEqual(3);
    expect(template.checklist.length).toBeGreaterThanOrEqual(3);
    expect(template.starterPrompts).toHaveLength(2);
    expect(template.starterPrompts.every(item => item.label && item.prompt)).toBe(true);
    expect(node.persona).toContain('工作步骤：');
    expect(node.persona).toContain('验收要求：');
    expect(node.persona).toContain('未验证');
    expect(template.workflow.every(step => node.persona.includes(step))).toBe(true);
    expect(template.checklist.every(item => node.persona.includes(item))).toBe(true);
    expect(template.emptyTitle && template.emptyDescription && template.deliverableTitle).toBeTruthy();
  });

  it.each(AGENT_TEMPLATES)('$id instances do not share mutable contract fields or arrays', template => {
    const first = createAgentTemplate(template.id, { x: 0, y: 0 });
    const second = createAgentTemplate(template.id, { x: 0, y: 0 });
    expect(first.id).not.toBe(second.id);
    expect(first.contract).not.toBe(second.contract);
    expect(first.contract!.inputs).not.toBe(template.inputs);
    expect(first.contract!.outputs).not.toBe(template.outputs);
    first.contract!.inputs[0].value = 'User content';
    first.contract!.outputs[0].label = 'User delivery label';
    first.contract!.inputs.push({ id: 'extra', label: 'Custom', type: 'text', required: false, value: '' });
    expect(second.contract!.inputs[0].value).toBe('');
    expect(template.inputs[0].value).toBe('');
    expect(second.contract!.outputs[0].label).toBe(template.outputs[0].label);
    expect(second.contract!.inputs).toHaveLength(template.inputs.length);
  });

  it('separates backend business services from user identity responsibilities', () => {
    const backend = createAgentTemplate('backend', { x: 0, y: 0 });
    const users = createAgentTemplate('users', { x: 0, y: 0 });
    expect(backend.title).toBe('后端服务');
    expect(backend.persona).toContain('授权策略由用户系统节点提供');
    expect(users.persona).toContain('不接管通用业务接口实现');
    expect(new Set(AGENT_TEMPLATES.map(template => template.persona)).size).toBe(7);
    expect(new Set(AGENT_TEMPLATES.map(template => template.emptyTitle)).size).toBe(7);
  });
});

it('persists template identity and field guidance without overwriting user edits', () => {
  const node = createAgentTemplate('frontend', { x: 20, y: 30 });
  node.title = 'A user-renamed frontend';
  node.persona = 'A user-authored persona';
  node.contract!.inputs[0].value = '**Actual API contract**';
  node.contract!.outputs[0].label = 'Custom delivery';
  saveDocument({ ...emptyDocument(), nodes: [node] });
  const restored = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(restored).toMatchObject({ templateId: 'frontend', templateVersion: 1, title: node.title, persona: node.persona, contract: node.contract });
  const before = structuredClone(restored);
  expect(getAgentTemplateForNode(Object.freeze(restored))?.id).toBe('frontend');
  expect(restored).toEqual(before);
});

it('does not preserve invalid template IDs or invalid version metadata', () => {
  const node = createAgentTemplate('data', { x: 0, y: 0 });
  const invalidId = sanitizeDocument({ ...emptyDocument(), nodes: [{ ...node, templateId: 'unknown-role' }] }).nodes[0] as SessionNode;
  expect(invalidId.templateId).toBeUndefined();
  expect(invalidId.templateVersion).toBeUndefined();
  for (const version of [0, -1, 1.5, '1', NaN]) {
    const restored = sanitizeDocument({ ...emptyDocument(), nodes: [{ ...node, templateVersion: version }] }).nodes[0] as SessionNode;
    expect(restored.templateId).toBe('data');
    expect(restored.templateVersion).toBeUndefined();
  }
});

it('recognizes legacy nodes only by exact historical title plus matching core input and output IDs', () => {
  const current = createAgentTemplate('backend', { x: 0, y: 0 });
  const legacy: SessionNode = { ...current, title: '后端 / 用户系统', templateId: undefined, templateVersion: undefined,
    persona: 'Existing user instructions', contract: { version: 1, inputs: [{ ...current.contract!.inputs[0], value: 'Keep schema' }], outputs: [{ ...current.contract!.outputs[0], value: 'Keep output draft' }] } };
  const before = structuredClone(legacy);
  expect(getAgentTemplateForNode(Object.freeze(legacy))?.id).toBe('backend');
  expect(legacy).toEqual(before);
  expect(getAgentTemplateForNode({ ...legacy, title: '我的后端 / 用户系统' })).toBeUndefined();
  expect(getAgentTemplateForNode({ ...legacy, contract: { ...legacy.contract!, inputs: [{ ...legacy.contract!.inputs[0], id: 'other' }] } })).toBeUndefined();
  expect(getAgentTemplateForNode({ ...legacy, contract: { ...legacy.contract!, outputs: [{ ...legacy.contract!.outputs[0], id: 'other' }] } })).toBeUndefined();
  expect(getAgentTemplateForNode(createSessionNode('coding', { x: 0, y: 0 }))).toBeUndefined();
  expect(getAgentTemplateForNode(createFormNode({ x: 0, y: 0 }))).toBeUndefined();
});

it('keeps all five development connections valid without duplicating optional input ports', async () => {
  const graph = createDevelopmentTemplate({ x: 0, y: 0 });
  expect(graph.nodes).toHaveLength(5);
  expect(graph.edges).toHaveLength(5);
  expect(reconcileEdges(graph.nodes, graph.edges)).toEqual(graph.edges);
  const connected: CanvasEdge[] = [];
  for (const edge of graph.edges) {
    expect(canConnect(graph.nodes, connected, { nodeId: edge.fromNode, portId: edge.fromPort }, { nodeId: edge.toNode, portId: edge.toPort })).toBe(true);
    connected.push(edge);
  }
  const frontend = graph.nodes.find(node => node.templateId === 'frontend')!;
  const review = graph.nodes.find(node => node.templateId === 'review')!;
  expect(frontend.contract!.inputs.filter(field => field.id === 'assets')).toHaveLength(1);
  expect(review.contract!.inputs.filter(field => field.id === 'api')).toHaveLength(1);
  expect(frontend.contract!.inputs.find(field => field.id === 'assets')?.required).toBe(false);
  expect(review.contract!.inputs.find(field => field.id === 'api')?.required).toBe(false);
  for (const node of graph.nodes) {
    node.binding = { companyId: 'fixture-company', agentId: `fixture-${node.id}`, agentName: node.title };
    node.runtime = 'fixture-runtime';
    if (node.templateId === 'data' || node.templateId === 'materials') node.contract!.inputs[0].value = 'Explicit test brief';
  }
  expect(preflightGraph(graph.nodes, graph.edges)).toBeNull();
  const executed: string[] = [];
  const finalStates = new Map<string, string>();
  const result = await runGraph({ ...graph, onStatus: (id, status) => finalStates.set(id, status.state), execAgent: async node => {
    executed.push(node.templateId!);
    return { ok: true, output: JSON.stringify({ [node.contract!.outputs[0].id]: `${node.templateId} fixture result` }) };
  } });
  expect(result.ok).toBe(true);
  expect(result.done).toBe(5);
  expect([...finalStates.values()]).toEqual(['done', 'done', 'done', 'done', 'done']);
  expect(executed).toHaveLength(5);
  expect(executed.indexOf('data')).toBeLessThan(executed.indexOf('backend'));
  expect(executed.indexOf('backend')).toBeLessThan(executed.indexOf('frontend'));
  expect(executed.indexOf('frontend')).toBeLessThan(executed.indexOf('review'));
});
