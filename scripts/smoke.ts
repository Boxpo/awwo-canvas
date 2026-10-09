// Offline end-to-end smoke test of the whole stack. It starts mock workers and the REAL orchestrator
// (apps/server/src/main.ts) on loopback, then drives the same HTTP API the canvas uses: health, the
// hot-plug registry (a worker joins while the orchestrator runs, serves a task, and is unplugged),
// the origin guard, routing, planning, and graph runs of every example canvas, including the
// two-round review loop. Last, it checks the built canvas is served. Run: `npm run smoke`.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantRouteRequest } from '@awwo/core/assistantRoute';
import { emptyDocument, type CanvasDocument } from '@awwo/core/canvasDoc';
import { applyCanvasPlan, parseCanvasPlan } from '@awwo/core/canvasPlan';
import { buildPlanningContext } from '@awwo/core/planningContext';
import { exampleDocument } from '../apps/web/src/examples';
import { startMockWorker, type MockWorker } from '../workers/mock/worker.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.AWWO_SMOKE_PORT || 18787);
const base = `http://127.0.0.1:${port}`;
let passed = 0;
const ok = (message: string) => { passed += 1; console.log(`ok   ${message}`); };
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> {
  const response = await fetch(base + pathname, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  return { status: response.status, body: await response.json().catch(() => ({})) as Json };
}
const post = (pathname: string, body: unknown, headers: Record<string, string> = {}) =>
  call(pathname, { method: 'POST', body: JSON.stringify(body), headers });

/** Read an event stream to its end (the server closes it on a terminal frame). */
async function frames(pathname: string, body?: unknown): Promise<Json[]> {
  const response = await fetch(base + pathname, body === undefined ? {} : {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  assert(response.ok, `${pathname}: HTTP ${response.status}`);
  return (await response.text()).split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
    .filter(Boolean).map(data => JSON.parse(data) as Json);
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function runGraph(document: CanvasDocument) {
  const { status, body } = await post('/api/graph-runs', { document, operationId: `smoke-${randomUUID()}` });
  assert(status === 202, `graph run not admitted: HTTP ${status} ${JSON.stringify(body)}`);
  const events = await frames(`/api/graph-runs/${body.run.id}/events?after=0`);
  const { body: final } = await call(`/api/graph-runs/${body.run.id}`);
  return { run: final.run as Json, events };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'awwo-smoke-'));
  const workers: MockWorker[] = [await startMockWorker({ port: 0, host: '127.0.0.1', runtime: 'mock', delayMs: 1 })];
  const runtimesFile = path.join(dir, 'runtimes.json');
  writeFileSync(runtimesFile, JSON.stringify({ defaultRuntime: 'mock', runtimes: [{ id: 'mock', label: 'Mock', url: workers[0].url }] }));
  const server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, AWWO_HOST: '127.0.0.1', AWWO_PORT: String(port), AWWO_API_TOKEN: '', AWWO_RUNTIMES_FILE: runtimesFile, AWWO_PROBE_INTERVAL_MS: '500' },
  });
  let log = '';
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  try {
    const health = await waitFor('the orchestrator', async () => {
      const { body } = await call('/api/health');
      return body.ok && body.runtimes >= 1 ? body : undefined;
    });
    assert(!health.skillsError, `skills failed to load: ${health.skillsError}`);
    ok(`orchestrator ${health.version} is up; default runtime "${health.defaultRuntime}"`);

    // Hot-plug: a worker that did not exist when the orchestrator started.
    workers.push(await startMockWorker({ port: 0, host: '127.0.0.1', runtime: 'mock2', delayMs: 1 }));
    const plugged = await post('/api/runtimes', { id: 'mock2', url: workers[1].url, label: 'Mock 2' });
    assert(plugged.status === 201, `hot-plug refused: ${JSON.stringify(plugged.body)}`);
    await waitFor('mock2 to be ready', async () => {
      const { body } = await call('/api/runtimes');
      return (body.items as Json[]).find(item => item.id === 'mock2' && item.status === 'ready');
    });
    ok('hot-plug: a second worker joined the running orchestrator');
    const task = await frames('/api/runs', { prompt: 'Summarise what a review loop is in one line.', purpose: 'execute', runtime: 'mock2' });
    assert(task.at(-1)?.type === 'completed' && task.at(-1)?.runtime === 'mock2', `direct task: ${JSON.stringify(task.at(-1))}`);
    ok(`direct task streamed ${task.filter(frame => frame.type === 'delta').length} deltas on the hot-plugged runtime`);
    const unplugged = await call('/api/runtimes/mock2', { method: 'DELETE' });
    assert(unplugged.status === 200, `unplug: HTTP ${unplugged.status}`);
    const after = await call('/api/runtimes');
    assert(!(after.body.items as Json[]).some(item => item.id === 'mock2'), 'mock2 still listed after unplug');
    ok('unplug: the runtime left the registry');

    const foreign = await post('/api/runtimes', { id: 'evil', url: 'http://127.0.0.1:1' }, { origin: 'https://evil.example' });
    assert(foreign.status === 403, `a cross-origin write was not refused: HTTP ${foreign.status}`);
    ok('origin guard: a write from a foreign page is refused');

    const route = await post('/api/assistant/route', assistantRouteRequest('Add a reviewer node to the canvas', ['plan', 'execute'], emptyDocument(), []));
    assert(route.body.route === 'plan', `router: ${JSON.stringify(route.body)}`);
    ok(`router: a canvas edit routes to plan (basis: ${route.body.basis})`);

    const planFrames = await frames('/api/plan', { prompt: 'A landing page for a coffee subscription, checked by a reviewer.',
      context: buildPlanningContext(emptyDocument(), [], 'en') });
    const proposal = planFrames.find(frame => frame.type === 'plan');
    assert(proposal, `planner: ${JSON.stringify(planFrames.at(-1))}`);
    const applied = applyCanvasPlan(emptyDocument(), parseCanvasPlan(proposal.plan), 'en');
    assert(applied.doc.nodes.length > 0, 'the plan added no node');
    ok(`planner: ${applied.doc.nodes.length} nodes, ${applied.doc.edges.length} wires, ${planFrames.filter(frame => frame.type === 'progress').length} progress frames`);

    for (const id of ['workflow', 'review', 'team'] as const) {
      const { run, events } = await runGraph(exampleDocument(id, 'en'));
      const states = Object.values(run.nodes as Record<string, Json>).map(node => node.state);
      assert(run.status === 'completed', `"${id}" run ended ${run.status}: ${run.error ?? JSON.stringify(run.nodes)}`);
      assert(states.length > 0 && states.every(state => state === 'done'), `"${id}" node states: ${states.join(', ')}`);
      if (id === 'review') {
        assert(run.summary?.review?.outcome === 'approved' && run.summary.review.rounds >= 2, `review loop: ${JSON.stringify(run.summary)}`);
      }
      ok(`graph run "${id}": ${states.length} nodes done${run.summary?.review ? `, approved in round ${run.summary.review.rounds}` : ''} (${events.length} events)`);
    }

    if (existsSync(path.join(root, 'apps/web/dist/index.html'))) {
      const page = await fetch(`${base}/`);
      const html = await page.text();
      const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
      assert(page.ok && script, 'the canvas page is not served');
      assert((await fetch(base + script)).ok, `the canvas bundle ${script} is not served`);
      ok('the built canvas is served on the orchestrator port');
    } else console.log('skip the canvas is not built (npm run build)');
    console.log(`\nsmoke passed: ${passed} checks`);
  } catch (error) {
    console.error(`\nsmoke FAILED: ${error instanceof Error ? error.message : String(error)}\n--- orchestrator log ---\n${log}`);
    process.exitCode = 1;
  } finally {
    server.kill();
    await Promise.all(workers.map(worker => worker.close()));
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
