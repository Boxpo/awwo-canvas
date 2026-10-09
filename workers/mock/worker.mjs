#!/usr/bin/env node
// AwwO Canvas · mock worker — a complete, dependency-free implementation of worker protocol v1.
//
// It calls no model. It answers deterministically from what the orchestrator sends, which makes
// the whole canvas usable offline and doubles as the reference for writing a real worker:
//   - graph nodes: reads the frozen output contract from the system prompt and returns a reply in
//     exactly that shape (keyed JSON, or plain text for a single text field);
//   - team reviews: returns the strict {approved, output, feedback} verdict (rejects round 1,
//     approves once it sees its own earlier feedback, so the review loop is visible);
//   - review graphs: the final reviewer's boolean verdict is false in round 1, true afterwards;
//   - the planner: builds a real version-1 plan from the templates and canvas in the context;
//   - the router (/internal/completions): answers {"route":"plan"|"execute"}.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';

function models(runtime) {
  return [
    { id: 'mock-fast', model: 'mock-fast', provider: 'mock', runtime, label: 'Mock · fast',
      maxContextTextBytes: 262144, messageOverheadBytes: 16, reasoningEfforts: [] },
    { id: 'mock-thinker', model: 'mock-thinker', provider: 'mock', runtime, label: 'Mock · thinks first',
      maxContextTextBytes: 262144, messageOverheadBytes: 16, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' },
  ];
}

const zhText = text => /[\u4e00-\u9fff]/.test(text);
const clip = (text, max) => { const chars = [...String(text)]; return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join(''); };

/** The JSON array that follows `header` on the next line (the orchestrator writes it on one line). */
function jsonAfter(text, header) {
  const index = text.indexOf(header);
  if (index < 0) return undefined;
  const line = text.slice(index + header.length).split('\n').find(item => item.trim());
  try { return JSON.parse(line); } catch { return undefined; }
}

function firstInputSnippet(prompt) {
  const match = prompt.match(/【输入 · [^\n]*】\n(?:字段说明：[^\n]*\n)?([\s\S]*?)(?=\n\n【|$)/);
  const upstream = prompt.match(/【上游输入 · [^\n]*】\n([\s\S]*?)(?=\n\n【|$)/);
  return clip(((match?.[1] ?? upstream?.[1]) || prompt).trim().replace(/\s+/g, ' '), 160);
}

function fieldValue(field, context) {
  const zh = context.zh;
  switch (field.type) {
    case 'number': return 1;
    case 'boolean': return context.verdict ?? true;
    case 'html': return `<!doctype html><html><head><meta charset="utf-8"><title>${field.label}</title></head><body><h1>${field.label}</h1><p>${zh ? 'Mock 运行时生成的示例页面。' : 'Example page from the mock runtime.'}</p></body></html>`;
    case 'file': return `mock://${field.id}.txt`;
    default:
      if (context.feedbackField === field.id) return zh ? '第 1 轮反馈（Mock）：请补充可复核的验收证据后再提交。' : 'Round 1 feedback (mock): add checkable evidence before resubmitting.';
      return zh
        ? `### ${field.label}\n\n（Mock 运行时生成的演示内容，未调用真实模型。）\n\n依据输入：${context.snippet}`
        : `### ${field.label}\n\n(Demo content from the mock runtime; no model was called.)\n\nBased on: ${context.snippet}`;
  }
}

function contractReply(fields, context) {
  if (fields.length === 1 && ['text', 'markdown', 'html'].includes(fields[0].type)) return String(fieldValue(fields[0], context));
  return JSON.stringify(Object.fromEntries(fields.map(field => [field.id, fieldValue(field, context)])));
}

function plannerReply(prompt) {
  const zh = prompt.includes('组件模板');
  const canvas = jsonAfter(prompt, zh ? '当前画布：' : 'Current canvas:') ?? { nodes: [], edges: [] };
  const request = (prompt.split('\n\nUser request:\n').at(-1) ?? '').trim();
  const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
  if (nodes.length === 0) {
    return JSON.stringify({
      version: 1,
      summary: zh ? `离线 Mock 规划：为「${clip(request, 40)}」搭建 3 个节点（梳理目标 → 制作交付 → 交付验收）。接入真实模型后，方案会按目标定制。`
        : `Offline mock plan for "${clip(request, 40)}": three nodes (clarify → produce → review). A real model tailors the plan to the goal.`,
      operations: [
        { type: 'add_node', ref: 'goal', templateId: 'general', title: zh ? '梳理目标' : 'Clarify the goal', inputValues: { brief: clip(request, 4000) } },
        { type: 'add_node', ref: 'make', templateId: 'materials', title: zh ? '制作交付' : 'Produce the deliverable' },
        { type: 'add_node', ref: 'check', templateId: 'review', title: zh ? '交付验收' : 'Review the delivery' },
        { type: 'connect', fromNode: 'goal', fromField: 'result', toNode: 'make', toField: 'brief' },
        { type: 'connect', fromNode: 'make', fromField: 'assets', toNode: 'check', toField: 'delivery' },
      ],
    });
  }
  const edges = Array.isArray(canvas.edges) ? canvas.edges : [];
  const textual = field => ['text', 'markdown', 'html'].includes(field?.type);
  const sink = nodes.find(node => Array.isArray(node.outputs) && node.outputs.some(textual) && !edges.some(edge => edge.fromNode === node.id));
  if (!sink) {
    return JSON.stringify({ version: 1, operations: [],
      summary: zh ? '离线 Mock 规划：没有找到可以接入验收的文本输出。请说明要在哪个节点后面增加步骤。' : 'Offline mock plan: no text output to review. Which node should the new step follow?' });
  }
  const output = sink.outputs.find(textual);
  return JSON.stringify({
    version: 1,
    summary: zh ? `离线 Mock 规划：在「${sink.title}」之后增加一个交付验收节点。` : `Offline mock plan: add a delivery review after "${sink.title}".`,
    operations: [
      { type: 'add_node', ref: 'review', templateId: 'review', title: zh ? '补充验收' : 'Extra review' },
      { type: 'connect', fromNode: sink.id, fromField: output.id, toNode: 'review', toField: 'delivery' },
    ],
  });
}

function routeReply(messages) {
  const user = messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
  const message = user.split('Message to route:\n').at(-1) ?? user;
  const canvasWords = /(画布|节点|工作流|编排|canvas|node|workflow|agent)/i;
  const workWords = /(写|翻译|总结|计算|改写|润色|生成一[篇份段]|write|translate|summari[sz]e|calculate|draft|rewrite)/i;
  return JSON.stringify({ route: workWords.test(message) && !canvasWords.test(message) ? 'execute' : 'plan' });
}

/** Decide the full answer for one /internal/runs request. */
export function respond(request) {
  const system = String(request.systemPrompt ?? '');
  const prompt = String(request.prompt ?? '');
  const zh = zhText(prompt) || zhText(system);
  if (/canvas planner/i.test(system)) return plannerReply(prompt);
  const fields = jsonAfter(system, 'Frozen graph output contract (server-owned serialization policy):');
  const snippet = firstInputSnippet(prompt);
  if (system.includes('Server-owned review protocol')) {
    const sawFeedback = prompt.includes('"approved":false') || prompt.includes('\\"approved\\":false');
    const deliverable = Array.isArray(fields) ? contractReply(fields, { zh, snippet }) : snippet;
    return JSON.stringify(sawFeedback
      ? { approved: true, output: deliverable, feedback: '' }
      : { approved: false, output: deliverable, feedback: zh ? '（Mock）请补充可复核的证据后再交付。' : '(mock) Add checkable evidence, then deliver again.' });
  }
  if (Array.isArray(fields)) {
    const round = prompt.match(/【Agent Graph · 第 (\d+)\/(\d+) 轮】/);
    const verdictId = prompt.match(/输出字段 ("[^"]+") 必须是 JSON 布尔值/);
    const context = { zh, snippet };
    if (round && verdictId) {
      const firstRound = Number(round[1]) === 1;
      context.verdict = !firstRound;
      if (firstRound) context.feedbackField = fields.find(field => field.type !== 'boolean' && /feedback|issue|反馈|意见|问题/i.test(`${field.id} ${field.label}`))?.id;
    }
    return contractReply(fields, context);
  }
  return zh
    ? `（Mock 运行时）收到：「${clip(prompt, 200)}」\n\n这是离线演示回复，没有调用真实模型。启动 openai-compatible worker 并在节点里选择它，即可换成真实模型。`
    : `(Mock runtime) Received: "${clip(prompt, 200)}"\n\nThis is an offline demo reply; no model was called. Start the openai-compatible worker and select it on a node to use a real model.`;
}

function authorized(req, token) {
  if (!token) return true;
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readBody(req, max = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function startMockWorker({ port = 8791, host = '127.0.0.1', token = '', runtime = 'mock', delayMs = 12 } = {}) {
  const active = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://worker.local');
    if (!authorized(req, token)) return json(res, 401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ready: true, protocol: 1, runtime, model: 'mock-fast', models: models(runtime),
          tools: [{ id: 'current_time', contextTextBytes: 256, description: 'Current UTC time' }],
          maxConcurrency: 8, activeRuns: active.size, completionOptions: ['thinking', 'maxTokens'], sdkVersion: `awwo-mock-worker ${VERSION}` });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/internal/runs/')) {
        const run = active.get(decodeURIComponent(url.pathname.slice('/internal/runs/'.length)));
        if (run) run.cancelled = true;
        return json(res, 200, { cancelled: Boolean(run) });
      }
      if (req.method === 'POST' && url.pathname === '/internal/completions') {
        const body = await readBody(req);
        const messages = Array.isArray(body?.completion?.messages) ? body.completion.messages : [];
        const system = messages.find(message => message.role === 'system')?.content ?? '';
        const content = /You route one message/.test(system) ? routeReply(messages) : respond({ systemPrompt: system, prompt: messages.at(-1)?.content ?? '' });
        return json(res, 200, { completion: { choices: [{ message: { content } }] } });
      }
      if (req.method === 'POST' && url.pathname === '/internal/runs') {
        const request = await readBody(req);
        if (typeof request.runId !== 'string' || typeof request.prompt !== 'string') return json(res, 400, { error: 'runId and prompt are required' });
        if (request.runtime && request.runtime !== runtime) return json(res, 422, { error: `this worker serves runtime ${runtime}` });
        if (request.model && !models(runtime).some(model => model.id === request.model)) return json(res, 422, { error: `unknown model ${request.model}` });
        if (active.has(request.runId)) return json(res, 409, { error: 'run already active' });
        const run = { cancelled: false };
        active.set(request.runId, run);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        // On Node >= 16 the REQUEST emits 'close' as soon as its body has been read, so only the
        // response tells a dropped client apart from a finished stream.
        res.on('close', () => { if (!res.writableFinished) run.cancelled = true; });
        const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
        let text = respond(request);
        if (request.model === 'mock-thinker') {
          const thought = '先确认输入与输出契约，再组织回答。';
          if (req.headers['x-awwo-run-activity'] === 'reasoning') send({ type: 'reasoning', characters: thought.length });
          text = `<think>${thought}</think>\n${text}`;
        }
        try {
          for (let index = 0; index < text.length; index += 16) {
            if (run.cancelled) { send({ type: 'cancelled' }); return res.end(); }
            send({ type: 'text_delta', delta: text.slice(index, index + 16) });
            if (delayMs > 0) await sleep(delayMs);
          }
          if (run.cancelled) { send({ type: 'cancelled' }); return res.end(); }
          send({ type: 'completed', text });
          res.end();
        } finally {
          active.delete(request.runId);
        }
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 400, { error: error.message });
      else res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(port, host, () => {
      const address = server.address();
      const url = `http://${host}:${typeof address === 'object' && address ? address.port : port}`;
      resolve({ server, url, close: () => new Promise(done => server.close(done)) });
    });
  });
}

