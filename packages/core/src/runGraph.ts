// Canvas graph EXECUTION engine.
//
// Ported verbatim in behavior from the verified studio workflow engine (it runs in production
// today); only the node vocabulary changed — the canvas's node IS the agent session, so what
// was an 'agent' node is now a 'session' node, and the document types are the canvas ones.
//
// Turns the persisted graph into a real run: topological ordering over the wires, upstream
// outputs injected into each downstream agent's message as preconditions, independent branches
// running concurrently, and honest per-node states — a node is 'done' only when its agent's run
// actually succeeded; an upstream failure BLOCKS its downstream (reported as such, never
// silently skipped).
//
// The engine is transport-agnostic and pure-testable: the surface supplies `execAgent` (which
// rides the gateway conversation SSE — the same transport the tiles' composers use), and
// receives per-node status callbacks to drive badges. Nothing here fakes progress: every state
// change mirrors a real event.

import type { CanvasEdge, CanvasNode, FormNode, SessionNode } from './canvasDoc';
import { parseContractOutput, validateContractFields, type ContractField } from './nodeContracts';
import { reconcileEdges } from './ports';
import { validateNodeTeam } from './nodeTeam';

export type RunNodeState = 'waiting' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled' | 'cached';

export interface RunNodeStatus {
  state: RunNodeState;
  /** Transport ended without proof the native execution ended; recovery still owns the lock. */
  unconfirmed?: boolean;
  /** Honest context: failure detail, block reason, or the run's final status label. */
  detail?: string;
  /** The node's captured output (form serialization / the agent turn's streamed text). */
  output?: string;
}

export interface ExecAgentResult {
  ok: boolean;
  unconfirmed?: boolean;
  /** True only after the backing native run (or its not-yet-claimed wake) was confirmed stopped. */
  cancelled?: boolean;
  /** Streamed text (kept even on failure — a partial output is still evidence). */
  output: string;
  detail: string;
}

export interface RunGraphOptions {
  nodes: ReadonlyArray<CanvasNode>;
  /** RAW-id edges (already reconciled against current port specs). */
  edges: ReadonlyArray<CanvasEdge>;
  execAgent: (node: SessionNode, message: string) => Promise<ExecAgentResult>;
  onStatus: (nodeId: string, status: RunNodeStatus) => void;
  signal?: AbortSignal;
  /**
   * Which nodes this run is allowed to EXECUTE. Omitted = the whole canvas.
   *
   * Without this every press of 运行图 fired a real, billed agent turn on every tile — including
   * scratch tiles parked in a corner — so tuning the last node of a five-node pipeline re-ran the
   * four agents above it. Scoping is what makes the loop the product exists for (look at the
   * output, adjust one node, run just that node) possible at all.
   */
  scope?: ReadonlyArray<string>;
  /**
   * Output already stored on a node from an earlier run. An in-scope node always executes; an
   * out-of-scope upstream contributes THIS instead of running, and is reported as 'cached' —
   * never as 'done', because it did not run. An out-of-scope upstream with nothing stored is a
   * hard block with a named reason: sending an empty precondition downstream would be a lie the
   * agent cannot detect.
   */
  storedOutput?: (nodeId: string) => string | null;
}

export interface RunSummary {
  review?: { rounds: number; outcome: 'approved' | 'exhausted' | 'failed' | 'cancelled' | 'interrupted' };
  ok: boolean;
  done: number;
  failed: number;
  blocked: number;
  cancelled: number;
  /** Upstreams that contributed a stored output instead of executing. */
  cached: number;
  /** How many nodes this run was allowed to execute (the scope), not how many exist. */
  total: number;
}

/** Kahn topological check. Returns node ids stuck on a cycle ([] = acyclic). */
export function findCycle(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) continue;
    indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
    const arr = out.get(e.fromNode);
    if (arr) arr.push(e.toNode);
    else out.set(e.fromNode, [e.toNode]);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen += 1;
    for (const next of out.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return seen === nodes.length ? [] : [...indeg.entries()].filter(([, d]) => d > 0).map(([id]) => id);
}

