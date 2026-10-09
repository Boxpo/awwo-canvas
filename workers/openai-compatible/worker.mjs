#!/usr/bin/env node
// AwwO Canvas · OpenAI-compatible worker — worker protocol v1 over any Chat Completions API
// (OpenAI, Azure-style gateways, vLLM, Ollama, LM Studio, one-api/new-api relays, …).
//
// Dependency-free. The orchestrator never sees the provider key: it lives in this process only,
// and every answer the orchestrator receives is the protocol's event stream, nothing provider-shaped.
//   GET    /health                  catalog (models from AWWO_OPENAI_MODELS, else GET {base}/models)
//   POST   /internal/runs           one streamed model call → text/event-stream of WorkerEvent
//   DELETE /internal/runs/{runId}   stop that call (idempotent)
//   POST   /internal/completions    one non-streamed call (the assistant router)
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const list = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);

export function configFromEnv(env = process.env) {
  return {
    baseUrl: (env.AWWO_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env.AWWO_OPENAI_API_KEY || env.OPENAI_API_KEY || '',
    models: list(env.AWWO_OPENAI_MODELS),
    defaultModel: env.AWWO_OPENAI_MODEL || '',
    efforts: list(env.AWWO_OPENAI_EFFORTS),
    thinkingToggle: env.AWWO_OPENAI_THINKING_TOGGLE === '1',
    runtime: env.AWWO_OPENAI_RUNTIME || 'openai',
    host: env.AWWO_OPENAI_WORKER_HOST || '127.0.0.1',
    port: Number(env.AWWO_OPENAI_WORKER_PORT || 8792),
    token: env.AWWO_OPENAI_WORKER_TOKEN || '',
    maxConcurrency: Math.max(1, Number(env.AWWO_OPENAI_MAX_CONCURRENCY || 4)),
    timeoutMs: Math.max(1_000, Number(env.AWWO_OPENAI_TIMEOUT_MS || 600_000)),
  };
}

const upstreamHeaders = config => ({ 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) });

function authorized(req, token) {
  if (!token) return true;
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('body is not JSON'), { status: 400 }); }
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

/** Provider error bodies are echoed only in part: enough to diagnose, never a whole page. */
async function upstreamError(response) {
  const text = await response.text().catch(() => '');
  let message = text;
  try { message = JSON.parse(text)?.error?.message ?? text; } catch { /* keep the text */ }
  return String(message).replace(/\s+/g, ' ').slice(0, 300) || `HTTP ${response.status}`;
}

/** Parse an OpenAI-style SSE stream into JSON chunks; stops at [DONE]. */
async function* chunks(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (!data) continue;
      try { yield JSON.parse(data); } catch { /* a relay's keep-alive or comment */ }
    }
  }
}

