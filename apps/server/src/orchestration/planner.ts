// Canvas planning on the orchestrator (AwwO planning.go + planner_progress.go, simplified).
//
// One plan = one model call on the planner runtime. Progress frames carry only measurements
// (characters written, add_node/connect markers seen, reasoning size), never a fabricated
// percentage. The proposal is checked with the SAME parseCanvasPlan the canvas uses; the canvas
// then validates it again against its current document before applying one undoable change.
import { randomUUID } from 'node:crypto';
import { CANVAS_PLAN_OPERATION_TYPES, parseCanvasPlan } from '@awwo/core/canvasPlan';
import { AGENT_TEMPLATE_IDS } from '@awwo/core/agentTemplates';
import type { SseStream } from '../http';
import { modelLimits, RuntimeUnavailable, type RuntimeRegistry } from '../runtimes/registry';
import { runOnWorker } from '../runtimes/client';
import type { SkillRegistry } from '../skills';
import { ReasoningStream, splitReasoning } from './reasoning';

export const PLAN_LIMITS = { prompt: 8_000, context: 120_000, total: 128_000 } as const;

/** End index of the first JSON value starting at `start`, or -1. */
function jsonValueEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  const open = text[index];
  if (open !== '{' && open !== '[') return -1;
  let depth = 0;
  let inString = false;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * The plan's JSON inside the planner's answer: the whole answer, or the body of a ```json (or bare
 * ```) block. Some models close the block and add a note after it; that note is not part of the
 * plan, so the block ends at its closing fence, found after the first JSON value (a fence inside a
 * string cannot end it early). Anything else after the plan still fails the schema gate.
 */
export function planJsonBody(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('```')) return text;
  let body = text.slice(3);
  if (body.startsWith('json')) body = body.slice(4);
  const end = jsonValueEnd(body, 0);
  if (end < 0) return body;
  const rest = body.slice(end).trim();
  return rest === '' || rest.startsWith('```') ? body.slice(0, end) : body;
}

export interface PlanRequest { prompt?: unknown; context?: unknown; runtime?: unknown; model?: unknown }

export interface PlannerDeps {
  registry: RuntimeRegistry;
  skills: SkillRegistry;
  plannerRuntime: string;
  plannerModel: string;
}

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

export async function streamPlan(input: PlanRequest, deps: PlannerDeps, sse: SseStream): Promise<void> {
  const error = (code: string, message: string) => { sse.send({ type: 'error', code, error: message }); sse.close(); };
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const context = typeof input.context === 'string' ? input.context : '';
  if (!prompt.trim() || prompt.length > PLAN_LIMITS.prompt || context.length > PLAN_LIMITS.context || prompt.length + context.length > PLAN_LIMITS.total) {
    return error('invalid_input', 'Planning needs a bounded prompt (≤8000) and context (≤120000)');
  }
  const runtime = (typeof input.runtime === 'string' && input.runtime) || deps.registry.defaultRuntime(deps.plannerRuntime);
  if (!runtime) return error('runtime_unavailable', 'No runtime is ready for planning');
  let health;
  try { health = await deps.registry.health(runtime); }
  catch (failure) { return error('runtime_unavailable', failure instanceof RuntimeUnavailable ? failure.message : 'Runtime unavailable'); }
  const model = (typeof input.model === 'string' && input.model) || (runtime === deps.plannerRuntime && deps.plannerModel) || health.model;
  const limits = modelLimits(health, model);
  if (!limits) return error('model_unavailable', `Model "${model}" is not offered by runtime "${runtime}"`);
  const system = deps.skills.block('canvas-planner', 'system').trim();
  const userPrompt = `${context}\n\nUser request:\n${prompt}`;
  if (Buffer.byteLength(system) + Buffer.byteLength(userPrompt) + limits.overhead > limits.budget) {
    return error('context_limit', `The planning context exceeds the ${limits.budget}-byte budget of ${model}`);
  }

  const progress = { stage: 'queued', characters: 0, nodes: 0, edges: 0, reasoning: 0 } as Record<string, unknown> & { stage: string; characters: number; nodes: number; edges: number; reasoning: number };
  let lastSent = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastSent < 200) return;
    lastSent = now;
    sse.send({ type: 'progress', ...progress });
  };
  report(true);
  progress.stage = 'running';
  report(true);

  const stream = new ReasoningStream();
  let text = '';
  const outcome = await runOnWorker({
    endpoint: deps.registry.endpoint(runtime), signal: sse.signal, reasoningActivity: true,
    request: { runId: randomUUID(), sessionId: `planner_${runtime}`, prompt: userPrompt, messages: [], systemPrompt: system, model, runtime },
    onReasoning: characters => { progress.stage = 'thinking'; progress.reasoning += characters; report(); },
    onDelta: delta => {
      const answer = stream.push(delta);
      if (!answer) {
        if (stream.reasoningCharacters > progress.reasoning) { progress.stage = 'thinking'; progress.reasoning = stream.reasoningCharacters; report(); }
        return;
      }
      text += answer;
      progress.stage = 'streaming';
      progress.characters = text.length;
      progress.nodes = count(text, /"type"\s*:\s*"add_node"/g);
      progress.edges = count(text, /"type"\s*:\s*"connect"/g);
      const operations = [...text.matchAll(/"type"\s*:\s*"([a-z_]+)"/g)].map(match => match[1]).filter(type => CANVAS_PLAN_OPERATION_TYPES.has(type));
      const templates = [...text.matchAll(/"templateId"\s*:\s*"([a-z]+)"/g)].map(match => match[1]).filter(id => AGENT_TEMPLATE_IDS.has(id));
      if (operations.length) progress.operation = operations.at(-1); else delete progress.operation;
      if (templates.length) progress.template = templates.at(-1); else delete progress.template;
      if (progress.operation === 'add_node' && progress.template) progress.target = progress.template; else delete progress.target;
      report();
    },
  });
  if (sse.closed) return;
  if (outcome.status === 'cancelled') return error('cancelled', 'Planning was cancelled');
  if (outcome.status === 'failed') return error(outcome.code, outcome.message);
  progress.stage = 'validating';
  report(true);
  const { answer, delivered } = splitReasoning(outcome.text);
  if (!delivered) return error('reasoning_only_output', 'The planner returned only its reasoning');
  try {
    const plan = parseCanvasPlan(planJsonBody(answer));
    sse.send({ type: 'plan', plan, provider: runtime, model });
    sse.close();
  } catch (failure) {
    error('invalid_canvas_plan', failure instanceof Error ? failure.message : 'The planner returned an invalid plan');
  }
}