/** Optional self-registration with an orchestrator (hot-plug without editing runtimes.json). */
async function register(orchestrator, entry) {
  try {
    const response = await fetch(`${orchestrator.replace(/\/+$/, '')}/api/runtimes`, {
      method: 'POST', body: JSON.stringify(entry),
      headers: { 'content-type': 'application/json', ...(process.env.AWWO_API_TOKEN ? { authorization: `Bearer ${process.env.AWWO_API_TOKEN}` } : {}) },
    });
    const body = await response.json().catch(() => ({}));
    console.log(`[mock-worker] register with ${orchestrator}: HTTP ${response.status}${body.error ? ` (${body.error})` : ''}`);
  } catch (error) {
    console.log(`[mock-worker] could not register with ${orchestrator}: ${error.message}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.AWWO_WORKER_PORT || 8791);
  const host = process.env.AWWO_WORKER_HOST || '127.0.0.1';
  const runtime = process.env.AWWO_WORKER_RUNTIME || 'mock';
  const token = process.env.AWWO_WORKER_TOKEN || '';
  const { url } = await startMockWorker({ port, host, token, runtime, delayMs: Number(process.env.AWWO_MOCK_DELAY_MS ?? 12) });
  console.log(`[mock-worker] runtime "${runtime}" on ${url}${token ? ' (bearer token required)' : ''}`);
  if (process.env.AWWO_REGISTER_URL) await register(process.env.AWWO_REGISTER_URL, { id: runtime, url, label: 'Mock (offline demo)', ...(token ? { token } : {}) });
}
