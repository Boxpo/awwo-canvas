// node --test worker.test.mjs — runs against a local fake provider; no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { configFromEnv, createOpenAiWorker } from './worker.mjs';

async function fakeProvider(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    await handler(req, res, body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

const sse = frames => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
const events = text => text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, '')));

async function withWorker(provider, run, extra = {}) {
  const config = configFromEnv({ AWWO_OPENAI_BASE_URL: provider.url, AWWO_OPENAI_API_KEY: 'test-key', AWWO_OPENAI_MODELS: 'model-a,model-b',
    AWWO_OPENAI_EFFORTS: 'low,high', AWWO_OPENAI_THINKING_TOGGLE: '1', AWWO_OPENAI_WORKER_PORT: '0', ...extra });
  const worker = createOpenAiWorker(config);
  const url = await worker.listen();
  try { await run(url); } finally { await worker.close(); await provider.close(); }
}

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('health advertises the configured catalog under its own runtime id', async () => {
  const provider = await fakeProvider((_req, res) => res.end('{}'));
  await withWorker(provider, async url => {
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.ready, true);
    assert.equal(health.runtime, 'openai');
    assert.equal(health.model, 'model-a');
    assert.deepEqual(health.models.map(model => model.id), ['model-a', 'model-b']);
    assert.ok(health.models.every(model => model.runtime === 'openai' && model.reasoningEfforts.join() === 'low,high'));
    assert.deepEqual(health.completionOptions, ['maxTokens', 'thinking']);
    assert.equal(provider.requests.length, 0, 'an explicit catalog needs no discovery call');
  });
});

test('a run streams deltas, completes with the full text, and keeps reasoning text inside the worker', async () => {
  const provider = await fakeProvider((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([{ choices: [{ delta: { reasoning_content: 'secret chain of thought' } }] }, { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] }]) + 'data: [DONE]\n\n');
  });
  await withWorker(provider, async url => {
    const response = await post(`${url}/internal/runs`, { runId: 'run-1', sessionId: 's', prompt: 'Hi', messages: [{ role: 'assistant', content: 'earlier' }],
      systemPrompt: 'Be brief.', model: 'model-b', runtime: 'openai', effort: 'high' });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('secret'), 'reasoning text must never be streamed');
    assert.deepEqual(events(text), [{ type: 'text_delta', delta: 'Hel' }, { type: 'text_delta', delta: 'lo' }, { type: 'completed', text: 'Hello' }]);
    const call = provider.requests[0];
    assert.equal(call.auth, 'Bearer test-key');
    assert.equal(call.body.model, 'model-b');
    assert.equal(call.body.reasoning_effort, 'high');
    assert.deepEqual(call.body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'assistant', content: 'earlier' }, { role: 'user', content: 'Hi' }]);
  });
});

test('reasoning size is reported only when the orchestrator asks for it', async () => {
  const provider = await fakeProvider((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([{ choices: [{ delta: { reasoning_content: 'abcd' } }] }, { choices: [{ delta: { content: '{}' } }] }]));
  });
  await withWorker(provider, async url => {
    const response = await post(`${url}/internal/runs`, { runId: 'run-2', prompt: 'plan' }, { 'x-awwo-run-activity': 'reasoning' });
    assert.deepEqual(events(await response.text()), [{ type: 'reasoning', characters: 4 }, { type: 'text_delta', delta: '{}' }, { type: 'completed', text: '{}' }]);
  });
});

test('a provider error becomes a failed event, never a result', async () => {
  const provider = await fakeProvider((_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'rate limited' } })); });
  await withWorker(provider, async url => {
    const response = await post(`${url}/internal/runs`, { runId: 'run-3', prompt: 'x' });
    assert.deepEqual(events(await response.text()), [{ type: 'failed', code: 'upstream_429', message: 'rate limited' }]);
  });
});

test('DELETE stops an in-flight call and the stream ends cancelled', async () => {
  const provider = await fakeProvider((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse([{ choices: [{ delta: { content: 'partial' } }] }]));
    // …and never finishes on its own.
  });
  await withWorker(provider, async url => {
    const response = await post(`${url}/internal/runs`, { runId: 'run-4', prompt: 'long' });
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /partial/);
    const cancel = await (await fetch(`${url}/internal/runs/run-4`, { method: 'DELETE' })).json();
    assert.deepEqual(cancel, { cancelled: true });
    let rest = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    assert.deepEqual(events(rest), [{ type: 'cancelled' }]);
    assert.deepEqual(await (await fetch(`${url}/internal/runs/run-4`, { method: 'DELETE' })).json(), { cancelled: false }, 'cancel is idempotent');
  });
});

test('completions pass maxTokens and the thinking switch through to the provider', async () => {
  const provider = await fakeProvider((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '{"route":"plan"}' } }] })); });
  await withWorker(provider, async url => {
    const response = await post(`${url}/internal/completions`, { runId: 'r', model: 'model-a', thinking: false, maxTokens: 40,
      completion: { messages: [{ role: 'system', content: 'route' }, { role: 'user', content: 'hi' }] } });
    assert.deepEqual(await response.json(), { completion: { choices: [{ message: { content: '{"route":"plan"}' } }] } });
    assert.equal(provider.requests[0].body.max_tokens, 40);
    assert.deepEqual(provider.requests[0].body.thinking, { type: 'disabled' });
    assert.equal(provider.requests[0].body.stream, false);
  });
});

test('unknown models, efforts and runtimes are refused before any provider call', async () => {
  const provider = await fakeProvider((_req, res) => res.end('{}'));
  await withWorker(provider, async url => {
    assert.equal((await post(`${url}/internal/runs`, { runId: 'a', prompt: 'x', model: 'other' })).status, 422);
    assert.equal((await post(`${url}/internal/runs`, { runId: 'b', prompt: 'x', model: 'model-a', effort: 'max' })).status, 422);
    assert.equal((await post(`${url}/internal/runs`, { runId: 'c', prompt: 'x', runtime: 'mock' })).status, 422);
    assert.equal(provider.requests.length, 0);
  });
});

test('without an explicit list the catalog is discovered from GET /models', async () => {
  const provider = await fakeProvider((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }] })); });
  const config = configFromEnv({ AWWO_OPENAI_BASE_URL: provider.url, AWWO_OPENAI_API_KEY: 'k', AWWO_OPENAI_WORKER_PORT: '0', AWWO_OPENAI_MODEL: 'z-model' });
  const worker = createOpenAiWorker(config);
  try {
    await worker.refreshCatalog();
    const health = worker.health();
    assert.deepEqual(health.models.map(model => model.id), ['a-model', 'z-model']);
    assert.equal(health.model, 'z-model');
    assert.equal(provider.requests[0].url, '/v1/models');
  } finally { await provider.close(); }
});

test('a token-protected worker refuses calls without the bearer token', async () => {
  const provider = await fakeProvider((_req, res) => res.end('{}'));
  await withWorker(provider, async url => {
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal((await fetch(`${url}/health`, { headers: { authorization: 'Bearer worker-secret' } })).status, 200);
  }, { AWWO_OPENAI_WORKER_TOKEN: 'worker-secret' });
});
