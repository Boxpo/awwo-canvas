import { useEffect, useRef, useState } from 'react';
import type { SessionNode } from './canvasDoc';
import { modelLabel, modelLabels } from '../modelLabels';
import { useCanvasI18n } from './i18n';
import { NODE_TEAM_MODES, isNodeTeamRuntimeId, nodeTeamRuntimeLabel, createNodeTeam, createNodeTeamMember, nodeTeamTurnEstimate, validateNodeTeam, type NodeTeam, type NodeTeamEffortCatalogs, type NodeTeamMember, type NodeTeamMode, type NodeTeamRuntime, type NodeTeamTool, type NodeTeamModelCatalogs } from './nodeTeam';

/** An unset effort is omitted rather than stored as '' so saved teams keep their shape and fingerprint. */
const normalizeMember = ({ effort, ...member }: NodeTeamMember): NodeTeamMember => effort ? { ...member, effort } : member;
import './node-team.css';

type ReadJson = (path: string) => Promise<any>;
const COPY = {
  zh: {
    title: '节点协作团队', enable: '启用多 Agent 协作', unavailable: '当前运行环境未提供团队执行能力。',
    mode: '协作方式', runtime: '团队默认执行框架', rounds: '最多轮数', turns: '最多模型调用次数', timeout: '节点超时（秒）',
    inherit: '继承团队默认', defaultModel: '继承节点已绑定模型', runtimeDefaultModel: '使用此执行框架的服务默认模型', model: '模型', memberRuntime: '执行框架',
    effort: '思考强度', effortDefault: '不指定（使用模型默认）', effortNeedsModel: '留空模型时继承节点模型及其思考强度；选择明确的模型后才可单独设置。', effortUnavailable: '当前模型不提供：',
    name: '名称', role: '职责', instructions: '专属指令', context: '可见上下文', task: '仅当前任务（含节点输入）', shared: '当前会话历史与本次运行前序成果',
    add: '添加 Agent', remove: '删除 Agent', up: '上移 Agent', down: '下移 Agent', member: 'Agent',
    loading: '正在读取模型清单…', failed: '模型清单读取失败；确认连接后重试。', retry: '重试模型清单', unknownModel: '当前清单不可用：',
    tools: '当前成员仅能生成文本；工具、文件读写和 Shell 尚不可用。',
    toolLabel: '允许的工具', calculator: '计算器（受限算术表达式）', current_time: '当前时间（UTC）',
    agentsNote: 'OpenAI Agents JS 由服务端执行，可按成员启用目录列出的受控工具。调用工具时，工具结果直接成为本成员结果，不再进行模型总结。不提供任意代码、文件或 Shell 执行。Pi 保持文本推理。思考强度仅在所选模型发布了档位时可选。',
    runtimeMissing: '此执行框架未在当前服务目录中启用。', toolMissing: '当前服务目录未提供此工具，请取消选择。',
    retained: '原有单 Agent 配置与会话保留。手动发送和画布运行都会执行团队；聊天主回复显示最终结果，运行过程可查看每位成员的实际发言。',
    contextNote: '共享会话历史指当前会话已完成的用户问答与团队最终结果，不包含此前所有成员的发言。仅当前任务不带这些历史或普通前序成果；汇总、审核及返工仍接收必要的团队结果和审核意见。实际提供或截取的内容可在运行过程中查看。',
    budget: '计划最多 {count} 次调用；达到调用次数或超时上限即停止，未完成的结果不会发布给下游。',
    budgetShort: '调用次数上限低于完整流程所需次数，任务可能提前停止。',
    errors: '请修正团队配置后再保存：', invalid: '配置无效',
    modes: { sequential: '顺序执行', parallel: '并行汇总', debate: '多轮讨论', review: '审核与返工' },
    descriptions: {
      sequential: '成员按列表顺序执行；全部成功后，最后一位的输出成为节点最终结果。共享上下文可接力读取当前会话历史和本次运行的前序成员成果；仅当前任务则独立处理。',
      parallel: '前面的成员独立并行执行；最后一位等待全部完成，读取各方结果并汇总。',
      debate: '每轮按列表顺序讨论；共享上下文的成员可见已有讨论。完成指定轮数后，最后一位额外汇总，作为节点最终结果。',
      review: '前面的成员依次处理任务，最后一位审核。审核通过时，其批准的交付成为最终结果；未通过则把审核意见交回返工，直到通过或达到轮数上限。',
    },
  },
  en: {
    title: 'Node collaboration team', enable: 'Enable multiple Agents', unavailable: 'The current runtime does not provide team execution.',
    mode: 'Collaboration mode', runtime: 'Team default harness', rounds: 'Maximum rounds', turns: 'Maximum model calls', timeout: 'Node timeout (seconds)',
    inherit: 'Inherit team default', defaultModel: 'Inherit bound node model', runtimeDefaultModel: 'Use this runtime’s server default model', model: 'Model', memberRuntime: 'Harness',
    effort: 'Reasoning effort', effortDefault: 'Not set (model default)', effortNeedsModel: 'An empty model inherits the node model together with its reasoning effort; choose an explicit model to set a member effort.', effortUnavailable: 'Not offered by this model: ',
    name: 'Name', role: 'Responsibility', instructions: 'Member instructions', context: 'Visible context', task: 'Current task only (including node inputs)', shared: 'Current session history and earlier results in this run',
    add: 'Add Agent', remove: 'Remove Agent', up: 'Move Agent up', down: 'Move Agent down', member: 'Agent',
    loading: 'Loading model catalogs…', failed: 'Could not load models. Check the connection and retry.', retry: 'Retry model catalog', unknownModel: 'Unavailable in current catalog: ',
    tools: 'Members currently generate text only. Tools, file access, and Shell are unavailable.',
    toolLabel: 'Allowed tools', calculator: 'Calculator (restricted arithmetic)', current_time: 'Current time (UTC)',
    agentsNote: 'OpenAI Agents JS runs on the server, with catalog-listed tools enabled per member. A tool call returns its result as that member’s output without another model summary. It does not provide arbitrary code, file, or Shell execution. Pi retains text inference. Reasoning effort is selectable only for a model that advertises levels.',
    runtimeMissing: 'This runtime is not enabled in the current service catalog.', toolMissing: 'This tool is absent from the current service catalog. Deselect it.',
    retained: 'Single-Agent settings and conversations are preserved. Both chat sends and canvas runs execute the team. The main reply shows the final result; run details show each member’s actual response.',
    contextNote: 'Shared session history includes completed user exchanges and final team replies in this session, not every earlier member response. Task only excludes that history and ordinary earlier results; aggregation, review and revision still receive required team results and feedback. Inspect run details to see the actual included or truncated content.',
    budget: 'Up to {count} planned calls. Reaching the call or timeout limit stops execution; incomplete results are not published downstream.',
    budgetShort: 'The call limit is below the full plan estimate, so execution may stop early.',
    errors: 'Correct the team settings before saving:', invalid: 'Invalid configuration',
    modes: { sequential: 'Sequential', parallel: 'Parallel and aggregate', debate: 'Multi-round discussion', review: 'Review and revise' },
    descriptions: {
      sequential: 'Members execute in order. If all succeed, the last member’s output becomes the final node result. Shared context passes along current session history and earlier results in this run; task-only members work independently.',
      parallel: 'Earlier members work independently in parallel. The final member reads all results and aggregates them.',
      debate: 'Members discuss in order each round; shared context includes the discussion so far. After all rounds, the final member makes an additional summary that becomes the final node result.',
      review: 'Earlier members work in order, then the final member reviews. Its approved deliverable becomes the final result; otherwise feedback is returned for revision until approval or the round limit.',
    },
  },
} as const;

