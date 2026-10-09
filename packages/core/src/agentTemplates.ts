import { createSessionNode, type CanvasEdge, type CanvasNode, type SessionNode } from './canvasDoc';
import { edgeId } from './ports';
import type { ContractField, ContractFieldType } from './nodeContracts';
import type { UiLocale } from './locale';
import { EN_AGENT_TEMPLATES } from './agentTemplates.en';

export type AgentTemplateId = 'general' | 'frontend' | 'backend' | 'data' | 'users' | 'materials' | 'review';
export const AGENT_TEMPLATE_VERSION = 1;

export interface AgentTemplate {
  id: AgentTemplateId;
  title: string;
  subtitle: string;
  tag: string;
  persona: string;
  /** Core port tuples retained for hosts that have not adopted the full forms yet. */
  input: [string, string];
  output: [string, string];
  inputs: ContractField[];
  outputs: ContractField[];
  workflow: string[];
  checklist: string[];
  starterPrompts: { label: string; prompt: string }[];
  deliverableTitle: string;
  emptyTitle: string;
  emptyDescription: string;
}

const field = (id: string, label: string, required: boolean, placeholder: string, help: string, type: ContractFieldType = 'markdown'): ContractField =>
  ({ id, label, type, required, value: '', placeholder, help });

function template(spec: Omit<AgentTemplate, 'input' | 'output'>): AgentTemplate {
  return { ...spec,
    input: [spec.inputs[0].id, spec.inputs[0].label], output: [spec.outputs[0].id, spec.outputs[0].label],
    persona: `${spec.persona}\n\n工作步骤：\n${spec.workflow.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n验收要求：\n${spec.checklist.map(item => `- ${item}`).join('\n')}\n\n证据口径：区分已验证、未验证和受阻事项；引用实际检查记录或文件，缺少证据时写明缺口。不要把计划、示例或占位内容描述为已完成结果。`,
  };
}

