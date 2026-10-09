// End to end over real HTTP: the orchestrator, its hot-plug registry, the skills on disk and the
// dependency-free mock worker. Nothing is stubbed between the HTTP request and the worker.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentTemplate, type AgentTemplateId } from '@awwo/core/agentTemplates';
import { emptyDocument, type CanvasDocument, type SessionNode } from '@awwo/core/canvasDoc';
import { applyCanvasPlan, parseCanvasPlan } from '@awwo/core/canvasPlan';
import { createNodeTeam } from '@awwo/core/nodeTeam';
import { buildPlanningContext } from '@awwo/core/planningContext';
import { addReviewPartner } from '@awwo/core/reviewPartner';
import { startMockWorker, type MockWorker } from '../../../workers/mock/worker.mjs';
import { createApi, type Api } from '../src/api';
import { loadConfig, REPO_ROOT } from '../src/config';
import { RuntimeRegistry } from '../src/runtimes/registry';
import { SkillRegistry } from '../src/skills';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = any;

interface Harness { base: string; port: number; dir: string; skills: SkillRegistry; close(): Promise<void> }

async function startOrchestrator(mockUrl: string): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'awwo-canvas-test-'));
  const skillsDir = path.join(dir, 'skills');
  cpSync(path.join(REPO_ROOT, 'skills'), skillsDir, { recursive: true });
  const runtimesFile = path.join(dir, 'runtimes.json');
  writeFileSync(runtimesFile, JSON.stringify({ defaultRuntime: 'mock', runtimes: [{ id: 'mock', label: 'Mock', url: mockUrl }] }));
  const registry = new RuntimeRegistry({ file: runtimesFile, probeIntervalMs: 0 });
  await registry.start();
  const skills = new SkillRegistry(skillsDir);
  skills.load();
  skills.watch();
  let api: Api | undefined;
  const server = createServer((req, res) => api!.handle(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig({ AWWO_PORT: String(port), AWWO_RUNTIMES_FILE: runtimesFile, AWWO_SKILLS_DIR: skillsDir });
  api = createApi(config, registry, skills, () => {});
  return {
    base: `http://127.0.0.1:${port}`, port, dir, skills,
    async close() {
      api?.graphRuns.cancelAll();
      registry.stop();
      skills.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every `data:` frame of a finished text/event-stream body. */
function frames(text: string): Frame[] {
  return text.split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'))
    .filter(Boolean).map(data => JSON.parse(data));
}

const post = (base: string, route: string, body: unknown) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** A request with full control over Host and Origin, which fetch does not offer. */
function raw(port: number, options: { method: string; path: string; headers: Record<string, string>; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: options.method, path: options.path, headers: options.headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

/** A template node whose required inputs are filled, so it passes preflight on its own. */
function readyNode(template: AgentTemplateId, brief: string, x = 0): SessionNode {
  const node = createAgentTemplate(template, { x, y: 0 }, 'en');
  return { ...node, contract: { ...node.contract!, inputs: node.contract!.inputs.map(field => field.required ? { ...field, value: brief } : field) } };
}

const documentOf = (...nodes: SessionNode[]): CanvasDocument => ({ ...emptyDocument(), nodes });

async function runToEnd(base: string, document: CanvasDocument, scope?: string[]) {
  const response = await post(base, '/api/graph-runs', { document, operationId: `test-${randomUUID()}`, ...(scope ? { scope } : {}) });
  const accepted = await response.json();
  expect(response.status, JSON.stringify(accepted)).toBe(202);
  const events = frames(await (await fetch(`${base}/api/graph-runs/${accepted.run.id}/events`)).text());
  const { run } = await (await fetch(`${base}/api/graph-runs/${accepted.run.id}`)).json();
  return { ...run, events };
}

describe('orchestrator over HTTP', () => {
  let mock: MockWorker;
  let spare: MockWorker;
  let h: Harness;

  beforeAll(async () => {
    mock = await startMockWorker({ port: 0, delayMs: 0 });
    spare = await startMockWorker({ port: 0, delayMs: 0, runtime: 'spare' });
    h = await startOrchestrator(mock.url);
  });
  afterAll(async () => {
    await h?.close();
    await mock?.close();
    await spare?.close();
  });

  it('reports health and the runtimes it can route to, without their endpoints', async () => {
    const health = await (await fetch(`${h.base}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, runtimes: 1, defaultRuntime: 'mock', skillsError: null });
    const listed = await (await fetch(`${h.base}/api/runtimes`)).json();
    expect(listed.items).toEqual([expect.objectContaining({ id: 'mock', status: 'ready', source: 'file', defaultModel: 'mock-fast' })]);
    expect(JSON.stringify(listed)).not.toContain(mock.url);
  });

  it('hot-plugs a runtime in and out while running, and routes a pinned node to it', async () => {
    const added = await post(h.base, '/api/runtimes', { id: 'spare', url: spare.url, label: 'Spare' });
    expect(added.status).toBe(201);
    expect((await added.json()).runtime).toMatchObject({ id: 'spare', status: 'ready', source: 'api' });
    const catalog = await (await fetch(`${h.base}/api/runtimes/spare/models`)).json();
    expect(catalog.models).toEqual(['mock-fast', 'mock-thinker']);
    expect(catalog.model_capabilities['mock-thinker'].effort_levels).toEqual(['low', 'high']);

    const node = { ...readyNode('general', 'Check the spare runtime'), runtime: 'spare' };
    const run = await runToEnd(h.base, documentOf(node));
    expect(run.status).toBe('completed');
    expect(run.nodes[node.id]).toMatchObject({ state: 'done', runtime: 'spare', model: 'mock-fast' });

    // A runtime from runtimes.json is removed by editing the file; the plugged-in one through the API.
    expect((await fetch(`${h.base}/api/runtimes/mock`, { method: 'DELETE' })).status).toBe(409);
    expect((await fetch(`${h.base}/api/runtimes/spare`, { method: 'DELETE' })).status).toBe(200);
    const after = await (await fetch(`${h.base}/api/runtimes`)).json();
    expect(after.items.map((item: { id: string }) => item.id)).toEqual(['mock']);
    // Once unplugged it is refused at admission, never silently replaced by another runtime.
    const refused = await post(h.base, '/api/graph-runs', { document: documentOf(node) });
    expect(refused.status).toBe(503);
    expect((await refused.json()).code).toBe('runtime_unavailable');
  });

  it('plans an empty canvas, and the applied plan runs end to end offline', async () => {
    const response = await post(h.base, '/api/plan', { prompt: 'A launch page for a coffee subscription', context: buildPlanningContext(emptyDocument(), [], 'en') });
    const stream = frames(await response.text());
    // Progress is throttled to one frame per 200 ms; the stage changes around the call are always sent.
    const stages = stream.filter(frame => frame.type === 'progress').map(frame => frame.stage);
    expect(stages).toEqual(expect.arrayContaining(['queued', 'running', 'validating']));
    const proposal = stream.at(-1);
    expect(proposal).toMatchObject({ type: 'plan', provider: 'mock' });
    const applied = applyCanvasPlan(emptyDocument(), parseCanvasPlan(proposal.plan), 'en');
    expect(applied.addedNodeIds).toHaveLength(3);
    expect(applied.doc.edges).toHaveLength(2);

    const run = await runToEnd(h.base, applied.doc);
    expect(run.status, JSON.stringify(run.events.filter((event: Frame) => event.type === 'node' && event.status.detail))).toBe('completed');
    expect(run.summary).toMatchObject({ ok: true, done: 3, failed: 0, blocked: 0 });
    for (const id of applied.addedNodeIds) expect(run.nodes[id].output.length).toBeGreaterThan(0);
    expect(run.events.some((event: Frame) => event.type === 'delta')).toBe(true);
  });

  it('runs only the scoped node and reuses stored upstream output', async () => {
    const upstream = readyNode('general', 'Upstream', 0);
    const downstream = createAgentTemplate('review', { x: 700, y: 0 }, 'en');
    const planned = applyCanvasPlan(documentOf(upstream, downstream), parseCanvasPlan({ version: 1, summary: 'wire', operations: [
      { type: 'connect', fromNode: upstream.id, fromField: 'result', toNode: downstream.id, toField: 'delivery' },
    ] }), 'en').doc;
    const withOutput = { ...planned, nodes: planned.nodes.map(node => node.id === upstream.id
      ? { ...node, lastOutput: { text: JSON.stringify({ result: 'Stored result', followups: '' }), at: Date.now(), source: 'run' as const } } : node) };
    const run = await runToEnd(h.base, withOutput, [downstream.id]);
    expect(run.status).toBe('completed');
    expect(run.nodes[upstream.id]).toMatchObject({ state: 'cached' });
    expect(run.nodes[downstream.id]).toMatchObject({ state: 'done' });
  });

  it('replays an accepted run for the same operation and refuses a different one', async () => {
    const document = documentOf(readyNode('general', 'Idempotency check'));
    const operationId = `op-${randomUUID()}`;
    const first = await post(h.base, '/api/graph-runs', { document, operationId });
    expect(first.status).toBe(202);
    const firstRun = (await first.json()).run;
    const again = await post(h.base, '/api/graph-runs', { document, operationId });
    expect(again.status).toBe(200);
    expect((await again.json()).run.id).toBe(firstRun.id);
    const changed = documentOf({ ...document.nodes[0] as SessionNode, title: 'Changed' });
    const conflict = await post(h.base, '/api/graph-runs', { document: changed, operationId });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('idempotency_conflict');
    await (await fetch(`${h.base}/api/graph-runs/${firstRun.id}/events`)).text();
  });

  it('refuses a graph before any model call when a required input is empty or a model is unknown', async () => {
    const empty = await post(h.base, '/api/graph-runs', { document: documentOf(createAgentTemplate('general', { x: 0, y: 0 }, 'en')) });
    expect(empty.status).toBe(400);
    expect((await empty.json()).code).toBe('preflight_missing_inputs');
    const unknown = await post(h.base, '/api/graph-runs', { document: documentOf({ ...readyNode('general', 'x'), model: 'gpt-imaginary' }) });
    expect(unknown.status).toBe(409);
    expect((await unknown.json()).code).toBe('model_unavailable');
  });

  it('runs a bounded review loop: the reviewer rejects round 1, the producer revises, round 2 is approved', async () => {
    const producer = readyNode('general', 'Write a product tagline');
    const { doc } = addReviewPartner(documentOf(producer), producer.id, 'en');
    const run = await runToEnd(h.base, doc);
    expect(run.status).toBe('completed');
    expect(run.summary.review).toEqual({ rounds: 2, outcome: 'approved' });
    expect(run.events.filter((event: Frame) => event.type === 'round').map((event: Frame) => event.round)).toEqual([1, 2]);
  });

  it('executes a node team in review mode and reports each member turn', async () => {
    const base = readyNode('general', 'Draft release notes');
    const node: SessionNode = { ...base, team: { ...createNodeTeam(base, 'en', 'mock'), mode: 'review', maxRounds: 3, maxTurns: 12 } };
    const run = await runToEnd(h.base, documentOf(node));
    expect(run.status).toBe('completed');
    const turns = run.events.filter((event: Frame) => event.type === 'turn' && event.turn.status === 'completed').map((event: Frame) => event.turn.purpose);
    // As in AwwO's teams.go, a producer turn in review mode is always 'revise' ("produce or improve").
    expect(turns).toEqual(['revise', 'review', 'revise', 'review']);
  });

  it('routes canvas edits by rule and work by the router model', async () => {
    const canvas = { nodes: 1, titles: ['Writer'], results: false };
    const ask = async (message: string) => (await post(h.base, '/api/assistant/route', { message, routes: ['plan', 'execute'], canvas, recent: [] })).json();
    expect(await ask('Add a frontend node to the canvas')).toEqual({ route: 'plan', basis: 'rule' });
    expect(await ask('Translate this sentence into French')).toEqual({ route: 'execute', basis: 'model' });
    // Negated wording never takes the rule path.
    expect((await ask("Don't add a node, just summarise the brief")).basis).not.toBe('rule');
  });

  it('streams a direct run with the execute-route skill', async () => {
    const stream = frames(await (await post(h.base, '/api/runs', { prompt: 'Summarise: canvases make agent work visible.', purpose: 'execute' })).text());
    expect(stream[0]).toMatchObject({ type: 'started', runtime: 'mock', model: 'mock-fast' });
    const done = stream.at(-1);
    expect(done.type).toBe('completed');
    expect(stream.filter(frame => frame.type === 'delta').map(frame => frame.delta).join('')).toBe(done.text);
  });

  it('refuses writes from a foreign origin and requests for an unknown host', async () => {
    const body = JSON.stringify({ prompt: 'x' });
    expect(await raw(h.port, { method: 'POST', path: '/api/runs', body,
      headers: { host: `127.0.0.1:${h.port}`, origin: 'https://attacker.example', 'content-type': 'application/json' } })).toBe(403);
    expect(await raw(h.port, { method: 'GET', path: '/api/runtimes', headers: { host: `rebind.example:${h.port}` } })).toBe(421);
    expect(await raw(h.port, { method: 'POST', path: '/api/runtimes', body: '{}', headers: { host: `127.0.0.1:${h.port}`, 'content-type': 'text/plain' } })).toBe(415);
  });

  it('hot-reloads an edited skill and keeps the last good version when an edit breaks it', async () => {
    const file = path.join(h.dir, 'skills', 'assistant-router', 'SKILL.md');
    const original = readFileSync(file, 'utf8');
    const waitFor = async (check: () => boolean) => {
      for (let attempt = 0; attempt < 60 && !check(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
      return check();
    };
    writeFileSync(file, original.replace('### block: execute-system\n```text\n', '### block: execute-system\n```text\nEDITED. '));
    expect(await waitFor(() => h.skills.block('assistant-router', 'execute-system').startsWith('EDITED. '))).toBe(true);
    writeFileSync(file, original.replace(/### block: execute-system[\s\S]*?\n```\n/, ''));
    expect(await waitFor(() => h.skills.lastError !== null)).toBe(true);
    expect(h.skills.block('assistant-router', 'execute-system').startsWith('EDITED. ')).toBe(true);
    writeFileSync(file, original);
    expect(await waitFor(() => h.skills.lastError === null)).toBe(true);
  });
});