/** Pre-flight problems that make a run impossible — reported up front, never mid-run. */
export type PreflightIssueCode = 'empty_graph' | 'empty_scope' | 'unbound_nodes' | 'multiple_inputs' | 'missing_inputs' | 'cycle' | 'invalid_team';
export interface PreflightIssue {
  code: PreflightIssueCode;
  values: Record<string, string | number | string[]>;
  /** Backward-compatible localized detail; new UI maps code+values through its locale catalog. */
  message: string;
}

export function preflightGraphIssue(
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
  scope?: ReadonlyArray<string>,
  /**
   * `requireBinding` (default true, AwwO behavior): a session node must be bound to a hired Agent.
   * The open-source orchestrator runs each session node directly on a registered runtime, so it
   * passes `false`; the runtime/model check then happens when the execution snapshot is frozen.
   */
  options: { conversation?: boolean; requireBinding?: boolean } = {},
): PreflightIssue | null {
  if (nodes.length === 0) return { code: 'empty_graph', values: {}, message: '画布上还没有节点。' };
  // Only nodes that will actually EXECUTE are validated. Refusing a whole run because an unwired
  // scratch tile in the corner has no agent bound made the canvas unusable as a place to think.
  const inScope = scope ? new Set(scope) : null;
  const runnable = inScope ? nodes.filter((n) => inScope.has(n.id)) : nodes;
  if (runnable.length === 0) return { code: 'empty_scope', values: {}, message: '没有选中要运行的节点。' };
  const unbound = options.requireBinding === false ? [] : runnable.filter((n): n is SessionNode => n.kind === 'session' && !n.binding);
  if (unbound.length) {
    const titles = unbound.map((n) => n.title);
    return { code: 'unbound_nodes', values: { count: unbound.length, titles }, message: `有 ${unbound.length} 个会话节点未绑定真实 Agent：${titles.join('、')}。先在配置里绑定。` };
  }
  const validEdges = reconcileEdges(nodes, edges);
  for (const node of runnable) {
    if (node.kind === 'session' && node.team) {
      const issues = validateNodeTeam(node.team);
      if (issues.length) return { code: 'invalid_team', values: { nodeTitle: node.title, detail: issues[0].message }, message: `「${node.title}」协作配置无效：${issues[0].message}` };
    }
    if (options.conversation || node.kind !== 'session' || !node.contract) continue;
    // Wired fields are checked once their actual values arrive. A missing or incompatible
    // source port must never stand in for a required value during preflight.
    const local: ContractField[] = [];
    for (const field of node.contract.inputs) {
      const incoming = validEdges.filter((edge) => edge.toNode === node.id && edge.toPort === `in:${field.id}`);
      if (incoming.length > 1) {
        const fieldName = field.label || field.id;
        return { code: 'multiple_inputs', values: { nodeTitle: node.title, field: fieldName }, message: `「${node.title}」输入「${fieldName}」只能连接一个来源。` };
      }
      if (!incoming.length) local.push(field);
    }
    const errors = validateContractFields(local);
    if (errors.length) return { code: 'missing_inputs', values: { nodeTitle: node.title, errors, fields: local.filter(field => validateContractFields([field]).length).map(field => field.label || field.id) }, message: `「${node.title}」输入未就绪：${errors.join(' ')}` };
  }
  if (options.conversation) return null;
  const cyclic = findCycle(nodes, edges);
  if (cyclic.length) {
    // Kahn leftovers include nodes DOWNSTREAM of a cycle, not only its members — say so.
    const names = cyclic.map((id) => nodes.find((n) => n.id === id)?.title ?? id);
    return { code: 'cycle', values: { titles: names }, message: `连线存在环，以下节点无法拓扑执行：${names.join('、')}。` };
  }
  return null;
}

/** Compatibility helper for callers that still render the original Chinese message. */
export function preflightGraph(
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
  scope?: ReadonlyArray<string>,
): string | null {
  return preflightGraphIssue(nodes, edges, scope)?.message ?? null;
}