export const AGENT_TEMPLATES: ReadonlyArray<AgentTemplate> = [
  template({
    id: 'general', title: '自定义 Agent', subtitle: '把明确目标变成可验收的交付', tag: 'AGENT',
    persona: '负责用户定义的独立任务。先明确交付对象与边界，再分步执行；不擅自扩大任务范围。',
    inputs: [
      field('brief', '任务要求', true, '目标：\n交付对象：\n完成标准：', '说明要解决的问题，以及最后需要拿到什么。'),
      field('constraints', '限制与偏好', false, '必须遵守：\n不包含：\n表达风格：', '补充范围、格式或协作限制。'),
      field('references', '参考资料', false, '资料链接或文件路径', '引用已有资料；没有提供的内容不能视为已读取。', 'file'),
    ],
    outputs: [
      field('result', '交付结果', true, '完成内容：\n交付位置：\n验证结果：', '汇总实际完成的结果及可检查的证据。'),
      field('followups', '后续事项', false, '待确认问题：\n建议下一步：', '记录需要用户决策或另一个 Agent 继续的工作。'),
    ],
    workflow: ['确认目标、输入资料与完成标准', '拆分步骤并执行当前授权范围内的任务', '核对交付结果，列出证据与后续事项'],
    checklist: ['交付内容对应任务目标', '引用资料与生成文件可追溯', '未完成和未验证事项有明确说明'],
    starterPrompts: [
      { label: '梳理任务', prompt: '根据当前输入梳理目标、执行步骤和验收标准，列出真正阻碍推进的缺失信息。' },
      { label: '开始执行', prompt: '按任务要求逐步执行，保留交付位置与验证记录，最后说明完成、未验证和待确认事项。' },
    ],
    deliverableTitle: '任务交付', emptyTitle: '先说清楚想完成什么', emptyDescription: '填写任务要求，再让这个 Agent 从拆解到交付持续跟进。',
  }),
  template({
    id: 'frontend', title: '前端开发', subtitle: '从接口与设计到可操作的页面', tag: 'FRONTEND',
    persona: '负责前端页面、组件与交互实现。遵循接口契约与设计约束，不臆造接口字段，不把静态截图当作可运行界面。',
    inputs: [
      field('api', '接口契约', true, '接口：\n请求与响应字段：\n鉴权方式：\n错误约定：', '通常连接后端服务的接口契约；标明尚未确定的接口。'),
      field('screens', '页面与交互', false, '页面清单：\n关键操作：\n加载、空白与错误状态：', '描述用户如何完成任务，以及异常状态如何反馈。'),
      field('design', '设计参考', false, '设计稿、组件库或截图的链接 / 路径', '提供视觉与组件规范；缺少设计时说明采用的界面约定。', 'file'),
      field('assets', '文案与素材清单', false, '页面文案：\n素材路径：\n使用位置：', '可连接物料制作节点，引用真实文案与素材。'),
    ],
    outputs: [
      field('delivery', '界面与交付说明', true, '实现页面：\n代码位置：\n启动方式：\n已知限制：', '向验收节点交代实现范围、使用方法与实际文件。'),
      field('preview', '预览入口', false, '可访问的预览链接或本地入口路径', '只填写真实存在的入口，并注明访问条件。', 'file'),
      field('checks', '交互验证', false, '验证步骤：\n实际结果：\n设备与尺寸：\n未验证项：', '记录表单、键盘、响应式和错误状态的实际验证。'),
    ],
    workflow: ['核对页面需求、接口字段与设计参考', '实现组件、表单和加载 / 空白 / 错误状态', '验证关键操作、响应式与键盘可用性', '交付代码、预览入口和验证记录'],
    checklist: ['请求与响应遵循接口契约', '关键用户操作能完成且失败有反馈', '声明的设备尺寸与键盘路径有验证记录', '预览入口和代码位置真实可用'],
    starterPrompts: [
      { label: '梳理页面', prompt: '根据接口契约与页面要求，列出页面结构、组件职责和交互状态，指出接口或设计中的缺口。' },
      { label: '实现并验证', prompt: '实现当前页面与交互，接入已有接口和素材，验证主要用户路径，并交付可运行入口与验证记录。' },
    ],
    deliverableTitle: '界面交付', emptyTitle: '把需求变成可操作的界面', emptyDescription: '接入接口契约与设计参考，逐步完成页面和交互验证。',
  }),
  template({
    id: 'backend', title: '后端服务', subtitle: '数据模型、业务规则与稳定接口', tag: 'BACKEND',
    persona: '负责业务服务、数据访问和接口实现。根据数据字典确定业务实体与一致性边界；账号登录、角色定义和授权策略由用户系统节点提供，按该契约接入。',
    inputs: [
      field('schema', '数据字典', true, '实体与字段：\n字段类型与约束：\n实体关系：', '通常来自数据治理节点，是接口与存储设计的依据。'),
      field('rules', '业务规则', false, '业务动作：\n前置条件：\n状态变化：\n失败处理：', '说明流程、校验、幂等和一致性要求。'),
      field('systems', '外部依赖', false, '依赖服务：\n接口 / 事件契约：\n测试方式：', '包括用户系统的身份与授权契约，不重复设计账号体系。'),
      field('limits', '运行约束', false, '性能目标：\n存储约束：\n兼容要求：\n部署环境：', '记录明确的运行边界；未知指标保持待确认。'),
    ],
    outputs: [
      field('api', '接口契约', true, '接口与方法：\n请求 / 响应：\n校验和错误码：\n身份与权限要求：', '交付前端可直接消费的字段、调用方式与错误约定。'),
      field('implementation', '服务实现说明', false, '代码位置：\n数据变更：\n启动与配置：\n兼容说明：', '说明实际实现和必要配置，不把设计当作已部署服务。'),
      field('checks', '服务验证', false, '测试场景：\n实际结果：\n并发 / 重试验证：\n未验证项：', '记录业务规则、错误路径和数据一致性的证据。'),
    ],
    workflow: ['核对数据字典、业务规则和依赖契约', '设计接口、事务边界和失败处理', '实现服务与数据访问并验证关键规则', '交付接口契约、运行说明和测试证据'],
    checklist: ['接口字段与数据字典一致', '业务校验和错误码可被调用方使用', '身份与权限接入点遵循用户系统契约', '幂等、异常和数据变更有相应验证记录'],
    starterPrompts: [
      { label: '设计服务契约', prompt: '根据数据字典和业务规则设计接口、事务边界与错误约定，说明对用户系统和其他服务的依赖。' },
      { label: '实现业务服务', prompt: '按确认的契约实现业务服务，验证关键规则和失败路径，交付接口说明、运行方法及实际测试结果。' },
    ],
    deliverableTitle: '服务交付', emptyTitle: '先确定业务接口与边界', emptyDescription: '连接数据字典，补充业务规则，再实现可验证的后端服务。',
  }),
  template({
    id: 'data', title: '数据治理', subtitle: '让数据定义、质量与来源一致', tag: 'DATA',
    persona: '负责业务实体、字段口径、数据来源与质量规则。用可追溯的数据定义支撑其他节点；样本不足或来源不可访问时标明未验证，不推断真实生产数据分布。',
    inputs: [
      field('brief', '业务需求', true, '业务场景：\n核心实体：\n要回答的问题：', '说明数据服务的业务目的及需要统一的概念。'),
      field('sources', '数据来源', false, '来源系统：\n表 / 文件：\n更新方式：\n负责人：', '列明已有来源与访问条件，不在表单中填写密码。'),
      field('samples', '样本与现有字典', false, '样本文件或现有数据字典的路径 / 链接', '引用经过适当处理、允许用于当前任务的样本。', 'file'),
      field('governance', '治理边界', false, '访问角色：\n保留规则：\n敏感字段：\n口径约定：', '明确访问、质量和生命周期限制。'),
    ],
    outputs: [
      field('schema', '数据字典', true, '实体：\n字段 / 类型 / 必填：\n业务定义：\n关系与约束：', '向后端交付一致、可实现的字段与关系定义。'),
      field('quality', '质量规则与问题', false, '检查规则：\n观察结果：\n异常样本引用：\n修复建议：', '分清拟定规则与实际检查发现的问题。'),
      field('lineage', '来源与治理说明', false, '来源到字段的映射：\n访问边界：\n更新 / 保留规则：', '记录字段来源、处理过程和治理责任。'),
    ],
    workflow: ['梳理业务概念、数据来源和治理边界', '核对样本与现有口径，定义实体和字段', '制定并在可用样本上验证质量规则', '交付数据字典、问题清单和来源说明'],
    checklist: ['字段名称、类型与业务定义明确', '实体关系和约束可用于实现', '质量结论注明样本范围与检查证据', '来源、访问边界和未确认口径可追溯'],
    starterPrompts: [
      { label: '建立数据字典', prompt: '从业务需求和已有来源建立实体与字段字典，列出定义冲突、关系约束和需要确认的口径。' },
      { label: '检查数据质量', prompt: '根据提供的样本制定并执行可行的质量检查，区分实际发现与待验证规则，给出具体治理建议。' },
    ],
    deliverableTitle: '数据治理交付', emptyTitle: '让所有 Agent 使用同一份数据定义', emptyDescription: '从业务需求与真实来源开始，整理字典、质量规则和访问边界。',
  }),
  template({
    id: 'users', title: '用户系统', subtitle: '账号、角色与授权生命周期', tag: 'IDENTITY',
    persona: '负责账号生命周期、身份认证、角色与授权策略。明确组织或工作区边界、资源归属和权限撤销，向业务服务提供身份与授权契约；不接管通用业务接口实现。',
    inputs: [
      field('brief', '用户与权限需求', true, '用户类型：\n注册 / 登录方式：\n组织或工作区：\n主要权限场景：', '说明哪些人以什么身份访问哪些资源。'),
      field('roles', '角色与资源', false, '角色：\n资源：\n可执行动作：\n资源归属：', '按角色、资源、动作定义权限，不只列出角色名称。'),
      field('policies', '账号策略', false, '邀请与加入：\n禁用与删除：\n会话失效：\n权限撤销：', '补充账号和授权随生命周期变化的处理要求。'),
      field('identityProviders', '身份提供方', false, '已有账号系统：\n认证协议：\n回调与环境约束：', '描述现有身份服务与对接条件，密钥另行配置。'),
    ],
    outputs: [
      field('identity', '用户系统契约', true, '账号与身份模型：\n认证流程：\n会话与令牌约定：\n服务接入方式：', '供前后端与业务服务对接的认证和用户生命周期约定。'),
      field('permissions', '权限矩阵', false, '角色 × 资源 × 动作：\n作用域：\n拒绝规则：', '给出可用于实现及测试的授权矩阵。'),
      field('checks', '身份与权限验证', false, '登录 / 退出：\n越权与隔离：\n撤销与失效：\n实际结果：', '记录身份流程、跨作用域隔离和权限失效的检查。'),
    ],
    workflow: ['梳理用户类型、组织边界和账号生命周期', '定义认证流程、会话管理与权限矩阵', '实现或对接身份能力并验证隔离与撤销', '交付用户系统契约、权限矩阵和验证记录'],
    checklist: ['账号生命周期和异常流程有明确处理', '角色、资源与动作的授权关系完整', '作用域隔离及拒绝路径有验证证据', '退出、禁用与权限撤销的生效规则明确'],
    starterPrompts: [
      { label: '梳理权限模型', prompt: '根据用户需求和角色资源清单，建立权限矩阵、作用域边界和账号生命周期，列出缺失的授权决策。' },
      { label: '实现身份流程', prompt: '按确认的用户系统契约实现或接入身份流程，验证登录退出、权限隔离与撤销，并交付接入说明。' },
    ],
    deliverableTitle: '用户系统交付', emptyTitle: '明确谁能做什么', emptyDescription: '定义账号、角色与资源边界，形成其他服务可以遵循的身份契约。',
  }),
  template({
    id: 'materials', title: '物料制作', subtitle: '围绕渠道与受众制作可用内容', tag: 'CONTENT',
    persona: '负责文案、视觉要求和素材交付。围绕受众、渠道和品牌目标制作内容，注明素材来源与使用范围；只有实际存在的文件才能列为已生成素材。',
    inputs: [
      field('brief', '产品与品牌要求', true, '产品定位：\n核心信息：\n品牌语气：\n期望行动：', '明确物料表达什么，以及希望受众采取什么行动。'),
      field('audience', '目标受众', false, '受众特征：\n使用场景：\n关注点：\n语言：', '说明受众的语境与理解门槛。'),
      field('channels', '渠道与规格', false, '发布渠道：\n尺寸 / 格式：\n字数：\n数量：', '让物料对应具体渠道与可检查的交付规格。'),
      field('references', '品牌与素材参考', false, '品牌规范、已有素材或参考案例的路径 / 链接', '说明哪些参考允许使用，哪些只用于风格理解。', 'file'),
    ],
    outputs: [
      field('assets', '文案与素材清单', true, '物料名称：\n用途与渠道：\n实际文件 / 文案位置：\n完成状态：', '给前端或发布方列出可用内容及所在位置。'),
      field('copy', '可用文案', false, '主标题：\n正文：\n行动按钮：\n替代版本：', '提供可以直接使用、与受众和渠道匹配的文本。'),
      field('specifications', '制作与使用说明', false, '格式与尺寸：\n视觉要求：\n素材来源：\n使用限制：', '区分已制作文件、待制作要求和使用边界。'),
    ],
    workflow: ['确认受众、渠道规格与产品核心信息', '组织文案与视觉方向，核对参考资料', '制作已授权的内容与素材并检查规格', '交付实际内容清单、文案和使用说明'],
    checklist: ['每份物料对应明确受众和渠道', '文案语气、信息与行动目标一致', '声明完成的文件实际存在且规格可查', '素材来源、使用范围和待制作项已说明'],
    starterPrompts: [
      { label: '规划物料', prompt: '根据品牌要求、目标受众与渠道规格，列出本批物料清单、内容重点和制作顺序。' },
      { label: '制作与交付', prompt: '制作当前授权范围内的文案和素材，检查渠道规格，只把真实产出的内容写入交付清单，并注明待制作项。' },
    ],
    deliverableTitle: '内容与素材交付', emptyTitle: '为具体受众制作一批物料', emptyDescription: '先确定品牌信息与渠道规格，再交付可直接引用的文案和素材。',
  }),
  template({
    id: 'review', title: '交付验收', subtitle: '用明确标准核对实际交付', tag: 'REVIEW',
    persona: '负责独立验收输入的实现与交付物。按明确标准检查实际证据，输出可复现的问题及验收结论；证据不足不能给出通过结论，也不自行改写被验收结果。',
    inputs: [
      field('delivery', '待验收交付物', true, '交付范围：\n文件或预览入口：\n实现说明：\n已知限制：', '通常来自前端或其他生产节点，必须能定位实际交付。'),
      field('api', '接口契约', false, '接口字段：\n状态与错误约定：\n身份和权限要求：', '可连接后端服务，核对实现与接口约定的一致性。'),
      field('criteria', '验收标准', false, '验收场景：\n预期行为：\n通过条件：\n范围外事项：', '标准缺失时先提出可检查的标准并标明待确认。'),
      field('evidence', '验证证据', false, '测试报告、截图或操作记录的路径 / 链接', '引用真实证据，记录来源、时间和适用范围。', 'file'),
    ],
    outputs: [
      field('report', '验收报告', true, '结论：\n验收范围：\n已验证事实：\n未验证与受阻事项：', '区分通过、需修复及证据不足，不把缺少错误日志当作通过。'),
      field('issues', '问题与返工清单', false, '问题：\n复现步骤：\n预期 / 实际：\n影响：\n修复建议：', '让负责实现的 Agent 能直接定位和处理问题。'),
      field('verification', '检查记录', false, '检查项：\n使用证据：\n实际观察：\n覆盖限制：', '记录结论如何得出，保留未执行检查的原因。'),
    ],
    workflow: ['核对交付范围、验收标准与可访问证据', '逐项检查关键流程、契约一致性和异常路径', '复现问题并标明影响与返工建议', '输出有证据支持的结论及未验证范围'],
    checklist: ['每个验收结论对应具体标准和证据', '问题可复现并包含预期与实际行为', '证据不足、未执行及受阻项单独说明', '返工清单能指向负责的实现节点'],
    starterPrompts: [
      { label: '准备验收', prompt: '根据交付物、接口契约和已有标准整理验收清单，标出需要补充的入口、证据和通过条件。' },
      { label: '执行验收', prompt: '逐项检查当前交付，保留实际验证证据，输出验收结论、可复现问题和明确的未验证范围。' },
    ],
    deliverableTitle: '验收结果', emptyTitle: '先确定用什么证明完成', emptyDescription: '汇集交付物、标准与证据，让验收结论可以复核。',
  }),
];

