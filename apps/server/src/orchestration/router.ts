// Assistant routing (ported from AwwO backend/internal/app/assistant_route.go).
//
// Whenever the router cannot tell, a message is PLANNED: a plan is one call and is undone in one
// step, while a task makes real calls and produces real output. Wording decides a message without
// a model call only toward planning, and only when no negation appears anywhere in the message.
import { randomUUID } from 'node:crypto';
import type { AssistantRoute, AssistantRouteRequest, AssistantRouteResult } from '@awwo/core/assistantRoute';
import type { RuntimeRegistry } from '../runtimes/registry';
import { completeOnWorker } from '../runtimes/client';
import type { SkillRegistry } from '../skills';
import { HttpError } from '../http';

const LIMITS = { message: 8000, titles: 40, title: 120, turns: 6, turn: 600,
  promptMessage: 1500, promptTitles: 12, promptTitle: 60, promptTurns: 4, promptTurn: 300, maxTokens: 24, timeoutMs: 8000 } as const;

const runes = (text: string) => [...text].length;
const clip = (text: string, max: number) => (runes(text) <= max ? text : `${[...text].slice(0, max).join('')}…`);

export function validRouteInput(input: unknown): input is AssistantRouteRequest {
  if (!input || typeof input !== 'object') return false;
  const value = input as AssistantRouteRequest;
  if (typeof value.message !== 'string' || !value.message.trim() || runes(value.message) > LIMITS.message) return false;
  if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > 2
    || (value.routes.length === 2 && value.routes[0] === value.routes[1]) || value.routes.some(route => route !== 'plan' && route !== 'execute')) return false;
  const canvas = value.canvas;
  if (!canvas || typeof canvas !== 'object' || typeof canvas.nodes !== 'number' || canvas.nodes < 0 || canvas.nodes > 100_000
    || !Array.isArray(canvas.titles) || canvas.titles.length > LIMITS.titles
    || canvas.titles.some(title => typeof title !== 'string' || runes(title) > LIMITS.title) || typeof canvas.results !== 'boolean') return false;
  if (!Array.isArray(value.recent) || value.recent.length > LIMITS.turns) return false;
  return value.recent.every(turn => turn && (turn.role === 'user' || turn.role === 'assistant')
    && (turn.route === undefined || turn.route === 'plan' || turn.route === 'execute')
    && typeof turn.text === 'string' && runes(turn.text) <= LIMITS.turn);
}

