// Direct runs: a node's own conversation, and the assistant's `execute` route.
//
// As in AwwO, a chat message is sent as written — it is NOT wrapped in the node's task framing or
// output contract, and a chat answer never overwrites the node's published deliverable. Executing
// the node's task with its contract is a graph run (scope = that node).
import { randomUUID } from 'node:crypto';
import type { WorkerMessage } from '@awwo/core/protocol';
import { isNodeTeamRuntimeId } from '@awwo/core/nodeTeam';
import type { SseStream } from '../http';
import { modelLimits, RuntimeUnavailable, supportsEffort, type RuntimeRegistry } from '../runtimes/registry';
import { runOnWorker } from '../runtimes/client';
import type { SkillRegistry } from '../skills';
import { ReasoningStream, splitReasoning, stripReasoningPreamble } from './reasoning';

export interface DirectRunRequest {
  runtime?: unknown; model?: unknown; effort?: unknown; persona?: unknown;
  prompt?: unknown; messages?: unknown; purpose?: unknown; sessionId?: unknown;
}

const MAX_PROMPT = 32_000;
const MAX_HISTORY = 100;

function history(raw: unknown): WorkerMessage[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_HISTORY) return null;
  const messages: WorkerMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const { role, content } = item as Record<string, unknown>;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || content.length > 32_768) return null;
    messages.push({ role, content });
  }
  return messages;
}

export async function streamDirectRun(input: DirectRunRequest, deps: { registry: RuntimeRegistry; skills: SkillRegistry; defaultRuntime: string }, sse: SseStream): Promise<void> {
  const fail = (code: string, error: string) => { sse.send({ type: 'failed', code, error }); sse.close(); };
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const messages = history(input.messages);
  if (!prompt.trim() || prompt.length > MAX_PROMPT || !messages) return fail('invalid_input', 'A run needs a prompt (≤32000 characters) and at most 100 well-formed history messages');
  const runtime = (typeof input.runtime === 'string' && input.runtime) || deps.defaultRuntime;
  if (!runtime || !isNodeTeamRuntimeId(runtime)) return fail('runtime_unavailable', 'No runtime is ready');
  let health;
  try { health = await deps.registry.health(runtime); }
  catch (error) { return fail('runtime_unavailable', error instanceof RuntimeUnavailable ? error.message : 'Runtime unavailable'); }
  const model = (typeof input.model === 'string' && input.model) || health.model;
  const effort = typeof input.effort === 'string' ? input.effort : '';
  const limits = modelLimits(health, model);
  if (!limits) return fail('model_unavailable', `Model "${model}" is not offered by runtime "${runtime}"`);
  if (!supportsEffort(health, model, effort)) return fail('effort_unsupported', `Model "${model}" does not advertise effort "${effort}"`);
  const system = input.purpose === 'execute'
    ? deps.skills.block('assistant-router', 'execute-system').trim()
    : typeof input.persona === 'string' ? input.persona.slice(0, 16_000) : '';
  // Keep the most recent complete history that fits the model's budget; never cut the prompt.
  const used = Buffer.byteLength(prompt) + Buffer.byteLength(system) + limits.overhead;
  if (used > limits.budget) return fail('context_limit', `The message exceeds the ${limits.budget}-byte budget of ${model}`);
  let room = limits.budget - used;
  const kept: WorkerMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = Buffer.byteLength(messages[index].content) + limits.overhead;
    if (cost > room) break;
    room -= cost;
    kept.unshift(messages[index]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  const sessionId = typeof input.sessionId === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(input.sessionId) ? input.sessionId : `direct_${randomUUID()}`;
  sse.send({ type: 'started', runtime, model, historyMessages: kept.length, historyAvailable: messages.length });
  const stream = new ReasoningStream();
  const outcome = await runOnWorker({
    endpoint: deps.registry.endpoint(runtime), signal: sse.signal,
    request: { runId: randomUUID(), sessionId, prompt, messages: kept, systemPrompt: system, model, runtime, ...(effort ? { effort } : {}) },
    onDelta: delta => { const answer = stream.push(delta); if (answer) sse.send({ type: 'delta', delta: answer }); },
  });
  if (sse.closed) return;
  if (outcome.status === 'cancelled') { sse.send({ type: 'cancelled', text: stripReasoningPreamble(outcome.text) }); sse.close(); return; }
  if (outcome.status === 'failed') return fail(outcome.code, outcome.message);
  const { answer, delivered } = splitReasoning(outcome.text);
  if (!delivered) return fail('reasoning_only_output', 'The model returned only its reasoning');
  sse.send({ type: 'completed', text: answer, runtime, model });
  sse.close();
}
