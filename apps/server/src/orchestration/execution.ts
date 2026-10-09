// Execution snapshots and node execution.
//
// AwwO freezes every effective selector at admission — runtime, model, effort, team members,
// budgets and the output policy — and never rediscovers workers or falls back to another model
// once a call is accepted (runtime_workers.go: runtimeSnapshot/resolveTeam). A worker unplugged
// mid-run therefore fails the calls that needed it; it is never silently replaced.
import { createHash, randomUUID } from 'node:crypto';
import type { SessionNode } from '@awwo/core/canvasDoc';
import type { ExecAgentResult } from '@awwo/core/runGraph';
import { isNodeTeamRuntimeId, validateNodeTeam } from '@awwo/core/nodeTeam';
import type { WorkerMessage } from '@awwo/core/protocol';
import { modelLimits, supportsEffort, toolBudget, RuntimeUnavailable, type RuntimeRegistry } from '../runtimes/registry';
import { runOnWorker } from '../runtimes/client';
import type { SkillRegistry } from '../skills';
import { graphOutputPolicy, graphSystemPrompt } from './outputPolicy';
import { ReasoningStream, splitReasoning, stripReasoningPreamble } from './reasoning';
import { prepareTeamInput, runTeam, TeamError, type ResolvedMember, type ResolvedTeam, type TeamContextAudit, type TeamPurpose } from './team';

export class AdmissionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AdmissionError';
  }
}

export interface MemberLimits { budget: number; overhead: number; toolBytes: number }

export interface NodeSnapshot {
  nodeId: string;
  title: string;
  runtime: string;
  model: string;
  effort: string;
  /** The node persona: identity, responsibilities and content requirements. */
  instructions: string;
  /** Frozen serialization policy derived from the node's output contract ('' = none). */
  outputPolicy: string;
  budget: number;
  overhead: number;
  team: ResolvedTeam | null;
  memberLimits: Record<string, MemberLimits>;
}

export interface TeamTurnEvent {
  id: string;
  memberId: string;
  memberName: string;
  role: string;
  round: number;
  ordinal: number;
  purpose: TeamPurpose;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  runtime: string;
  model: string;
  output?: string;
  error?: string;
  context?: TeamContextAudit;
}