const NEGATION = /(不|别|没|无需|勿|\bdon'?t\b|\bdo\s+not\b|\bnot\b|\bwithout\b|\bnever\b)/i;
const PLAN_WORDS = /((编排|调整|整理|修改|重排|搭建?|规划)(一下)?(这个|这张|整个|当前)?画布|画布(上|里|中)?(加|添|新增|放|删|去掉|移除|连|调整|整理|重排)|(加|添加|新增|增加|删除|删掉|移除|去掉|删)(上|掉)?(一|两|三|四|五|几)?个[^，。,.;；\s]{0,12}(节点|智能体|agent|角色|步骤)|(把|将)[^，。,.;；]{1,30}(连到|连接到|接到|连上|连起来|断开)|\b(arrange|rearrange|reorganize)\s+(the|this)\s+canvas\b|\b(add|insert|remove|delete)\s+(a|an|the|another|one|two|three)?\s*(new\s+)?(\w+\s+)?(node|agent|step)s?\b|\b(connect|disconnect|rewire)\s+(the\s+)?nodes?\b)/i;

/** A canvas edit in so many words, with no negation anywhere: plan without a model call. */
export function ruleRoute(message: string, routes: readonly AssistantRoute[]): AssistantRoute | null {
  if (NEGATION.test(message) || !PLAN_WORDS.test(message)) return null;
  return routes.includes('plan') ? 'plan' : null;
}

export function routerMessage(input: AssistantRouteRequest): string {
  const lines: string[] = [];
  if (input.canvas.nodes === 0) lines.push('Canvas: empty.');
  else {
    let canvas = `Canvas: ${input.canvas.nodes} nodes`;
    const titles = input.canvas.titles.slice(0, LIMITS.promptTitles).map(title => JSON.stringify(clip(title, LIMITS.promptTitle)));
    if (titles.length) canvas += `: ${titles.join(', ')}`;
    if (input.canvas.results) canvas += '. It has delivered results';
    lines.push(`${canvas}.`);
  }
  const recent = input.recent.slice(-LIMITS.promptTurns);
  if (recent.length) {
    lines.push('Recent conversation, oldest first:');
    for (const turn of recent) lines.push(`${turn.role}${turn.route ? ` (${turn.route})` : ''}: ${clip(turn.text.trim(), LIMITS.promptTurn)}`);
  }
  lines.push('Message to route:');
  lines.push(clip(input.message.trim(), LIMITS.promptMessage));
  return lines.join('\n');
}

const REPLY_JSON = /\{[^{}]*"route"\s*:\s*"(plan|execute)"[^{}]*\}/;

/** The JSON asked for, or a bare word; reasoning in <think> is ignored, and unclosed reasoning is no answer. */
export function parseRouteReply(text: string): AssistantRoute | null {
  const end = text.lastIndexOf('</think>');
  if (end >= 0) text = text.slice(end + '</think>'.length);
  else if (text.includes('<think>')) return null;
  const match = text.match(REPLY_JSON);
  if (match) return match[1] as AssistantRoute;
  const word = text.trim().toLowerCase().replace(/^["'.]+|["'.]+$/g, '');
  return word === 'plan' || word === 'execute' ? word : null;
}

export interface RouterDeps {
  registry: RuntimeRegistry;
  skills: SkillRegistry;
  routerRuntime: string;
  routerModel: string;
  log?: (message: string) => void;
}

let inFlight = false;

export async function routeAssistantMessage(input: unknown, deps: RouterDeps): Promise<AssistantRouteResult> {
  if (!validRouteInput(input)) throw new HttpError(400, 'invalid_input', 'Routing needs a bounded message, the available ways and bounded canvas facts');
  // Both ways need a ready runtime: planning runs the planner, execution runs one agent.
  const ready = deps.registry.defaultRuntime() !== '';
  const routes = ready ? input.routes : [];
  if (!routes.length) throw new HttpError(409, 'assistant_unavailable', 'No runtime is ready to plan or execute this message');
  if (routes.length === 1) return { route: routes[0], basis: 'only' };
  const rule = ruleRoute(input.message, routes);
  if (rule) return { route: rule, basis: 'rule' };
  const fallback: AssistantRouteResult = { route: 'plan', basis: 'fallback' };
  const runtime = deps.registry.defaultRuntime(deps.routerRuntime);
  if (inFlight) { deps.log?.('assistant routing fell back to planning: router_busy'); return fallback; }
  inFlight = true;
  try {
    const health = await deps.registry.health(runtime);
    // The router's call must be cheap: a worker that cannot cap its output is not asked.
    if (!health.completionOptions?.includes('maxTokens')) return fallback;
    const model = (runtime === deps.routerRuntime && deps.routerModel) || health.model;
    const signal = AbortSignal.timeout(LIMITS.timeoutMs);
    const reply = await completeOnWorker(deps.registry.endpoint(runtime), {
      runId: `route-${randomUUID()}`, model, thinking: false, maxTokens: LIMITS.maxTokens,
      completion: { messages: [
        { role: 'system', content: deps.skills.block('assistant-router', 'system').trim() },
        { role: 'user', content: routerMessage(input) },
      ] },
    }, signal);
    const route = parseRouteReply(reply);
    if (!route || !routes.includes(route)) {
      deps.log?.('assistant routing fell back to planning: router_reply_unreadable');
      return fallback;
    }
    return { route, basis: 'model' };
  } catch (error) {
    deps.log?.(`assistant routing fell back to planning: ${error instanceof Error ? error.message : error}`);
    return fallback;
  } finally {
    inFlight = false;
  }
}
