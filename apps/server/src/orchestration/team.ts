// Node teams — deterministic orchestration inside one canvas node.
// Ported from AwwO backend/internal/app/teams.go (runTeam) and team_context.go (prompt + context).
//
// Outputs are DATA, never executable instructions. `shared` members receive earlier completed
// member outputs; `task` members only the task — except that aggregation, review and revision
// necessarily receive their operands. The prompt text comes from skills/team-orchestration.
import type { NodeTeam, NodeTeamMember } from '@awwo/core/nodeTeam';
import type { WorkerMessage } from '@awwo/core/protocol';
import { fill, type SkillRegistry } from '../skills';
import { splitReasoning } from './reasoning';

const SKILL = 'team-orchestration';

export interface ResolvedMember extends NodeTeamMember { runtime: string; model: string }
export interface ResolvedTeam extends Omit<NodeTeam, 'members'> { members: ResolvedMember[] }

export type TeamPurpose = 'work' | 'aggregate' | 'review' | 'revise';
export interface TeamSource { memberId: string; memberName: string; round: number; ordinal: number }
export interface TeamOutput extends TeamSource { output: string }
export interface TeamTurnInput { task: string; instruction: string; purpose: TeamPurpose; upstream: TeamOutput[]; required: boolean }

export class TeamError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'TeamError';
  }
}

export type TeamCall = (member: ResolvedMember, round: number, ordinal: number, input: TeamTurnInput, signal: AbortSignal) => Promise<string>;

/** The planned number of model calls, as the editor shows it. */
export function plannedTeamCalls(team: Pick<NodeTeam, 'mode' | 'maxRounds'> & { members: unknown[] }): number {
  if (team.mode === 'debate') return team.members.length * team.maxRounds + 1;
  if (team.mode === 'review') return team.members.length * team.maxRounds;
  return team.members.length;
}

/** Strict review verdict: exactly an object of approved/output[/feedback], nothing before or after. */
export function parseReviewVerdict(text: string): { approved: boolean; output: string; feedback: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new TeamError('invalid_review_verdict', 'The reviewer did not return strict JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamError('invalid_review_verdict', 'The review verdict must be a JSON object');
  const verdict = value as Record<string, unknown>;
  if (Object.keys(verdict).some(key => key !== 'approved' && key !== 'output' && key !== 'feedback')) {
    throw new TeamError('invalid_review_verdict', 'The review verdict has unknown fields');
  }
  if (typeof verdict.approved !== 'boolean' || typeof verdict.output !== 'string'
    || (verdict.feedback !== undefined && typeof verdict.feedback !== 'string')) {
    throw new TeamError('invalid_review_verdict', 'The review verdict needs boolean approved and string output');
  }
  return { approved: verdict.approved, output: verdict.output, feedback: (verdict.feedback as string | undefined) ?? '' };
}

export async function runTeam(team: ResolvedTeam, task: string, call: TeamCall, signal: AbortSignal, skills: SkillRegistry): Promise<string> {
  const op = (name: string) => skills.block(SKILL, name).trim();
  let ordinal = 0;
  const transcript: TeamOutput[] = [];
  const invoke = async (member: ResolvedMember, round: number, instruction: string, purpose: TeamPurpose, force: boolean): Promise<string> => {
    ordinal += 1;
    if (ordinal > team.maxTurns) throw new TeamError('team_turn_budget_exhausted', 'The team reached its model-call limit');
    if (signal.aborted) throw new TeamError('cancelled');
    const input: TeamTurnInput = { task, instruction, purpose, required: force,
      upstream: member.context === 'shared' || force ? [...transcript] : [] };
    const out = await call(member, round, ordinal, input, signal);
    transcript.push({ memberId: member.id, memberName: member.name, round, ordinal, output: out });
    return out;
  };
  const last = team.members[team.members.length - 1];
  switch (team.mode) {
    case 'sequential': {
      let out = '';
      for (const member of team.members) out = await invoke(member, 1, '', 'work', false);
      return out;
    }
    case 'parallel': {
      if (team.members.length === 1) return invoke(team.members[0], 1, '', 'work', false);
      const workers = team.members.slice(0, -1);
      const group = new AbortController();
      const abort = () => group.abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        // Workers never read each other's in-progress output; one failure stops the group.
        const results = await Promise.allSettled(workers.map((member, index) =>
          call(member, 1, index + 1, { task, instruction: '', purpose: 'work', upstream: [], required: false }, group.signal)
            .catch(error => { group.abort(); throw error; })));
        ordinal = workers.length;
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') throw result.reason;
          const member = workers[index];
          transcript.push({ memberId: member.id, memberName: member.name, round: 1, ordinal: index + 1, output: result.value });
        }
      } finally {
        signal.removeEventListener('abort', abort);
      }
      return invoke(last, 1, op('op-parallel-aggregate'), 'aggregate', true);
    }
    case 'debate': {
      for (let round = 1; round <= team.maxRounds; round += 1) {
        for (const member of team.members) await invoke(member, round, op('op-debate-work'), 'work', false);
      }
      return invoke(last, team.maxRounds + 1, op('op-debate-aggregate'), 'aggregate', true);
    }
    case 'review': {
      const producers = team.members.slice(0, -1);
      for (let round = 1; round <= team.maxRounds; round += 1) {
        for (const member of producers) await invoke(member, round, op('op-review-revise'), 'revise', round > 1);
        const verdict = parseReviewVerdict(await invoke(last, round, op('op-review-verdict'), 'review', true));
        if (verdict.approved) {
          // The approved string replaces the whole published text, so a scratchpad wrapped inside
          // the verdict must not be published — or a run reported complete with no deliverable.
          const { answer, delivered } = splitReasoning(verdict.output);
          if (!delivered) throw new TeamError('reasoning_only_output', 'The approved deliverable is empty');
          return answer;
        }
      }
      throw new TeamError('review_rounds_exhausted', 'The reviewer did not approve within the round limit');
    }
    default:
      throw new TeamError('invalid_team_mode');
  }
}

