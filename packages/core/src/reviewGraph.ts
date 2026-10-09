import type { CanvasEdge, CanvasNode, ReviewGraphPolicy, SessionNode } from './canvasDoc';
import { parseContractOutput } from './nodeContracts';
import { canConnect, reconcileEdges } from './ports';
import { preflightGraphIssue, runGraph, type PreflightIssue, type RunGraphOptions, type RunNodeStatus, type RunSummary } from './runGraph';

export type { ReviewGraphPolicy } from './canvasDoc';
export type ReviewOutcome = 'approved' | 'exhausted' | 'failed' | 'cancelled';
export type ReviewRunSummary = RunSummary & { review: { rounds: number; outcome: ReviewOutcome } };

export type ReviewPreflightReason = 'full_graph_required' | 'invalid_round_limit' | 'duplicate_nodes' | 'duplicate_edges'
  | 'invalid_edges' | 'missing_feedback' | 'missing_reviewer' | 'invalid_verdict_field' | 'reviewer_not_terminal'
  | 'missing_reviewer_feedback' | 'invalid_feedback_input' | 'conflicting_feedback_input' | 'invalid_feedback_path'
  | 'unreviewed_nodes';

function issue(reviewReason: ReviewPreflightReason, message: string, values: PreflightIssue['values'] = {}): PreflightIssue {
  return { code: 'missing_inputs', values: { reviewReason, nodeTitle: 'Agent Graph', errors: [message], fields: [message], ...values }, message };
}

function reaches(edges: ReadonlyArray<CanvasEdge>, from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  for (let index = 0; index < queue.length; index += 1) {
    for (const edge of edges) {
      if (edge.fromNode !== queue[index] || seen.has(edge.toNode)) continue;
      if (edge.toNode === to) return true;
      seen.add(edge.toNode); queue.push(edge.toNode);
    }
  }
  return false;
}

/** Validate the first round before any native turn is accepted or dispatched. */
export function preflightReviewGraphIssue(
  nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>, policy: ReviewGraphPolicy,
  scope?: ReadonlyArray<string>,
  options: { requireBinding?: boolean } = {},
): PreflightIssue | null {
  if (scope !== undefined) return issue('full_graph_required', '评审 Graph 需要运行完整画布，不能只运行部分节点。');
  if (!policy || policy.mode !== 'review' || !Number.isInteger(policy.maxRounds) || policy.maxRounds < 1 || policy.maxRounds > 5) {
    return issue('invalid_round_limit', '评审轮次必须是 1 到 5 之间的整数。');
  }
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) return issue('duplicate_nodes', '节点 ID 重复，无法确定评审对象。');
  if (new Set(edges.map(edge => edge.id)).size !== edges.length) return issue('duplicate_edges', '连线 ID 重复，无法确定反馈来源。');
  const checked: CanvasEdge[] = [];
  for (const edge of edges) {
    if (!canConnect(nodes, checked, { nodeId: edge.fromNode, portId: edge.fromPort }, { nodeId: edge.toNode, portId: edge.toPort })) {
      return issue('invalid_edges', '连线存在无效端口、重复来源或输入冲突，请检查后再运行。');
    }
    checked.push(edge);
  }
  const validEdges = reconcileEdges(nodes, edges);
  const dataEdges = validEdges.filter(edge => edge.kind !== 'feedback');
  const feedbackEdges = validEdges.filter(edge => edge.kind === 'feedback');
  if (!feedbackEdges.length) return issue('missing_feedback', '至少需要一条反馈连线，将评审意见返回前面的节点。');
  const reviewer = nodes.find(node => node.id === policy.reviewerNodeId);
  if (!reviewer || reviewer.kind !== 'session') return issue('missing_reviewer', '请选择一个真实 Agent 节点作为最终评审。');
  const verdict = reviewer.contract?.outputs.find(field => field.id === policy.verdictFieldId);
  if (!verdict || verdict.type !== 'boolean') return issue('invalid_verdict_field', '最终评审必须声明一个 boolean 输出，true 表示通过，false 表示继续修改。');
  if (dataEdges.some(edge => edge.fromNode === reviewer.id)) return issue('reviewer_not_terminal', '最终评审应是本轮最后一个节点，请将它的返回连线标记为反馈。');
  if (!feedbackEdges.some(edge => edge.fromNode === reviewer.id)) return issue('missing_reviewer_feedback', '最终评审需要把反馈连接回它已评审的上游节点。');
  for (const feedback of feedbackEdges) {
    const target = nodes.find(node => node.id === feedback.toNode);
    if (target?.kind !== 'session' || !target.contract?.inputs.some(field => `in:${field.id}` === feedback.toPort)) {
      return issue('invalid_feedback_input', '反馈必须连接到一个 Agent 的显式输入字段。');
    }
    if (validEdges.filter(edge => edge.toNode === feedback.toNode && edge.toPort === feedback.toPort).length !== 1) {
      return issue('conflicting_feedback_input', '每个反馈输入只能有一个来源，不能同时接收普通连线和反馈连线。');
    }
    if (!reaches(dataEdges, feedback.toNode, feedback.fromNode)
      || (feedback.fromNode !== reviewer.id && !reaches(dataEdges, feedback.fromNode, reviewer.id))) {
      return issue('invalid_feedback_path', '反馈应返回当前成果的祖先节点，且反馈来源的成果需要到达最终评审。');
    }
  }
  // The verdict covers the complete execution scope. A successful detached node or branch
  // cannot be published as approved when none of its data reaches this reviewer.
  const incoming = new Map<string, string[]>();
  for (const edge of dataEdges) incoming.set(edge.toNode, [...(incoming.get(edge.toNode) ?? []), edge.fromNode]);
  const reviewed = new Set([reviewer.id]);
  const queue = [reviewer.id];
  for (let index = 0; index < queue.length; index += 1) {
    for (const id of incoming.get(queue[index]) ?? []) {
      if (reviewed.has(id)) continue;
      reviewed.add(id); queue.push(id);
    }
  }
  const unreviewed = nodes.filter(node => !reviewed.has(node.id));
  if (unreviewed.length) {
    const titles = unreviewed.map(node => node.title || node.id);
    return issue('unreviewed_nodes', `以下节点的成果尚未通过数据连线汇入最终评审：${titles.join('、')}。请连接后再运行。`, { titles });
  }
  // First-round feedback is absent. A required feedback input therefore needs an explicit
  // seed, and a missing seed cannot be hidden behind a wire from a future round.
  return preflightGraphIssue(nodes, dataEdges, undefined, { requireBinding: options.requireBinding });
}