export function createOpenAiWorker(config, { fetchImpl = fetch, log = () => {} } = {}) {
  const active = new Map();
  const catalog = { models: [...config.models], error: '', refreshedAt: 0 };

  async function refreshCatalog() {
    if (config.models.length) return;
    if (!config.apiKey && /api\.openai\.com/.test(config.baseUrl)) { catalog.error = 'Set AWWO_OPENAI_API_KEY (or OPENAI_API_KEY)'; return; }
    try {
      const response = await fetchImpl(`${config.baseUrl}/models`, { headers: upstreamHeaders(config), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`GET /models answered ${await upstreamError(response)}`);
      const body = await response.json();
      const ids = (Array.isArray(body?.data) ? body.data : []).map(item => item?.id)
        .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f]/.test(id));
      catalog.models = [...new Set(ids)].sort().slice(0, 64);
      catalog.error = catalog.models.length ? '' : 'The provider listed no models; set AWWO_OPENAI_MODELS';
    } catch (error) {
      catalog.error = `Model discovery failed: ${error.message}`;
    } finally {
      catalog.refreshedAt = Date.now();
    }
  }

  const defaultModel = () => (config.defaultModel && catalog.models.includes(config.defaultModel) ? config.defaultModel : catalog.models[0]) ?? '';

  function health() {
    if (!catalog.models.length) return { ready: false, protocol: 1, runtime: config.runtime, error: catalog.error || 'No models configured' };
    return {
      ready: true, protocol: 1, runtime: config.runtime, model: defaultModel(),
      models: catalog.models.map(id => ({ id, model: id, provider: 'openai-compatible', runtime: config.runtime, label: id,
        maxContextTextBytes: 262_144, messageOverheadBytes: 16, reasoningEfforts: config.efforts })),
      tools: [], maxConcurrency: config.maxConcurrency, activeRuns: active.size,
      completionOptions: ['maxTokens', ...(config.thinkingToggle ? ['thinking'] : [])],
      sdkVersion: `awwo-openai-compatible-worker ${VERSION}`,
    };
  }

  /** Validate a call against the live catalog; returns an error string or null. */
  function refuse(model, effort, runtime) {
    if (runtime && runtime !== config.runtime) return `this worker serves runtime ${config.runtime}`;
    if (!catalog.models.includes(model)) return `unknown model ${model}`;
    if (effort && !config.efforts.includes(effort)) return `model ${model} does not accept effort ${effort}`;
    return null;
  }

  async function run(req, res) {
    const request = await readJson(req);
    if (typeof request.runId !== 'string' || !request.runId || request.runId.length > 200 || typeof request.prompt !== 'string') {
      return json(res, 400, { error: 'runId and prompt are required' });
    }
    const model = typeof request.model === 'string' && request.model ? request.model : defaultModel();
    const effort = typeof request.effort === 'string' ? request.effort : '';
    const refusal = refuse(model, effort, request.runtime);
    if (refusal) return json(res, 422, { error: refusal });
    if (active.has(request.runId)) return json(res, 409, { error: 'run already active' });
    if (active.size >= config.maxConcurrency) return json(res, 429, { error: 'worker at capacity' });

    const controller = new AbortController();
    const entry = { controller, cancelled: false };
    active.set(request.runId, entry);
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    // The request has already emitted 'close' once its body was read; only the response knows the client left.
    res.on('close', () => { if (!res.writableFinished) { entry.cancelled = true; controller.abort(); } });
    const send = event => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const finish = event => { send(event); res.end(); };
    const reportReasoning = req.headers['x-awwo-run-activity'] === 'reasoning';
    const history = Array.isArray(request.messages) ? request.messages.filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string') : [];
    const messages = [
      ...(typeof request.systemPrompt === 'string' && request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
      ...history.map(item => ({ role: item.role, content: item.content })),
      { role: 'user', content: request.prompt },
    ];
    let text = '';
    try {
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST', headers: upstreamHeaders(config), signal: controller.signal,
        body: JSON.stringify({ model, messages, stream: true, ...(effort ? { reasoning_effort: effort } : {}) }),
      });
      if (!response.ok || !response.body) return finish({ type: 'failed', code: `upstream_${response.status}`, message: await upstreamError(response) });
      for await (const chunk of chunks(response.body)) {
        if (chunk?.error) return finish({ type: 'failed', code: 'upstream_error', message: String(chunk.error.message ?? 'provider error').slice(0, 300) });
        const delta = chunk?.choices?.[0]?.delta ?? {};
        const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
        // Reasoning text never leaves the worker; the planner may ask for its size only.
        if (reasoning && reportReasoning) send({ type: 'reasoning', characters: [...reasoning].length });
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
            controller.abort();
            return finish({ type: 'failed', code: 'output_limit', message: 'Model output exceeds 2 MiB' });
          }
          send({ type: 'text_delta', delta: delta.content });
        }
      }
      if (entry.cancelled) return finish({ type: 'cancelled' });
      finish({ type: 'completed', text });
    } catch (error) {
      if (entry.cancelled) return finish({ type: 'cancelled' });
      if (controller.signal.aborted) return finish({ type: 'failed', code: 'timeout', message: `No answer within ${config.timeoutMs} ms` });
      finish({ type: 'failed', code: 'upstream_unreachable', message: String(error?.message ?? error).slice(0, 300) });
    } finally {
      clearTimeout(timeout);
      active.delete(request.runId);
    }
  }

  async function complete(req, res) {
    const body = await readJson(req);
    const model = typeof body.model === 'string' && body.model ? body.model : defaultModel();
    const effort = typeof body.effort === 'string' ? body.effort : '';
    const refusal = refuse(model, effort);
    if (refusal) return json(res, 422, { error: refusal });
    const messages = Array.isArray(body?.completion?.messages) ? body.completion.messages
      .filter(item => item && ['system', 'user', 'assistant'].includes(item.role) && typeof item.content === 'string')
      .map(item => ({ role: item.role, content: item.content })) : [];
    if (!messages.length) return json(res, 400, { error: 'completion.messages is required' });
    const maxTokens = Number.isInteger(body.maxTokens) && body.maxTokens > 0 ? Math.min(body.maxTokens, 32_768) : undefined;
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST', headers: upstreamHeaders(config), signal: AbortSignal.timeout(Math.min(config.timeoutMs, 120_000)),
      body: JSON.stringify({ model, messages, stream: false,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(config.thinkingToggle && body.thinking === false ? { thinking: { type: 'disabled' } } : {}) }),
    });
    if (!response.ok) return json(res, 502, { error: await upstreamError(response) });
    const parsed = await response.json();
    const content = parsed?.choices?.[0]?.message?.content;
    json(res, 200, { completion: { choices: [{ message: { content: typeof content === 'string' ? content : null } }] } });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://worker.local');
    if (!authorized(req, config.token)) return json(res, 401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        if (!config.models.length && Date.now() - catalog.refreshedAt > 600_000) await refreshCatalog();
        return json(res, 200, health());
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/internal/runs/')) {
        const entry = active.get(decodeURIComponent(url.pathname.slice('/internal/runs/'.length)));
        if (entry) { entry.cancelled = true; entry.controller.abort(); }
        return json(res, 200, { cancelled: Boolean(entry) });
      }
      if (req.method === 'POST' && url.pathname === '/internal/runs') return await run(req, res);
      if (req.method === 'POST' && url.pathname === '/internal/completions') return await complete(req, res);
      json(res, 404, { error: 'not found' });
    } catch (error) {
      log(`request failed: ${error.message}`);
      if (!res.headersSent) json(res, error.status ?? 502, { error: String(error.message).slice(0, 300) });
      else res.end();
    }
  });

  return {
    server,
    health,
    refreshCatalog,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        const address = server.address();
        resolve(`http://${config.host}:${typeof address === 'object' && address ? address.port : config.port}`);
      });
    }),
    close: () => new Promise(done => server.close(done)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = configFromEnv();
  if (!LOOPBACK.has(config.host) && !config.token) {
    console.error(`[openai-worker] refusing to bind ${config.host} without AWWO_OPENAI_WORKER_TOKEN`);
    process.exit(1);
  }
  const worker = createOpenAiWorker(config, { log: message => console.log(`[openai-worker] ${message}`) });
  await worker.refreshCatalog();
  const url = await worker.listen();
  const state = worker.health();
  console.log(`[openai-worker] runtime "${config.runtime}" on ${url} -> ${config.baseUrl}`);
  console.log(state.ready ? `[openai-worker] models: ${state.models.map(model => model.id).join(', ')}` : `[openai-worker] not ready: ${state.error}`);
}
