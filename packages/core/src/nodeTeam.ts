/** Tenant-persisted collaboration contract; runtime capabilities are supplied by the host. */
export type NodeTeamMode = 'sequential' | 'parallel' | 'debate' | 'review';
/**
 * Open-source edition: a runtime is any worker registered with the orchestrator (hot-plug), so its
 * identity is a registry key rather than AwwO's closed pair ('pi' | 'openai-agents'). Whether a
 * runtime, model or tool is actually AVAILABLE is decided by the host against the live worker
 * catalog — this module only checks that the identities are well formed.
 */
export type NodeTeamRuntime = string;
export type NodeTeamTool = string;
export const NODE_TEAM_RUNTIME_ID = /^[a-z][a-z0-9_-]{0,63}$/;
export const NODE_TEAM_TOOL_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
export const isNodeTeamRuntimeId = (value: unknown): value is NodeTeamRuntime => typeof value === 'string' && NODE_TEAM_RUNTIME_ID.test(value);
/** AwwO's two production runtimes, kept as well-known identities and labels. */
export const NODE_TEAM_RUNTIMES: readonly NodeTeamRuntime[] = ['pi', 'openai-agents'];
/** Tools AwwO's OpenAI Agents worker serves; a hot-plugged worker may advertise others. */
export const NODE_TEAM_TOOLS: readonly NodeTeamTool[] = ['calculator', 'current_time'];
export const nodeTeamRuntimeLabel = (runtime: string): string => runtime === 'pi' ? 'Pi' : runtime === 'openai-agents' ? 'OpenAI Agents JS' : runtime;
export type NodeTeamModelCatalogs = Partial<Record<NodeTeamRuntime, readonly string[]>>;
/** Per runtime, the reasoning-effort levels each listed model advertises. A loaded runtime with no entry for a model offers no level. */
export type NodeTeamEffortCatalogs = Partial<Record<NodeTeamRuntime, Readonly<Record<string, readonly string[]>>>>;
const EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,31}$/;
export interface NodeTeamMember {
  id: string;
  name: string;
  role: string;
  instructions: string;
  /** Empty inherits the node team's runtime. */
  runtime: '' | NodeTeamRuntime;
  /** Empty inherits the bound node model only within the same runtime, otherwise its server default. */
  model: string;
  /** Reasoning effort for this member's explicitly chosen model. A level is valid only when that model advertises it
   * and is never back-filled from a default. A member whose model is empty inherits the node model together with the
   * node's effort (resolved by the server); an explicit member effort therefore requires an explicit model. */
  effort?: string;
  context: 'task' | 'shared';
  tools: NodeTeamTool[];
}
export interface NodeTeam {
  version: 1;
  mode: NodeTeamMode;
  runtime: NodeTeamRuntime;
  maxRounds: number;
  maxTurns: number;
  timeoutSeconds: number;
  members: NodeTeamMember[];
}
export interface NodeTeamIssue { path: string; message: string }
export const NODE_TEAM_MODES: readonly NodeTeamMode[] = ['sequential', 'parallel', 'debate', 'review'];
const record = (raw: unknown): Record<string, unknown> | null => raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;