// ---- member prompt composition (team_context.go) -------------------------------------------

export function teamSystemPrompt(common: string, member: NodeTeamMember, skills: SkillRegistry): string {
  return fill(skills.block(SKILL, 'member-system').trim(), {
    common: JSON.stringify(common),
    member: JSON.stringify({ id: member.id, name: member.name, role: member.role }),
    instructions: JSON.stringify(member.instructions),
  });
}

export function renderTeamPrompt(input: TeamTurnInput, upstream: readonly TeamOutput[], skills: SkillRegistry): string {
  let prompt = input.task;
  if (upstream.length) {
    const data = upstream.map(({ memberId, memberName, round, ordinal, output }) => ({ memberId, memberName, round, ordinal, output }));
    prompt += `\n\n${skills.block(SKILL, 'upstream-header').trim()}\n${JSON.stringify(data)}`;
  }
  if (input.instruction) prompt += `\n\n${skills.block(SKILL, 'operation-header').trim()}\n${input.instruction}`;
  return prompt;
}

export interface TeamContextAudit {
  version: 1;
  mode: 'task' | 'shared';
  historyMessages: number;
  historyAvailable: number;
  historyTruncated: boolean;
  upstreamMembers: TeamSource[];
  upstreamAvailable: number;
  upstreamTruncated: boolean;
  purpose: TeamPurpose;
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * The current task and member instructions are never truncated. Ordinary shared context keeps a
 * recent suffix of complete member outputs and history pairs; required review/aggregation
 * operands must all fit, or no call is made (`context_limit`).
 */
export function prepareTeamInput(options: {
  common: string; policy: string; member: ResolvedMember; input: TeamTurnInput;
  budget: number; overhead: number; history?: readonly WorkerMessage[]; skills: SkillRegistry;
}): { prompt: string; system: string; messages: WorkerMessage[]; audit: TeamContextAudit } {
  const { member, input, skills } = options;
  let system = teamSystemPrompt(options.common, member, skills);
  if (options.policy) {
    system += `\n\n${options.policy}`;
    // Review uses an orchestration envelope; the deliverable is serialized inside its output string.
    if (input.purpose === 'review') system += `\n\n${skills.block(SKILL, 'review-protocol').trim()}`;
  }
  const upstream = member.context === 'task' && !input.required ? [] : input.upstream;
  const audit: TeamContextAudit = { version: 1, mode: member.context, purpose: input.purpose, upstreamMembers: [],
    upstreamAvailable: upstream.length, upstreamTruncated: false, historyMessages: 0, historyAvailable: 0, historyTruncated: false };
  const budget = Math.min(options.budget, 262_144);
  const fits = (prompt: string) => bytes(prompt) + bytes(system) + options.overhead <= budget && prompt.length <= 128_000;
  let prompt = renderTeamPrompt(input, [], skills);
  if (!fits(prompt) || system.length > 32_768) throw new TeamError('context_limit', 'The task and instructions exceed this model\'s input budget');
  let start = upstream.length;
  for (let index = upstream.length - 1; index >= 0; index -= 1) {
    const candidate = renderTeamPrompt(input, upstream.slice(index), skills);
    if (!fits(candidate)) break;
    start = index;
    prompt = candidate;
  }
  if (input.required && start !== 0) throw new TeamError('context_limit', 'Required team results do not fit this model\'s input budget');
  audit.upstreamTruncated = start > 0;
  audit.upstreamMembers = upstream.slice(start).map(({ memberId, memberName, round, ordinal }) => ({ memberId, memberName, round, ordinal }));
  const messages: WorkerMessage[] = [];
  if (member.context === 'shared' && options.history?.length) {
    const prefix = skills.block(SKILL, 'history-assistant-prefix').trim();
    const labelled = options.history.map(message => message.role === 'assistant'
      ? { role: 'assistant' as const, content: `${prefix}\n${JSON.stringify(message.content)}` }
      : { role: 'user' as const, content: message.content });
    audit.historyAvailable = labelled.length;
    let used = bytes(prompt) + bytes(system);
    // Keep the most recent complete user/assistant pairs that fit.
    const kept: WorkerMessage[] = [];
    for (let index = labelled.length - 2; index >= 0; index -= 2) {
      const pair = labelled.slice(index, index + 2);
      if (pair.length !== 2 || pair[0].role !== 'user' || pair[1].role !== 'assistant') break;
      const cost = bytes(pair[0].content) + bytes(pair[1].content) + 2 * options.overhead;
      if (used + cost + options.overhead > budget) break;
      used += cost;
      kept.unshift(...pair);
    }
    messages.push(...kept);
  }
  audit.historyMessages = messages.length;
  audit.historyTruncated = audit.historyMessages < audit.historyAvailable;
  return { prompt, system, messages, audit };
}
