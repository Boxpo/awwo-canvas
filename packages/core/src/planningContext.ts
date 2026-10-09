// Canvas planning context — the half of AwwO's planner "skill" that lives with the canvas.
//
// Extracted from AwwO apps/web/src/canvas/canvasPlanning.ts. The browser describes the CURRENT
// canvas (structure only: no credentials, transcripts or generated artifacts), the closed
// operation protocol and the component templates; the server adds the planner's system
// instructions (skills/canvas-planner/SKILL.md), runs one model call, and returns a proposal that
// `parseCanvasPlan` + `applyCanvasPlan` validate against the document before ONE undoable change.
//
// Removed here: the SaaS gateway transport, tenant-scoped recovery and the SaaS-only protocol
// subset. The open-source orchestrator executes review graphs, so the full protocol is offered.

import { AGENT_TEMPLATE_IDS, getAgentTemplateForNode, getAgentTemplates } from './agentTemplates';
import type { CanvasDocument } from './canvasDoc';
import { CANVAS_PLAN_NODE_OPERATION_TYPES, CANVAS_PLAN_OPERATION_TYPES, CANVAS_PLAN_PROTOCOL, type CanvasPlanOperationType } from './canvasPlan';
import type { UiLocale } from './locale';
import { canvasStorage } from './storage';

export interface PlanningMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** `unconfirmed`: a task that may have started; the host reconciles it. */
  status?: 'applied' | 'error' | 'stale' | 'unconfirmed';
  /** How the router handled this turn (see assistantRoute.ts). */
  route?: 'plan' | 'execute';
  /** The task an executed turn started; the host draws it. */
  taskId?: string;
  /** The nodes an applied plan added: while none of them is on the canvas, the plan counts as undone. */
  nodes?: string[];
}

/** The turns the planner reads: an executed turn is the task's business, not the canvas's. */
export const planningTurns = (messages: PlanningMessage[]) => messages.filter(message => message.route !== 'execute');
export interface PlanningConversation { draft: string; messages: PlanningMessage[] }
export const PLANNING_STORAGE_KEY = 'awwo.canvas.planning.v1';

/** Observed planner progress. Every field is a real measurement, never an estimated percentage:
 * the runtime does not know the plan's final length, so a completion ratio would be fabricated. */
export interface PlanProgress {
  /** queued = accepted, waiting for a runtime slot; running = runtime started, nothing observed yet;
   *  thinking = the model is reasoning before it writes; streaming = the plan is being written;
   *  validating = the plan arrived and is being checked; retrying = a malformed plan is being retried. */
  stage: 'queued' | 'running' | 'thinking' | 'streaming' | 'validating' | 'retrying';
  /** Characters of plan text written so far. */
  characters: number;
  /** Nodes the proposal has declared so far (counted from whole add_node markers). */
  nodes: number;
  /** Connections the proposal has declared so far (counted from whole connect markers). */
  edges: number;
  /** Characters of reasoning the model produced before writing; a count, never its text. */
  reasoning: number;
  /** Template id of the node declared most recently, when the host observed one. */
  template?: string;
  /** Kind of operation the proposal is writing now, when the host observed one. */
  operation?: CanvasPlanOperationType;
  /** Template id of the node that operation concerns, when the proposal itself declared that node. */
  target?: string;
  /** 1 for the first attempt, 2 for the single retry of a malformed plan. */
  attempt: number;
}
export type PlanProgressReporter = (progress: PlanProgress) => void;

const PLAN_STAGES: ReadonlyArray<PlanProgress['stage']> = ['queued', 'running', 'thinking', 'streaming', 'validating', 'retrying'];
const validCount = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The progress a host reported, merged over what was already observed. Counts that are
 * missing or malformed keep their previous value, so a bad frame cannot erase real work. */
export function observedProgress(frame: Record<string, unknown>, previous: PlanProgress): PlanProgress {
  const count = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
  const stage = PLAN_STAGES.includes(frame.stage as PlanProgress['stage']) ? frame.stage as PlanProgress['stage'] : previous.stage;
  const template = typeof frame.template === 'string' && AGENT_TEMPLATE_IDS.has(frame.template) && validCount(frame.nodes)
    ? frame.template : undefined;
  const operation = typeof frame.operation === 'string' && CANVAS_PLAN_OPERATION_TYPES.has(frame.operation)
    ? frame.operation as CanvasPlanOperationType : undefined;
  const target = operation && CANVAS_PLAN_NODE_OPERATION_TYPES.has(operation) && typeof frame.target === 'string'
    && AGENT_TEMPLATE_IDS.has(frame.target) ? frame.target : undefined;
  return { stage, characters: count(frame.characters, previous.characters), nodes: count(frame.nodes, previous.nodes),
    edges: count(frame.edges, previous.edges), reasoning: count(frame.reasoning, previous.reasoning),
    ...(template ? { template } : {}), ...(operation ? { operation } : {}), ...(target ? { target } : {}), attempt: previous.attempt };
}

export function loadPlanningConversation(): PlanningConversation {
  try {
    const raw = JSON.parse(canvasStorage().getItem(PLANNING_STORAGE_KEY) || '{}');
    return {
      draft: typeof raw.draft === 'string' ? raw.draft.slice(0, 8_000) : '',
      messages: Array.isArray(raw.messages) ? raw.messages.filter((item: unknown): item is PlanningMessage => {
        if (!item || typeof item !== 'object') return false;
        const m = item as PlanningMessage;
        return typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
          && m.content.length <= 20_000 && (m.status === undefined || ['applied', 'error', 'stale', 'unconfirmed'].includes(m.status))
          && (m.route === undefined || m.route === 'plan' || m.route === 'execute')
          && (m.taskId === undefined || (typeof m.taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(m.taskId)))
          && (m.nodes === undefined || (Array.isArray(m.nodes) && m.nodes.length <= 200 && m.nodes.every(node => typeof node === 'string' && node.length <= 200)));
      }).slice(-60) : [],
    };
  } catch { return { draft: '', messages: [] }; }
}