/** Validate before execution/save, without coercing invalid imported configuration into a run. */
export function validateNodeTeam(raw: unknown, allowedModels?: ReadonlyArray<string> | NodeTeamModelCatalogs, locale: 'zh' | 'en' = 'en', effortCatalogs?: NodeTeamEffortCatalogs): NodeTeamIssue[] {
  const issues: NodeTeamIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  const message = (en: string, zh: string) => locale === 'zh' ? zh : en;
  const team = record(raw);
  if (!team) return [{ path: 'team', message: message('Team configuration must be an object.', '团队配置必须是对象。') }];
  if (team.version !== 1) issue('version', message('Unsupported team configuration version.', '不支持此团队配置版本。'));
  if (!NODE_TEAM_MODES.includes(team.mode as NodeTeamMode)) issue('mode', message('Choose a supported collaboration mode.', '请选择受支持的协作方式。'));
  if (!isNodeTeamRuntimeId(team.runtime)) issue('runtime', message('Choose a registered runtime for the team.', '团队执行框架请选择一个已注册的运行时。'));
  for (const [key, min, max] of [['maxRounds', 1, 8], ['maxTurns', 1, 64], ['timeoutSeconds', 10, 1800]] as const) {
    if (typeof team[key] !== 'number' || !Number.isInteger(team[key]) || (team[key] as number) < min || (team[key] as number) > max) {
      const label = { maxRounds: '最多轮数', maxTurns: '最多模型调用次数', timeoutSeconds: '节点超时秒数' }[key];
      issue(key, message(`${key} must be an integer from ${min} to ${max}.`, `${label}必须是 ${min} 至 ${max} 的整数。`));
    }
  }
  if (!Array.isArray(team.members) || team.members.length < 1 || team.members.length > 8) {
    issue('members', message('A team must contain 1 to 8 members.', '团队必须包含 1 至 8 个成员。'));
    return issues;
  }
  if (team.mode === 'review' && team.members.length < 2) issue('members', message('Review mode requires a worker and a reviewer.', '审核模式至少需要一位执行者和一位审核者。'));
  if (typeof team.maxTurns === 'number' && team.maxTurns < team.members.length) issue('maxTurns', message('Allow at least one model call per member.', '调用次数上限至少需要覆盖每位成员的一次调用。'));
  const ids = new Set<string>();
  for (const [index, rawMember] of team.members.entries()) {
    const prefix = `members.${index}`;
    const member = record(rawMember);
    if (!member) { issue(prefix, message('Member configuration must be an object.', '成员配置必须是对象。')); continue; }
    for (const [field, required, max] of [['id', true, 128], ['name', true, 128], ['role', true, 512], ['instructions', false, 16000], ['model', false, 256]] as const) {
      if (typeof member[field] !== 'string' || (required && !(member[field] as string).trim()) || [...(member[field] as string)].length > max) {
        const label = { id: '成员 ID', name: '名称', role: '职责', instructions: '专属指令', model: '模型' }[field];
        issue(`${prefix}.${field}`, message(`${field} ${required ? 'is required and ' : ''}must contain at most ${max} characters.`, `${label}${required ? '不能为空，且' : ''}最多 ${max} 个字符。`));
      }
    }
    if (typeof member.id === 'string') {
      if (ids.has(member.id)) issue(`${prefix}.id`, message('Each member must have a unique ID.', '成员 ID 不能重复。'));
      ids.add(member.id);
    }
    if (member.runtime !== '' && !isNodeTeamRuntimeId(member.runtime)) issue(`${prefix}.runtime`, message('Member runtime must inherit the team default or name a registered runtime.', '成员执行框架必须继承团队默认，或选择一个已注册的运行时。'));
    const runtime = (member.runtime || team.runtime) as NodeTeamRuntime;
    if (member.context !== 'task' && member.context !== 'shared') issue(`${prefix}.context`, message('Choose task-only or shared context.', '请选择仅任务上下文或共享上下文。'));
    // Which tools a runtime serves is its worker's claim (health catalog), checked by the host.
    if (!Array.isArray(member.tools) || member.tools.some(tool => typeof tool !== 'string' || !NODE_TEAM_TOOL_ID.test(tool)) || new Set(member.tools).size !== member.tools.length) {
      issue(`${prefix}.tools`, message('Tools must be distinct tool IDs from the runtime catalog.', '工具必须是运行时目录中的工具 ID，且不能重复。'));
    }
    const models = Array.isArray(allowedModels) ? allowedModels : (allowedModels as NodeTeamModelCatalogs | undefined)?.[runtime];
    if (models && typeof member.model === 'string' && member.model && !models.includes(member.model)) {
      const label = nodeTeamRuntimeLabel(runtime);
      issue(`${prefix}.model`, message(`This model is absent from the current ${label} catalog.`, `此模型不在当前 ${label} 模型清单中，请重新选择。`));
    }
    if (member.effort !== undefined && (typeof member.effort !== 'string' || (member.effort !== '' && !EFFORT_LEVEL.test(member.effort)))) {
      issue(`${prefix}.effort`, message('Reasoning effort must be a level from the model catalog.', '思考强度必须是模型目录列出的档位。'));
    } else if (typeof member.effort === 'string' && member.effort) {
      const runtimeEfforts = effortCatalogs?.[runtime];
      if (typeof member.model !== 'string' || !member.model) {
        issue(`${prefix}.effort`, message('Choose an explicit model before choosing its reasoning effort.', '请先选择明确的模型，再选择它的思考强度。'));
      } else if (runtimeEfforts && !(runtimeEfforts[member.model] ?? []).includes(member.effort)) {
        issue(`${prefix}.effort`, message(`The selected ${nodeTeamRuntimeLabel(runtime)} model does not offer this reasoning effort.`, `所选 ${nodeTeamRuntimeLabel(runtime)} 模型不提供此思考强度，请重新选择。`));
      }
    }
  }
  return issues;
}