interface ReviewGraphOptions extends RunGraphOptions {
  policy: ReviewGraphPolicy;
  /** Persist a fresh operation identity and hydrate this node's current Session first. */
  beforeTurn?: (node: SessionNode, round: number) => Promise<SessionNode>;
  onRound?: (round: number) => void;
  /** See preflightGraphIssue: false when session nodes run directly on a runtime (open-source host). */
  requireBinding?: boolean;
}

/** Bounded rounds over a DAG; feedback is a cached value from the preceding complete round. */
export async function runReviewGraph(opts: ReviewGraphOptions): Promise<ReviewRunSummary> {
  const { nodes, edges, policy, beforeTurn, onRound, signal, onStatus, execAgent } = opts;
  const base: RunSummary = { ok: false, done: 0, failed: 0, blocked: 0, cancelled: 0, cached: 0, total: nodes.length };
  const finish = (summary: RunSummary, rounds: number, outcome: ReviewOutcome): ReviewRunSummary => ({
    ...summary, ok: outcome === 'approved' && summary.ok, review: { rounds, outcome },
  });
  const problem = preflightReviewGraphIssue(nodes, edges, policy, opts.scope, { requireBinding: opts.requireBinding });
  if (problem) {
    for (const node of nodes) onStatus(node.id, { state: 'blocked', detail: problem.message });
    return finish({ ...base, blocked: nodes.length }, 0, 'failed');
  }
  const dataEdges = edges.filter(edge => edge.kind !== 'feedback');
  const feedbackEdges = edges.filter(edge => edge.kind === 'feedback');
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const originalIds = new Set(nodes.map(node => node.id));
  const reviewer = nodeById.get(policy.reviewerNodeId) as SessionNode;
  let previousOutputs = new Map<string, string>();
  let lastSummary = base;

  for (let round = 1; round <= policy.maxRounds; round += 1) {
    if (signal?.aborted) {
      for (const node of nodes) onStatus(node.id, { state: 'cancelled', detail: 'cancelled_before_dispatch' });
      return finish({ ...base, cancelled: nodes.length }, round - 1, 'cancelled');
    }
    try { onRound?.(round); }
    catch (error) {
      const detail = error instanceof Error ? error.message : 'review_round_prepare_failed';
      for (const node of nodes) onStatus(node.id, { state: 'blocked', detail });
      return finish({ ...base, blocked: nodes.length }, round - 1, 'failed');
    }
    const roundNodes: CanvasNode[] = [...nodes];
    const roundEdges: CanvasEdge[] = [...dataEdges];
    const cached = new Map<string, string>();
    if (round > 1) {
      for (const [index, edge] of feedbackEdges.entries()) {
        const source = nodeById.get(edge.fromNode)!;
        // A cached projection lets the existing runner inject the actual named source field
        // with upstream provenance, rather than disguising feedback as local form input.
        let id = `review-feedback:${round}:${index}:${edge.id}`;
        while (roundNodes.some(node => node.id === id)) id += ':';
        roundNodes.push({ ...source, id, title: `${source.title} · 第 ${round - 1} 轮反馈` });
        cached.set(id, previousOutputs.get(source.id)!);
        roundEdges.push({ ...edge, id: `${id}:edge`, fromNode: id, kind: 'data' });
      }
    }
    const currentOutputs = new Map<string, string>();
    const currentStatuses = new Map<string, RunNodeStatus>();
    let preparationFailure: string | null = null;
    lastSummary = await runGraph({
      nodes: roundNodes, edges: roundEdges, signal, scope: [...originalIds],
      storedOutput: id => cached.get(id) ?? null,
      execAgent: async (node, message) => {
        if (signal?.aborted) return { ok: false, cancelled: true, output: '', detail: 'cancelled_before_dispatch' };
        if (preparationFailure) return { ok: false, output: '', detail: preparationFailure };
        let ready: SessionNode;
        try { ready = beforeTurn ? await beforeTurn(node, round) : node; }
        catch (error) {
          preparationFailure = error instanceof Error ? error.message : 'review_turn_prepare_failed';
          return { ok: false, output: '', detail: preparationFailure };
        }
        // Another branch may have failed durable preparation while this one was awaiting it.
        // Existing native turns stay under transport ownership; no further turn is dispatched.
        if (preparationFailure) return { ok: false, output: '', detail: preparationFailure };
        if (signal?.aborted) return { ok: false, cancelled: true, output: '', detail: 'cancelled_before_dispatch' };
        const reviewInstruction = node.id === reviewer.id
          ? `\n【最终评审判定】独立核验本轮成果。输出字段 ${JSON.stringify(policy.verdictFieldId)} 必须是 JSON 布尔值：全部验收条件通过才返回 true；仍需修改返回 false，并在反馈输出中列出具体修改意见。达到轮次上限不代表通过。`
          : '\n如果输入包含上一轮反馈，请逐项验证并修订成果，再按本节点输出约束交付。';
        return execAgent(ready, `【Agent Graph · 第 ${round}/${policy.maxRounds} 轮】${reviewInstruction}\n\n${message}`);
      },
      onStatus: (id, status) => {
        if (!originalIds.has(id)) return;
        currentStatuses.set(id, status);
        if (status.state === 'done' && status.output !== undefined) currentOutputs.set(id, status.output);
        onStatus(id, status);
      },
    });
    // Synthetic feedback projections are not operator nodes and do not inflate the summary.
    lastSummary = { ...lastSummary, cached: 0 };
    if (!lastSummary.ok) return finish(lastSummary, round, signal?.aborted || lastSummary.cancelled > 0 ? 'cancelled' : 'failed');
    if (signal?.aborted) return finish(lastSummary, round, 'cancelled');
    const raw = currentOutputs.get(reviewer.id) ?? '';
    const parsed = parseContractOutput(reviewer.contract!, raw);
    const verdict = parsed.values[policy.verdictFieldId];
    if (parsed.errors.length || (verdict !== 'true' && verdict !== 'false')) {
      onStatus(reviewer.id, { state: 'failed', output: raw, detail: 'review_invalid_verdict' });
      return finish({ ...lastSummary, done: lastSummary.done - 1, failed: lastSummary.failed + 1 }, round, 'failed');
    }
    if (verdict === 'true') return finish(lastSummary, round, 'approved');
    if (round === policy.maxRounds) {
      onStatus(reviewer.id, { ...currentStatuses.get(reviewer.id), state: 'failed', output: raw, detail: 'review_exhausted' });
      return finish({ ...lastSummary, done: lastSummary.done - 1, failed: lastSummary.failed + 1 }, round, 'exhausted');
    }
    previousOutputs = currentOutputs;
  }
  return finish(lastSummary, policy.maxRounds, 'exhausted');
}