/**
 * Wrap an async fn so calls sharing a key run STRICTLY one-at-a-time (calls with different keys
 * stay concurrent). Used to serialize executions per bound agent: two nodes bound to the SAME
 * agent must not run concurrently — the gateway continues the agent's conversation and attaches
 * to its live run, so parallel turns could cross-attribute outputs.
 */
export function withPerKeySerialization<A extends unknown[], R>(
  keyOf: (...args: A) => string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const tails = new Map<string, Promise<unknown>>();
  return (...args: A) => {
    const key = keyOf(...args);
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => fn(...args),
      () => fn(...args),
    );
    // The tail swallows outcomes (it only sequences); callers get the real promise.
    tails.set(key, next.then(
      () => undefined,
      () => undefined,
    ));
    return next;
  };
}

export function serializeFormOutput(node: FormNode): string {
  if (!node.fields.length) return '（空表单）';
  return node.fields.map((f) => `${f.label || '字段'}: ${f.value.trim() || '（未填写）'}`).join('\n');
}

export interface UpstreamInput {
  fromTitle: string;
  toPort: string;
  output: string;
}

function resolvedInputs(node: SessionNode, upstream: ReadonlyArray<UpstreamInput>): ContractField[] {
  return (node.contract?.inputs ?? []).map((field) => {
    const wired = upstream.filter((input) => input.toPort === `in:${field.id}`);
    if (wired.length > 1) throw new Error(`输入「${field.label || field.id}」只能连接一个来源。`);
    return wired.length ? { ...field, value: wired[0].output } : field;
  });
}

/** The same publication gate for graph runs, cached results, and manual chat selections. */
export function validateNodeOutput(node: CanvasNode, output: string): string[] {
  return node.kind === 'session' && node.contract ? parseContractOutput(node.contract, output).errors : [];
}

/** Compose the message a session node receives: its task framing + every upstream output as an
 *  explicitly-labeled precondition. The persona is NOT repeated here — it lives on the bound
 *  agent's instructions bundle (written at bind time). */
export function buildNodeMessage(node: SessionNode, upstream: ReadonlyArray<UpstreamInput>): string {
  const parts = [`【工作流节点】${node.title}`];
  if (node.contract) {
    const fields = resolvedInputs(node, upstream);
    const errors = validateContractFields(fields);
    if (errors.length) throw new Error(`「${node.title}」输入未就绪：${errors.join(' ')}`);
    for (const field of fields) {
      const source = upstream.find((input) => input.toPort === `in:${field.id}`);
      const provenance = source ? ` · 来自「${source.fromTitle}」` : ' · 本地填写';
      const help = field.help?.trim();
      parts.push(`【输入 · ${field.label || field.id} (${field.type})${provenance}】${help ? `\n字段说明：${help}` : ''}\n${field.value || '（未填写）'}`);
    }
    const outputs = node.contract.outputs;
    if (outputs.length) {
      const schema = outputs.map((field) => {
        const help = field.help?.trim();
        const structure = field.placeholder?.trim();
        return `- ${JSON.stringify(field.id)}: ${field.type}，${field.required ? '必填' : '可选'}（${field.label || field.id}）`
          + (help ? `\n  字段说明：${help}` : '')
          + (structure && structure !== help ? `\n  结构参考（不代表已有产出）：${structure}` : '');
      }).join('\n');
      const singleText = outputs.length === 1 && (outputs[0].type === 'text' || outputs[0].type === 'markdown' || outputs[0].type === 'html');
      parts.push(`【输出格式】\n${schema}\n${singleText ? '可直接返回该字段的文本，或返回以字段 ID 为键的 JSON 对象。' : '最终输出必须是以字段 ID 为键的 JSON 对象；number 使用 JSON 数字，boolean 使用 JSON 布尔值，其余字段使用字符串。'}文件字段仅填写文件引用，不表示文件已上传。`);
      if (outputs.some(field => field.type === 'html')) parts.push('HTML 字段必须提供完整文档源码，包含显式 html、head、body 起止标签；可使用一个完整的 html 代码块。不能用文件路径、链接、交付说明或 HTML 片段代替文档。');
      if (outputs.some(field => field.type === 'markdown')) parts.push('Markdown 字段直接提供 Markdown 文档正文，保留标题、列表和代码等原始格式，以便导出 .md 文件。');
    }
    parts.push(fields.length ? '请基于以上输入完成本节点的职责，并按声明的格式给出最终输出。' : '本节点没有输入，请按本节点职责完成任务，并按声明的格式给出最终输出。');
    return parts.join('\n\n');
  }
  for (const u of upstream) {
    parts.push(`【上游输入 · 来自「${u.fromTitle}」→ ${u.toPort}】\n${u.output.trim() || '（上游无文本输出）'}`);
  }
  // A ROOT node has no preconditions. Telling it to work "基于以上前置输入" would point at
  // nothing and invite the agent to invent the context it was told to rely on — the exact
  // opposite of why the graph is wired. Each shape gets the instruction that is true of it.
  parts.push(
    upstream.length
      ? '请基于以上前置输入完成本节点的职责，最后清晰给出本节点的最终输出。'
      : '本节点没有上游输入，请直接按上述职责开始，最后清晰给出本节点的最终输出。',
  );
  return parts.join('\n\n');
}