export function savePlanningConversation(value: PlanningConversation): void {
  try { canvasStorage().setItem(PLANNING_STORAGE_KEY, JSON.stringify({ draft: value.draft, messages: value.messages.slice(-60) })); }
  catch { /* The current conversation remains in memory if local persistence is unavailable. */ }
}

/** Supply the current structure, never execution credentials, transcripts or generated artifacts. */
export function buildPlanningContext(doc: CanvasDocument, messages: PlanningMessage[], locale: UiLocale = 'zh'): string {
  const graph = {
    nodes: doc.nodes.map(node => {
      if (node.kind === 'form') return { id: node.id, kind: node.kind, title: node.title, fields: node.fields };
      const template = getAgentTemplateForNode(node, locale);
      return { id: node.id, templateId: template?.id, title: node.title,
        // Templates already declare responsibilities below. Preserve only user-authored differences.
        ...(node.persona !== template?.persona ? { persona: node.persona } : {}),
        inputs: node.contract?.inputs.map(({ id, label, type, required, value }) => ({ id, label, type, required, value })),
        outputs: node.contract?.outputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
      };
    }),
    edges: doc.edges.map(({ id, fromNode, fromPort, toNode, toPort, kind }) => ({ id, fromNode, fromPort, toNode, toPort, kind: kind ?? 'data' })),
    execution: doc.execution ? { mode: doc.execution.mode, maxRounds: doc.execution.maxRounds,
      reviewerNodeId: doc.execution.reviewerNodeId, verdictFieldId: doc.execution.verdictFieldId } : { mode: 'workflow' },
  };
  const templates = getAgentTemplates(locale).map(item => ({ id: item.id, title: item.title, responsibility: item.subtitle,
    inputs: item.inputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
    outputs: item.outputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
  }));
  const guidance = locale === 'en' ? [
    'You are the AwwO canvas architecture assistant. Arrange independent Agent nodes, input/output contracts, and real dependencies around the user goal. Produce a structural plan, not execution results.',
    'Software products commonly need data, backend, identity, frontend, and review responsibilities; select only what the request needs. Put core business requirements in the root node input and pass downstream inputs through exact field connections. '
      + 'For iterative challenges and verification, add explicit feedback edges and a bounded review policy with a boolean verdict output; first-round feedback inputs should be optional or have an explicit seed. Use html or markdown output types when those document formats are requested. '
      + 'Choose the actual deliverable for each role: complete HTML for websites or games, Markdown for reports, real files for 3D models, Agent source or projects. Keep meaningful handoffs and connect actual artifacts as well as their explanations to downstream reviewers. Roles are independent execution responsibilities, not fixed frontend/backend limitations. Requirements do not install tools; do not promise execution, archives or tests that the runtime cannot perform. Mark unknown information for confirmation. Never invent completed files, accounts, or APIs.',
    'The current canvas is the source of truth and may contain manual edits or undo results. Nodes without persona use their template responsibility. On a non-empty canvas, make the smallest relevant change and retain unrelated nodes and existing content. Delete only when the user asks. Reference existing nodes by ID, never by a guessed name. A new-node ref exists only within this operation list.',
    'Return protocol JSON only. Write summary in concise English and include any necessary open question. Do not call tools or execute the project. When information is insufficient, return empty operations and ask one concrete question in summary.',
    'Component templates', 'Current canvas', 'Conversation context (intent only; current canvas takes precedence)',
  ] : [
    '你是 AwwO 的画布架构助手。根据用户目标安排独立 Agent 节点、输入输出契约和真实依赖。生成的是结构方案，不是执行成果。',
    '软件产品通常包含数据、后端、用户身份、前端、验收等职责；根据需求选用，内容任务不必强行创建软件节点。核心业务需求应写入根节点输入；下游输入通过准确的字段连线接收。'
      + '需要反复质疑验证时，添加明确feedback连线、有限轮次互审策略与boolean判定输出；首轮反馈输入应可选或有明确初始值。用户指定文档格式时使用html或markdown输出类型。'
      + '按每个角色的职责选择实际交付：网页或游戏使用完整HTML，报告使用Markdown，3D模型、Agent源码或工程使用真实file。保留有意义的交接说明，也把实际产物连接给下游验收者。角色代表独立执行职责，不限于前端或后端。交付要求不会安装工具；不能承诺运行时无法执行的操作、归档或测试。对未知信息写明待确认，不虚构已完成的文件、账户或接口。',
    '当前画布是事实来源，可能已经被用户手工调整或撤销。未列persona的节点沿用模板职责。非空画布优先做最小增量修改，保留无关节点与已有内容；只有用户要求删除时才删除。使用已有节点ID引用，不按名称猜ID。新建节点ref仅供本次操作引用。',
    '只返回协议JSON。summary用简洁中文说明本次结构改动及必要的待确认事项。不要调用工具或执行项目。没有足够信息可返回空operations并在summary提出一个具体问题。',
    '组件模板', '当前画布', '对话上下文（仅作意图参考，以当前画布为准）',
  ];
  return [
    CANVAS_PLAN_PROTOCOL,
    ...guidance.slice(0, 4),
    `${guidance[4]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(templates)}`,
    `${guidance[5]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(graph)}`,
    `${guidance[6]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(planningTurns(messages).slice(-10).map(({ role, content, status }) => ({ role, content, status })))}`,
  ].join('\n\n');
}
