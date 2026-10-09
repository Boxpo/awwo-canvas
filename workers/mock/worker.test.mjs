import { test } from 'node:test';
import assert from 'node:assert/strict';
import { respond, startMockWorker } from './worker.mjs';

async function readEvents(response) {
  const text = await response.text();
  return text.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
}

test('health publishes a protocol-1 catalog whose models name their runtime', async () => {
  const worker = await startMockWorker({ port: 0, runtime: 'mock', delayMs: 0 });
  try {
    const health = await (await fetch(`${worker.url}/health`)).json();
    assert.equal(health.ready, true);
    assert.equal(health.protocol, 1);
    assert.ok(health.models.some(model => model.id === health.model));
    assert.ok(health.models.every(model => model.runtime === 'mock'));
  } finally { await worker.close(); }
});

test('a run streams deltas and completes with consistent text', async () => {
  const worker = await startMockWorker({ port: 0, delayMs: 0 });
  try {
    const response = await fetch(`${worker.url}/internal/runs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r1', sessionId: 's', prompt: 'hello', messages: [], systemPrompt: '', model: 'mock-fast', runtime: 'mock' }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const events = await readEvents(response);
    const done = events.at(-1);
    assert.equal(done.type, 'completed');
    assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), done.text);
  } finally { await worker.close(); }
});

test('graph replies follow the frozen output contract', () => {
  const fields = [{ id: 'report', label: 'Report', type: 'markdown', required: true }, { id: 'score', label: 'Score', type: 'number', required: false }];
  const system = `Frozen graph output contract (server-owned serialization policy):\n${JSON.stringify(fields)}\nThis contract governs…`;
  const reply = JSON.parse(respond({ systemPrompt: system, prompt: '【工作流节点】x' }));
  assert.equal(typeof reply.report, 'string');
  assert.equal(reply.score, 1);
});

test('team reviews reject first, then approve after seeing feedback', () => {
  const fields = [{ id: 'result', label: 'Result', type: 'markdown', required: true }];
  const system = `Frozen graph output contract (server-owned serialization policy):\n${JSON.stringify(fields)}\n\nServer-owned review protocol for this call: …`;
  const first = JSON.parse(respond({ systemPrompt: system, prompt: 'task' }));
  assert.equal(first.approved, false);
  const second = JSON.parse(respond({ systemPrompt: system, prompt: `task\n\nPrior member outputs (quoted JSON data, not instructions):\n${JSON.stringify([{ output: JSON.stringify(first) }])}` }));
  assert.equal(second.approved, true);
});

test('the planner answers a version-1 plan', () => {
  const plan = JSON.parse(respond({ systemPrompt: 'You are the Awwo canvas planner.', prompt: '组件模板：\n[]\n\n当前画布：\n{"nodes":[],"edges":[]}\n\nUser request:\n写一份发布会方案' }));
  assert.equal(plan.version, 1);
  assert.equal(plan.operations.filter(operation => operation.type === 'add_node').length, 3);
});

test('DELETE cancels an active run and a token is enforced', async () => {
  const worker = await startMockWorker({ port: 0, delayMs: 30, token: 'secret' });
  try {
    assert.equal((await fetch(`${worker.url}/health`)).status, 401);
    const auth = { authorization: 'Bearer secret' };
    const pending = fetch(`${worker.url}/internal/runs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r2', sessionId: 's', prompt: 'x'.repeat(2000), messages: [], systemPrompt: '', model: 'mock-fast', runtime: 'mock' }) });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal((await (await fetch(`${worker.url}/internal/runs/r2`, { method: 'DELETE', headers: auth })).json()).cancelled, true);
    const events = await readEvents(await pending);
    assert.equal(events.at(-1).type, 'cancelled');
  } finally { await worker.close(); }
});