/**
 * Run the whole graph. Assumes preflightGraph returned null (the caller gates on it) —
 * defensively re-checks the cycle, since a recursive scheduler on a cyclic graph would deadlock
 * rather than fail.
 */
export async function runGraph(opts: RunGraphOptions): Promise<RunSummary> {
  const { nodes, edges, execAgent, onStatus, signal, scope, storedOutput } = opts;
  const inScope = scope ? new Set(scope) : null;
  const scopedNodes = inScope ? nodes.filter((n) => inScope.has(n.id)) : nodes;
  const summary: RunSummary = { ok: false, done: 0, failed: 0, blocked: 0, cancelled: 0, cached: 0, total: scopedNodes.length };
  if (findCycle(nodes, edges).length) return summary;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const graphEdges = reconcileEdges(nodes, edges);
  /**
   * A node's incoming edges in a STABLE, MEANINGFUL order: by where the source node sits on the
   * canvas, top-to-bottom then left-to-right — the order the user reads the graph in.
   *
   * Insertion order (which is what the raw edge list carries) would make the prompt depend on the
   * sequence the wires happened to be drawn in: invisible on screen, different between two graphs
   * that look identical, and changed by any edit that rewrites the edge list. For a product whose
   * whole point is controlling what the model produces, the position of each upstream block in the
   * prompt has to be something the user can see and predict.
   */
  const dependenciesOf = (nodeId: string): CanvasEdge[] =>
    graphEdges
      .filter((e) => e.toNode === nodeId)
      .slice()
      .sort((a, b) => {
        const na = nodeById.get(a.fromNode);
        const nb = nodeById.get(b.fromNode);
        if (!na || !nb) return 0;
        if (na.y !== nb.y) return na.y - nb.y;
        if (na.x !== nb.x) return na.x - nb.x;
        // Same position (stacked): fall back to something total so the order never wobbles.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  const outputs = new Map<string, string>();
  // Missing cached prerequisites explain why an in-scope node cannot run; they are not
  // themselves executions and must not add blocked badges or inflate the scoped summary.
  const dependencyFailures = new Map<string, string>();
  const set = (nodeId: string, status: RunNodeStatus) => {
    if (status.state === 'done') summary.done += 1;
    if (status.state === 'failed') summary.failed += 1;
    // Blocked counts share the same execution scope as the summary total.
    if (status.state === 'blocked' && (!inScope || inScope.has(nodeId))) summary.blocked += 1;
    if (status.state === 'cancelled') summary.cancelled += 1;
    if (status.state === 'cached') summary.cached += 1;
    onStatus(nodeId, status);
  };

  // Only nodes this run will touch get a 'waiting' badge — painting the whole canvas as queued
  // when three nodes are running would say the run is doing something it is not.
  for (const n of scopedNodes) onStatus(n.id, { state: 'waiting' });

  const memo = new Map<string, Promise<boolean>>();
  const exec = (id: string): Promise<boolean> => {
    const existing = memo.get(id);
    if (existing) return existing;
    const p = (async (): Promise<boolean> => {
      // OUT OF SCOPE: contribute what this node produced earlier rather than re-running it.
      // Reported as 'cached', never 'done' — claiming a node completed in a run it never joined
      // is exactly the kind of small lie that makes a timeline untrustworthy.
      if (inScope && !inScope.has(id)) {
        const stored = storedOutput?.(id) ?? null;
        if (stored === null) {
          const title = nodeById.get(id)?.title ?? id;
          dependencyFailures.set(id, `上游「${title}」还没有产出，无法只跑选中的节点`);
          return false;
        }
        const cachedNode = nodeById.get(id);
        const errors = cachedNode ? validateNodeOutput(cachedNode, stored) : ['上游节点不存在'];
        if (errors.length) {
          dependencyFailures.set(id, `上游「${cachedNode?.title ?? id}」的已有产出不符合输出格式：${errors.join(' ')}`);
          return false;
        }
        outputs.set(id, stored);
        set(id, { state: 'cached', output: stored, detail: '沿用上次产出' });
        return true;
      }
      const deps = dependenciesOf(id);
      const upstreamOk = await Promise.all(deps.map((d) => exec(d.fromNode)));
      if (signal?.aborted) {
        set(id, { state: 'cancelled', detail: '已取消' });
        return false;
      }
      if (upstreamOk.some((r) => !r)) {
        const reasons = deps.flatMap((dep, index) => !upstreamOk[index] && dependencyFailures.has(dep.fromNode)
          ? [dependencyFailures.get(dep.fromNode)!] : []);
        const detail = [...new Set(reasons)].join('；') || '上游未完成';
        dependencyFailures.set(id, detail);
        set(id, { state: 'blocked', detail });
        return false;
      }
      const node = nodeById.get(id);
      if (!node) return false;
      if (node.kind === 'form') {
        const output = serializeFormOutput(node);
        outputs.set(id, output);
        set(id, { state: 'done', output });
        return true;
      }
      const upstream: UpstreamInput[] = deps.map((d) => {
        const source = nodeById.get(d.fromNode);
        const text = outputs.get(d.fromNode) ?? '';
        return {
          fromTitle: source?.title ?? d.fromNode,
          toPort: d.toPort,
          output: source?.kind === 'session' && source.contract
            ? parseContractOutput(source.contract, text).values[d.fromPort.slice('out:'.length)] ?? ''
            : text,
        };
      });
      // A throwing transport marks THIS node failed — it must never reject the whole run.
      let result: ExecAgentResult;
      try {
        const message = buildNodeMessage(node, upstream);
        set(id, { state: 'running' });
        result = await execAgent(node, message);
      } catch (err) {
        result = { ok: false, output: '', detail: err instanceof Error ? err.message : '执行器异常' };
      }
      if (result.unconfirmed) {
        set(id, { state: 'running', unconfirmed: true, output: result.output || undefined, detail: result.detail });
        return false;
      }
      if (result.cancelled) {
        set(id, { state: 'cancelled', output: result.output || undefined, detail: result.detail });
        return false;
      }
      if (result.ok) {
        const errors = validateNodeOutput(node, result.output);
        if (errors.length) {
          set(id, { state: 'failed', output: result.output || undefined, detail: `输出格式校验失败：${errors.join(' ')}` });
          return false;
        }
        outputs.set(id, result.output);
        set(id, { state: 'done', output: result.output, detail: result.detail });
        return true;
      }
      set(id, { state: 'failed', output: result.output || undefined, detail: result.detail });
      return false;
    })();
    memo.set(id, p);
    return p;
  };

  await Promise.all(scopedNodes.map((n) => exec(n.id)));
  // Success is measured against what this run was ASKED to do. A cached upstream is not a node
  // this run completed, so it is deliberately not counted toward it.
  summary.ok = summary.done === summary.total;
  return summary;
}