const LEGACY_TITLES: Record<AgentTemplateId, ReadonlyArray<string>> = {
  general: ['自定义 Agent', 'Custom Agent'],
  frontend: ['前端开发', 'Frontend development'],
  backend: ['后端 / 用户系统', '后端服务', 'Backend services'],
  data: ['数据治理', 'Data governance'],
  users: ['用户系统', 'User system'],
  materials: ['物料制作', 'Content production'],
  review: ['交付验收', 'Delivery review'],
};

/** The closed template set; the only values planning progress may name a node with. */
export const AGENT_TEMPLATE_IDS: ReadonlySet<string> = new Set<AgentTemplateId>(['general', 'frontend', 'backend', 'data', 'users', 'materials', 'review']);

/** The legacy export remains Chinese so existing callers and saved documents keep their defaults. */
export function getAgentTemplates(locale: UiLocale): ReadonlyArray<AgentTemplate> {
  return locale === 'en' ? EN_AGENT_TEMPLATES : AGENT_TEMPLATES;
}

export function getAgentTemplate(id: AgentTemplateId, locale: UiLocale = 'zh'): AgentTemplate {
  const templates = getAgentTemplates(locale);
  return templates.find(item => item.id === id) ?? templates[0];
}

/** Resolve guidance only. Never migrate or replace the operator's existing contract/persona. */
export function getAgentTemplateForNode(node: CanvasNode, locale: UiLocale = 'zh'): AgentTemplate | undefined {
  if (node.kind !== 'session') return undefined;
  const templates = getAgentTemplates(locale);
  if (node.templateId) return templates.find(item => item.id === node.templateId);
  return templates.find(item => LEGACY_TITLES[item.id].includes(node.title)
    && node.contract?.inputs.some(input => input.id === item.input[0])
    && node.contract?.outputs.some(output => output.id === item.output[0]));
}