export function nodeTeamModeLabel(mode: NodeTeamMode, locale: 'zh' | 'en'): string {
  return COPY[locale].modes[mode];
}
/** Known tools have translated labels; a tool a hot-plugged worker advertises is shown by its id. */
function toolLabel(copy: (typeof COPY)[keyof typeof COPY], tool: string): string {
  const label = (copy as unknown as Record<string, unknown>)[tool];
  return typeof label === 'string' ? label : tool;
}
export function NodeTeamEditor({ node, available, runtimes = ['pi'], runtimeTools = {}, readJson, disabled = false, onChange, onValidityChange }: {
  node: SessionNode; available: boolean; readJson?: ReadJson; disabled?: boolean;
  runtimes?: readonly NodeTeamRuntime[]; runtimeTools?: Partial<Record<NodeTeamRuntime, readonly NodeTeamTool[]>>;
  onChange: (team: NodeTeam | undefined) => void; onValidityChange?: (valid: boolean) => void;
}) {
  const { locale } = useCanvasI18n();
  const t = COPY[locale];
  const team = node.team;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const readRef = useRef(readJson);
  readRef.current = readJson;
  const [catalogState, setCatalogState] = useState<{ key: string; models: NodeTeamModelCatalogs; efforts: NodeTeamEffortCatalogs; labels: Partial<Record<NodeTeamRuntime, Record<string, string>>>; failed: string[] } | null>(null);
  const [retry, setRetry] = useState(0);
  const hasTeam = Boolean(team);
  const requestedRuntimes = team ? [...new Set([team.runtime, ...team.members.map(member => member.runtime || team.runtime)])].filter(isNodeTeamRuntimeId).sort() : [];
  const catalogKey = `${node.id}:${requestedRuntimes.join(',')}:${retry}`;
  const catalogs = catalogState?.key === catalogKey ? catalogState.models : {};
  const effortCatalogs: NodeTeamEffortCatalogs = catalogState?.key === catalogKey ? catalogState.efforts : {};
  const catalogFailed = catalogState?.key === catalogKey ? catalogState.failed : [];
  const catalogsReady = requestedRuntimes.every(runtime => catalogs[runtime] !== undefined);
  useEffect(() => {
    if (!hasTeam || !available || !readRef.current) return;
    let stale = false;
    const read = readRef.current;
    void Promise.all(requestedRuntimes.map(async runtime => {
      try {
        const data = await read(`/api/runtimes/${encodeURIComponent(runtime)}/models`);
        if (!Array.isArray(data?.models) || data.models.some((model: unknown) => typeof model !== 'string' || !model.trim())) throw new Error('Invalid catalog');
        const models = [...new Set<string>(data.models)];
        // Effort levels belong to one model. A malformed advertisement offers no level at all.
        const capabilities: Record<string, { effort_levels?: unknown }> = data?.model_capabilities !== null && typeof data?.model_capabilities === 'object' ? data.model_capabilities : {};
        const efforts: Record<string, string[]> = Object.fromEntries(models.flatMap(model => {
          const levels = capabilities[model]?.effort_levels;
          return Array.isArray(levels) && levels.length && levels.every(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)) ? [[model, [...new Set<string>(levels)]]] : [];
        }));
        return { runtime, models, efforts, labels: modelLabels(data?.model_labels) };
      } catch { return { runtime, models: null, efforts: null, labels: null }; }
    })).then(results => {
      if (!stale) setCatalogState({ key: catalogKey,
        models: Object.fromEntries(results.filter(result => result.models !== null).map(result => [result.runtime, result.models])),
        efforts: Object.fromEntries(results.filter(result => result.efforts !== null).map(result => [result.runtime, result.efforts])),
        labels: Object.fromEntries(results.filter(result => result.labels !== null).map(result => [result.runtime, result.labels])),
        failed: results.filter(result => result.models === null).map(result => result.runtime) });
    });
    return () => { stale = true; };
  }, [hasTeam, available, catalogKey]);
  const issues = team ? validateNodeTeam(team, catalogs, locale, effortCatalogs) : [];
  if (team && !runtimes.includes(team.runtime)) issues.push({ path: 'runtime', message: t.runtimeMissing });
  team?.members.forEach((member, index) => {
    const runtime = member.runtime || team.runtime;
    if (!runtimes.includes(runtime)) issues.push({ path: `members.${index}.runtime`, message: t.runtimeMissing });
    if (member.tools.some(tool => !(runtimeTools[runtime] ?? []).includes(tool))) issues.push({ path: `members.${index}.tools`, message: t.toolMissing });
  });
  const issueLabel = (path: string) => {
    const fields: Record<string, string> = { mode: t.mode, runtime: t.runtime, maxRounds: t.rounds,
      maxTurns: t.turns, timeoutSeconds: t.timeout, name: t.name, role: t.role,
      instructions: t.instructions, model: t.model, effort: t.effort, context: t.context, tools: t.toolLabel };
    const memberField = path.match(/^members\.(\d+)(?:\.(.+))?$/);
    if (memberField) return `${t.member} ${Number(memberField[1]) + 1}${fields[memberField[2]] ? ` · ${fields[memberField[2]]}` : ''}`;
    return fields[path] ?? t.title;
  };
  const valid = !team || (issues.length === 0 && available && catalogsReady);
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  const change = (next: NodeTeam | undefined) => { if (!disabledRef.current) onChange(next); };
  const edit = (patch: Partial<NodeTeam>) => { if (team) change({ ...team, ...patch }); };
  const editMember = (index: number, patch: Partial<NodeTeamMember>) => {
    if (team) edit({ members: team.members.map((member, position) => position === index ? normalizeMember({ ...member, ...patch }) : member) });
  };
  const move = (index: number, offset: number) => {
    if (!team || index + offset < 0 || index + offset >= team.members.length) return;
    const members = [...team.members];
    [members[index], members[index + offset]] = [members[index + offset], members[index]];
    edit({ members });
  };
  return <section className="node-team-editor" aria-label={t.title}>
    <label className="node-team-enable"><input type="checkbox" checked={Boolean(team)} disabled={disabled || (!team && !available)}
      onChange={event => change(event.target.checked ? createNodeTeam(node, locale) : undefined)} />{t.enable}</label>
    {!available ? <p className="canvas-inspector-hint">{t.unavailable}</p> : null}
    {team ? <>
      <p className="canvas-inspector-hint">{t.retained}</p>
      <label>{t.mode}<select className="canvas-inspector-input" value={team.mode} disabled={disabled}
        onChange={event => edit({ mode: event.target.value as NodeTeamMode })}>
        {NODE_TEAM_MODES.map(mode => <option key={mode} value={mode}>{t.modes[mode]}</option>)}
      </select></label>
      <p className="canvas-inspector-hint">{t.descriptions[team.mode]}</p>
      <p className="canvas-inspector-hint">{t.contextNote}</p>
      <label>{t.runtime}<select className="canvas-inspector-input" value={team.runtime} disabled={disabled}
        onChange={event => edit({ runtime: event.target.value as NodeTeamRuntime, members: team.members.map(member => member.runtime ? member : normalizeMember({ ...member, model: '', effort: '', tools: [] })) })}>
        {!runtimes.includes(team.runtime) ? <option value={team.runtime} disabled>{nodeTeamRuntimeLabel(team.runtime)} · {t.runtimeMissing}</option> : null}
        {runtimes.map(runtime => <option key={runtime} value={runtime}>{nodeTeamRuntimeLabel(runtime)}</option>)}
      </select></label>
      {runtimes.includes('openai-agents') || requestedRuntimes.includes('openai-agents') ? <p className="canvas-inspector-hint">{t.agentsNote}</p> : null}
      <div className="node-team-limits">
        <label>{t.rounds}<input className="canvas-inspector-input" type="number" min={1} max={8} step={1} value={Number.isNaN(team.maxRounds) ? '' : team.maxRounds}
          disabled={disabled || team.mode === 'sequential' || team.mode === 'parallel'} onChange={event => edit({ maxRounds: event.target.valueAsNumber })} /></label>
        <label>{t.turns}<input className="canvas-inspector-input" type="number" min={1} max={64} step={1} value={Number.isNaN(team.maxTurns) ? '' : team.maxTurns}
          disabled={disabled} onChange={event => edit({ maxTurns: event.target.valueAsNumber })} /></label>
        <label>{t.timeout}<input className="canvas-inspector-input" type="number" min={10} max={1800} step={1} value={Number.isNaN(team.timeoutSeconds) ? '' : team.timeoutSeconds}
          disabled={disabled} onChange={event => edit({ timeoutSeconds: event.target.valueAsNumber })} /></label>
      </div>
      <p className="canvas-inspector-hint">{t.budget.replace('{count}', String(nodeTeamTurnEstimate(team)))}</p>
      {nodeTeamTurnEstimate(team) > team.maxTurns ? <p className="canvas-inspector-outcome canvas-inspector-outcome--warn">{t.budgetShort}</p> : null}
      {catalogFailed.length ? <div className="canvas-inspector-outcome canvas-inspector-outcome--err">{catalogFailed.map(nodeTeamRuntimeLabel).join(', ')} {t.failed} <button type="button" disabled={disabled} onClick={() => { if (!disabledRef.current) setRetry(value => value + 1); }}>{t.retry}</button></div>
        : !catalogsReady && available ? <p role="status">{t.loading}</p> : null}
      <div className="node-team-members">
        {team.members.map((member, index) => {
          const runtime = member.runtime || team.runtime;
          const catalog = catalogs[runtime];
          const runtimeEfforts = effortCatalogs[runtime] ?? {};
          const effortLevels = member.model ? runtimeEfforts[member.model] ?? [] : [];
          const runtimeOffersEffort = Object.keys(runtimeEfforts).length > 0;
          // Open-source edition: any runtime may advertise tools in its health catalog.
          const tools = [...new Set([...(runtimeTools[runtime] ?? []), ...member.tools])];
          return <fieldset className="node-team-member" key={member.id} disabled={disabled}>
          <legend>{t.member} {index + 1}</legend>
          <div className="node-team-member-actions">
            <button type="button" aria-label={`${t.up} ${index + 1}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" aria-label={`${t.down} ${index + 1}`} disabled={disabled || index === team.members.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button type="button" aria-label={`${t.remove} ${index + 1}`} disabled={disabled || team.members.length <= 1} onClick={() => edit({ members: team.members.filter((_, position) => position !== index) })}>×</button>
          </div>
          <label>{t.name}<input className="canvas-inspector-input" value={member.name} maxLength={128} onChange={event => editMember(index, { name: event.target.value })} /></label>
          <label>{t.role}<input className="canvas-inspector-input" value={member.role} maxLength={512} onChange={event => editMember(index, { role: event.target.value })} /></label>
          <label>{t.instructions}<textarea className="canvas-inspector-persona" rows={3} value={member.instructions} maxLength={16000} onChange={event => editMember(index, { instructions: event.target.value })} /></label>
          <label>{t.memberRuntime}<select className="canvas-inspector-input" value={member.runtime} onChange={event => editMember(index, { runtime: event.target.value as '' | NodeTeamRuntime, model: '', effort: '', tools: [] })}>
            <option value="">{t.inherit}（{nodeTeamRuntimeLabel(team.runtime)}）</option>
            {member.runtime && !runtimes.includes(member.runtime) ? <option value={member.runtime} disabled>{nodeTeamRuntimeLabel(member.runtime)} · {t.runtimeMissing}</option> : null}
            {runtimes.map(runtime => <option key={runtime} value={runtime}>{nodeTeamRuntimeLabel(runtime)}</option>)}
          </select></label>
          <label>{t.model}<select className="canvas-inspector-input" value={member.model} disabled={disabled || !catalog || !available}
            // A level is not portable across models: keep it only when the newly chosen model offers it too.
            onChange={event => editMember(index, { model: event.target.value, effort: member.effort && (runtimeEfforts[event.target.value] ?? []).includes(member.effort) ? member.effort : '' })}>
            <option value="">{runtime === (node.runtime || runtimes[0]) ? t.defaultModel : t.runtimeDefaultModel}</option>
            {member.model && !catalog?.includes(member.model) ? <option value={member.model} disabled>{t.unknownModel}{member.model}</option> : null}
            {(catalog ?? []).map(model => <option key={model} value={model}>{modelLabel(model, catalogState?.key === catalogKey ? catalogState.labels[runtime] : undefined)}</option>)}
          </select></label>
          {effortLevels.length || member.effort ? <label>{t.effort}<select className="canvas-inspector-input" value={member.effort ?? ''} disabled={disabled || !available || !effortLevels.length}
            onChange={event => editMember(index, { effort: event.target.value })}>
            <option value="">{t.effortDefault}</option>
            {member.effort && !effortLevels.includes(member.effort) ? <option value={member.effort} disabled>{t.effortUnavailable}{member.effort}</option> : null}
            {effortLevels.map(level => <option key={level} value={level}>{level}</option>)}
          </select></label> : null}
          {!member.model && runtimeOffersEffort ? <p className="canvas-inspector-hint">{t.effortNeedsModel}</p> : null}
          {tools.length ? <div className="node-team-tools"><span>{t.toolLabel}</span>{tools.map(tool => <label key={tool}>
            <input type="checkbox" checked={member.tools.includes(tool)} disabled={disabled} onChange={event => editMember(index, { tools: event.target.checked ? [...member.tools, tool] : member.tools.filter(value => value !== tool) })} />{toolLabel(t, tool)}
          </label>)}</div> : null}
          <label>{t.context}<select className="canvas-inspector-input" value={member.context} onChange={event => editMember(index, { context: event.target.value as 'task' | 'shared' })}>
            <option value="task">{t.task}</option><option value="shared">{t.shared}</option>
          </select></label>
        </fieldset>; })}
      </div>
      <button type="button" aria-label={t.add} className="canvas-inspector-add-field" disabled={disabled || team.members.length >= 8} onClick={() => edit({ members: [...team.members, createNodeTeamMember({ name: `Agent ${team.members.length + 1}`, role: locale === 'zh' ? '协作者' : 'Contributor' })] })}>＋ {t.add}</button>
      {!requestedRuntimes.some(runtime => (runtimeTools[runtime] ?? []).length) ? <p className="canvas-inspector-hint">{t.tools}</p> : null}
      {issues.length ? <div role="alert" className="canvas-inspector-outcome canvas-inspector-outcome--err"><strong>{t.errors}</strong><ul>{issues.map(issue => <li key={`${issue.path}-${issue.message}`}>{issueLabel(issue.path)}: {issue.message}</li>)}</ul></div> : null}
    </> : null}
  </section>;
}