/** Strip unrecognised metadata/credential fields; preserve valid values and member order exactly. */
export function sanitizeNodeTeam(raw: unknown): NodeTeam | null {
  if (validateNodeTeam(raw).length) return null;
  const team = raw as NodeTeam;
  return { version: 1, mode: team.mode, runtime: team.runtime, maxRounds: team.maxRounds,
    maxTurns: team.maxTurns, timeoutSeconds: team.timeoutSeconds,
    members: team.members.map(member => ({ id: member.id, name: member.name, role: member.role,
      instructions: member.instructions, runtime: member.runtime, model: member.model,
      // Omitted when unset so teams saved before effort existed keep their exact fingerprint.
      ...(member.effort ? { effort: member.effort } : {}), context: member.context, tools: [...member.tools] })),
  };
}
export function nodeTeamFingerprint(team?: NodeTeam): string | null {
  if (!team) return null;
  return JSON.stringify(sanitizeNodeTeam(team) ?? team);
}
export function nodeTeamTurnEstimate(team: NodeTeam): number {
  if (team.mode === 'debate') return team.members.length * team.maxRounds + 1;
  if (team.mode === 'review') return team.members.length * team.maxRounds;
  return team.members.length;
}
let sequence = 0;
export function createNodeTeamMember(overrides: Partial<Omit<NodeTeamMember, 'id' | 'tools'>> = {}): NodeTeamMember {
  sequence += 1;
  return { id: `member-${Date.now().toString(36)}-${sequence.toString(36)}`, name: 'Agent', role: 'Contributor',
    instructions: '', runtime: '', model: '', context: 'shared', ...overrides, tools: [] };
}
export function createNodeTeam(node: { title: string; persona: string; model: string; runtime?: string }, locale: 'zh' | 'en' = 'zh', fallbackRuntime: NodeTeamRuntime = 'mock'): NodeTeam {
  const zh = locale === 'zh';
  return { version: 1, mode: 'sequential', runtime: isNodeTeamRuntimeId(node.runtime) ? node.runtime : fallbackRuntime, maxRounds: 2, maxTurns: 8, timeoutSeconds: 300,
    members: [
      createNodeTeamMember({ name: node.title || (zh ? '执行者' : 'Worker'), role: zh ? '执行者' : 'Worker', instructions: node.persona, model: node.model }),
      createNodeTeamMember({ name: zh ? '复核与汇总' : 'Reviewer and summarizer', role: zh ? '复核与汇总' : 'Reviewer and summarizer',
        instructions: zh ? '检查已有结果，指出遗漏，汇总为符合节点输出要求的最终结果。' : 'Check the available results, identify omissions, and produce a final result that satisfies the node output requirements.' }),
    ],
  };
}