export interface ExecutionContext {
  registry: RuntimeRegistry;
  skills: SkillRegistry;
  signal?: AbortSignal;
  /** Stable conversation identity for this node's calls. */
  sessionId: string;
  history?: readonly WorkerMessage[];
  onDelta?: (delta: string, turnId?: string) => void;
  onTurn?: (turn: TeamTurnEvent) => void;
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

async function liveHealth(registry: RuntimeRegistry, runtime: string) {
  try { return await registry.health(runtime); }
  catch (error) {
    if (error instanceof RuntimeUnavailable) throw new AdmissionError(503, 'runtime_unavailable', error.message);
    throw error;
  }
}

/** Resolve and validate everything a node's execution needs, before any model call is made. */
export async function freezeNodeSnapshot(node: SessionNode, ctx: { registry: RuntimeRegistry; skills: SkillRegistry; defaultRuntime: string }): Promise<NodeSnapshot> {
  const runtime = node.runtime || ctx.defaultRuntime;
  if (!runtime) throw new AdmissionError(503, 'runtime_unavailable', 'No runtime is ready. Start a worker (npm run worker:mock) or register one.');
  if (!isNodeTeamRuntimeId(runtime)) throw new AdmissionError(400, 'invalid_setup', `「${node.title}」selects an invalid runtime id`);
  const health = await liveHealth(ctx.registry, runtime);
  const model = node.model || health.model;
  const limits = modelLimits(health, model);
  if (!limits) throw new AdmissionError(409, 'model_unavailable', `「${node.title}」: model "${model}" is not offered by runtime "${runtime}"`);
  if (!supportsEffort(health, model, node.effort)) throw new AdmissionError(400, 'effort_unsupported', `「${node.title}」: model "${model}" does not advertise effort "${node.effort}"`);
  let team: ResolvedTeam | null = null;
  const memberLimits: Record<string, MemberLimits> = {};
  if (node.team) {
    const issues = validateNodeTeam(node.team);
    if (issues.length) throw new AdmissionError(400, 'invalid_team', `「${node.title}」: ${issues[0].message}`);
    const members: ResolvedMember[] = [];
    for (const member of node.team.members) {
      const memberRuntime = member.runtime || node.team.runtime;
      const memberHealth = await liveHealth(ctx.registry, memberRuntime);
      let memberModel = member.model;
      let memberEffort = member.effort ?? '';
      if (!memberModel) {
        memberModel = memberHealth.model;
        // Model and effort are parallel selectors: a member inheriting the node's model inherits its effort too.
        if (memberRuntime === runtime) {
          memberModel = model;
          if (!memberEffort) memberEffort = node.effort;
        }
      }
      const memberModelLimits = modelLimits(memberHealth, memberModel);
      if (!memberModelLimits) throw new AdmissionError(409, 'model_unavailable', `「${node.title}」 member ${member.name}: model "${memberModel}" is not offered by "${memberRuntime}"`);
      if (!supportsEffort(memberHealth, memberModel, memberEffort)) throw new AdmissionError(400, 'effort_unsupported', `「${node.title}」 member ${member.name}: effort "${memberEffort}" is not offered`);
      const toolBytes = toolBudget(memberHealth, member.tools);
      if (toolBytes === null) throw new AdmissionError(400, 'tool_unavailable', `「${node.title}」 member ${member.name} selects a tool runtime "${memberRuntime}" does not serve`);
      memberLimits[member.id] = { ...memberModelLimits, toolBytes };
      members.push({ ...member, runtime: memberRuntime, model: memberModel, ...(memberEffort ? { effort: memberEffort } : {}), tools: [...member.tools] });
    }
    team = { ...node.team, members };
  }
  return {
    nodeId: node.id, title: node.title, runtime, model, effort: node.effort, instructions: node.persona,
    outputPolicy: graphOutputPolicy(node.contract, ctx.skills), budget: limits.budget, overhead: limits.overhead, team, memberLimits,
  };
}

function failure(code: string, message: string, output = ''): ExecAgentResult {
  return { ok: false, output, detail: `${code}: ${message}` };
}

/** Execute one node: a single agent call, or its team. The caller validates the output contract. */
export async function executeNode(snapshot: NodeSnapshot, message: string, ctx: ExecutionContext): Promise<ExecAgentResult> {
  if (snapshot.team) return executeTeam(snapshot, snapshot.team, message, ctx);
  const system = graphSystemPrompt(snapshot.instructions, snapshot.outputPolicy, ctx.skills);
  const historyBytes = (ctx.history ?? []).reduce((sum, item) => sum + bytes(item.content) + snapshot.overhead, 0);
  if (bytes(message) + bytes(system) + historyBytes + snapshot.overhead > snapshot.budget) {
    return failure('context_limit', `The prompt exceeds the ${snapshot.budget}-byte input budget of ${snapshot.model}`);
  }
  let endpoint;
  try { endpoint = ctx.registry.endpoint(snapshot.runtime); }
  catch (error) { return failure('runtime_unavailable', error instanceof Error ? error.message : 'Runtime unavailable'); }
  const stream = new ReasoningStream();
  const outcome = await runOnWorker({
    endpoint, signal: ctx.signal,
    request: { runId: randomUUID(), sessionId: ctx.sessionId, prompt: message, messages: [...(ctx.history ?? [])], systemPrompt: system,
      model: snapshot.model, runtime: snapshot.runtime, ...(snapshot.effort ? { effort: snapshot.effort } : {}) },
    onDelta: delta => { const answer = stream.push(delta); if (answer) ctx.onDelta?.(answer); },
  });
  if (outcome.status === 'cancelled') return { ok: false, cancelled: true, output: stripReasoningPreamble(outcome.text), detail: 'cancelled' };
  if (outcome.status === 'failed') return failure(outcome.code, outcome.message, stripReasoningPreamble(outcome.text));
  const { answer, delivered } = splitReasoning(outcome.text);
  if (!delivered) return failure('reasoning_only_output', 'The model returned only its reasoning');
  return { ok: true, output: answer, detail: `${snapshot.runtime} · ${snapshot.model}` };
}

async function executeTeam(snapshot: NodeSnapshot, team: ResolvedTeam, task: string, ctx: ExecutionContext): Promise<ExecAgentResult> {
  const timeout = AbortSignal.timeout(team.timeoutSeconds * 1000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const call = async (member: ResolvedMember, round: number, ordinal: number, input: Parameters<typeof prepareTeamInput>[0]['input'], callSignal: AbortSignal) => {
    const limits = snapshot.memberLimits[member.id];
    const prepared = prepareTeamInput({ common: snapshot.instructions, policy: snapshot.outputPolicy, member, input,
      budget: limits.budget - limits.toolBytes, overhead: limits.overhead, history: ctx.history, skills: ctx.skills });
    const id = randomUUID();
    const turn: TeamTurnEvent = { id, memberId: member.id, memberName: member.name, role: member.role, round, ordinal,
      purpose: input.purpose, status: 'running', runtime: member.runtime, model: member.model, context: prepared.audit };
    ctx.onTurn?.(turn);
    let endpoint;
    try { endpoint = ctx.registry.endpoint(member.runtime); }
    catch (error) {
      ctx.onTurn?.({ ...turn, status: 'failed', error: 'runtime_unavailable' });
      throw new TeamError('runtime_unavailable', error instanceof Error ? error.message : 'Runtime unavailable');
    }
    const stream = new ReasoningStream();
    const outcome = await runOnWorker({
      endpoint, signal: callSignal,
      request: { runId: id, sessionId: `${ctx.sessionId}_${createHash('sha256').update(member.id).digest('hex').slice(0, 16)}`,
        prompt: prepared.prompt, messages: prepared.messages, systemPrompt: prepared.system, model: member.model, runtime: member.runtime,
        ...(member.effort ? { effort: member.effort } : {}), ...(member.tools.length ? { tools: member.tools } : {}) },
      onDelta: delta => { const answer = stream.push(delta); if (answer) ctx.onDelta?.(answer, id); },
    });
    if (outcome.status === 'cancelled') {
      ctx.onTurn?.({ ...turn, status: 'cancelled' });
      throw new TeamError('cancelled');
    }
    if (outcome.status === 'failed') {
      ctx.onTurn?.({ ...turn, status: 'failed', error: outcome.code, output: stripReasoningPreamble(outcome.text) });
      throw new TeamError(outcome.code, outcome.message);
    }
    const { answer, delivered } = splitReasoning(outcome.text);
    if (!delivered) {
      // A member that returned only a scratchpad has nothing to aggregate; nothing leaks onward.
      ctx.onTurn?.({ ...turn, status: 'failed', error: 'reasoning_only_output' });
      throw new TeamError('reasoning_only_output', `${member.name} returned only its reasoning`);
    }
    ctx.onTurn?.({ ...turn, status: 'completed', output: answer });
    return answer;
  };
  try {
    const output = await runTeam(team, task, call, signal, ctx.skills);
    return { ok: true, output, detail: `team · ${team.mode}` };
  } catch (error) {
    if (ctx.signal?.aborted) return { ok: false, cancelled: true, output: '', detail: 'cancelled' };
    if (timeout.aborted) return failure('team_timeout', `The team exceeded ${team.timeoutSeconds}s`);
    if (error instanceof TeamError) return failure(error.code, error.message);
    return failure('team_failed', error instanceof Error ? error.message : String(error));
  }
}