export function createAgentTemplate(id: AgentTemplateId, pos: { x: number; y: number }, locale: UiLocale = 'zh'): SessionNode {
  const selected = getAgentTemplate(id, locale);
  const node = createSessionNode(['frontend', 'backend', 'users'].includes(selected.id) ? 'coding' : 'llm', pos);
  return { ...node, title: selected.title, persona: selected.persona, w: 560, h: 420,
    templateId: selected.id, templateVersion: AGENT_TEMPLATE_VERSION,
    contract: { version: 1, inputs: selected.inputs.map(item => ({ ...item })), outputs: selected.outputs.map(item => ({ ...item })) },
  };
}

/** Creates local drafts only. No backend mutation, no messages, no invented outputs. */
export function createDevelopmentTemplate(pos: { x: number; y: number }, locale: UiLocale = 'zh'): { nodes: SessionNode[]; edges: CanvasEdge[] } {
  const data = createAgentTemplate('data', pos, locale);
  const backend = createAgentTemplate('backend', { x: pos.x + 380, y: pos.y }, locale);
  const frontend = createAgentTemplate('frontend', { x: pos.x + 760, y: pos.y }, locale);
  const materials = createAgentTemplate('materials', { x: pos.x + 380, y: pos.y + 240 }, locale);
  const review = createAgentTemplate('review', { x: pos.x + 760, y: pos.y + 240 }, locale);
  const connect = (from: SessionNode, fromField: string, to: SessionNode, toField: string): CanvasEdge => {
    const start = { nodeId: from.id, portId: `out:${fromField}` };
    const end = { nodeId: to.id, portId: `in:${toField}` };
    return { id: edgeId(start, end), fromNode: from.id, fromPort: start.portId, toNode: to.id, toPort: end.portId, dataType: 'text' };
  };
  return { nodes: [data, backend, frontend, materials, review], edges: [
    connect(data, 'schema', backend, 'schema'), connect(backend, 'api', frontend, 'api'),
    connect(materials, 'assets', frontend, 'assets'), connect(frontend, 'delivery', review, 'delivery'),
    connect(backend, 'api', review, 'api'),
  ] };
}
