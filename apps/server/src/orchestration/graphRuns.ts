// Graph runs on the orchestrator.
//
// Like AwwO's Go scheduler, a run receives one fixed document and scope, validates the whole graph
// and freezes every in-scope node's execution snapshot BEFORE the first model call; a closed
// browser does not stop an accepted run, and observers replay its event log by sequence number.
// Unlike AwwO's Go host (single-pass DAG only), this host runs both engines from @awwo/core:
// `runGraph` for workflows and `runReviewGraph` for bounded review loops with feedback edges.
import { randomUUID } from 'node:crypto';
import { sanitizeDocument, type CanvasDocument, type SessionNode } from '@awwo/core/canvasDoc';
import { preflightGraphIssue, runGraph, type RunNodeStatus, type RunSummary } from '@awwo/core/runGraph';
import { preflightReviewGraphIssue, runReviewGraph } from '@awwo/core/reviewGraph';
import type { RuntimeRegistry } from '../runtimes/registry';
import type { SkillRegistry } from '../skills';
import { AdmissionError, executeNode, freezeNodeSnapshot, type NodeSnapshot, type TeamTurnEvent } from './execution';

export type GraphRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type GraphEvent =
  | { seq: number; type: 'status'; status: GraphRunStatus; error?: string }
  | { seq: number; type: 'node'; nodeId: string; status: RunNodeStatus }
  | { seq: number; type: 'delta'; nodeId: string; delta: string; turnId?: string }
  | { seq: number; type: 'turn'; nodeId: string; turn: TeamTurnEvent }
  | { seq: number; type: 'round'; round: number }
  | { seq: number; type: 'summary'; summary: RunSummary };

type GraphEventBody = GraphEvent extends infer E ? E extends GraphEvent ? Omit<E, 'seq'> : never : never;

export interface GraphRunRecord {
  id: string;
  operationId: string;
  mode: 'workflow' | 'review';
  scope: string[] | null;
  status: GraphRunStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, RunNodeStatus & { runtime?: string; model?: string }>;
  summary?: RunSummary;
}

interface GraphRun extends GraphRunRecord {
  fingerprint: string;
  controller: AbortController;
  events: GraphEvent[];
  listeners: Set<(event: GraphEvent) => void>;
}

const MAX_EVENTS = 50_000;
const MAX_RETAINED_RUNS = 50;

export interface CreateGraphRun { document: unknown; scope?: unknown; operationId?: unknown }

export class GraphRunManager {
  private runs = new Map<string, GraphRun>();
  private byOperation = new Map<string, string>();

  constructor(private readonly deps: { registry: RuntimeRegistry; skills: SkillRegistry; defaultRuntime: () => string; log?: (message: string) => void }) {}

  /** Admission: validate, freeze, then start. Throws AdmissionError before any model call. */
  async create(input: CreateGraphRun): Promise<{ run: GraphRunRecord; created: boolean }> {
    const operationId = typeof input.operationId === 'string' ? input.operationId : randomUUID();
    if (operationId.length < 8 || operationId.length > 200) throw new AdmissionError(400, 'invalid_input', 'operationId must be 8–200 characters');
    if (!input.document || typeof input.document !== 'object') throw new AdmissionError(400, 'invalid_graph', 'A canvas document is required');
    const raw = input.document as { nodes?: unknown[]; edges?: unknown[] };
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0 || raw.nodes.length > 200 || (Array.isArray(raw.edges) && raw.edges.length > 2000)) {
      throw new AdmissionError(400, 'invalid_graph', 'A graph needs 1–200 nodes and at most 2000 edges');
    }
    const doc: CanvasDocument = sanitizeDocument(input.document);
    if (doc.nodes.length !== raw.nodes.length) throw new AdmissionError(400, 'invalid_graph', 'Some nodes are malformed (invalid contract or team)');
    let scope: string[] | null = null;
    if (input.scope !== undefined && input.scope !== null) {
      if (!Array.isArray(input.scope) || input.scope.length === 0 || input.scope.some(id => typeof id !== 'string')
        || new Set(input.scope).size !== input.scope.length || input.scope.some(id => !doc.nodes.some(node => node.id === id))) {
        throw new AdmissionError(400, 'invalid_scope', 'scope must list distinct, existing node ids');
      }
      scope = input.scope as string[];
    }
    const fingerprint = JSON.stringify({ scope, doc: { nodes: doc.nodes, edges: doc.edges, execution: doc.execution } });
    const existingId = this.byOperation.get(operationId);
    if (existingId) {
      const existing = this.runs.get(existingId)!;
      if (existing.fingerprint !== fingerprint) throw new AdmissionError(409, 'idempotency_conflict', 'This operationId was used for a different run');
      return { run: this.record(existing), created: false };
    }
    const mode = doc.execution?.mode === 'review' ? 'review' : 'workflow';
    const issue = mode === 'review'
      ? preflightReviewGraphIssue(doc.nodes, doc.edges, doc.execution!, scope ?? undefined, { requireBinding: false })
      : preflightGraphIssue(doc.nodes, doc.edges, scope ?? undefined, { requireBinding: false });
    if (issue) throw new AdmissionError(400, `preflight_${issue.code}`, issue.message);
    // Freeze every node this run may execute. Review runs always execute the complete graph.
    const executing = new Set(scope ?? doc.nodes.map(node => node.id));
    const snapshots = new Map<string, NodeSnapshot>();
    const defaultRuntime = this.deps.defaultRuntime();
    for (const node of doc.nodes) {
      if (node.kind !== 'session' || !executing.has(node.id)) continue;
      snapshots.set(node.id, await freezeNodeSnapshot(node, { registry: this.deps.registry, skills: this.deps.skills, defaultRuntime }));
    }
    const now = Date.now();
    const run: GraphRun = {
      id: randomUUID(), operationId, mode, scope, status: 'queued', createdAt: now, updatedAt: now, nodes: {},
      fingerprint, controller: new AbortController(), events: [], listeners: new Set(),
    };
    for (const [id, snapshot] of snapshots) run.nodes[id] = { state: 'waiting', runtime: snapshot.runtime, model: snapshot.model };
    this.runs.set(run.id, run);
    this.byOperation.set(operationId, run.id);
    this.prune();
    void this.execute(run, doc, scope, snapshots);
    return { run: this.record(run), created: true };
  }

  private emit(run: GraphRun, body: GraphEventBody): void {
    const event = { ...body, seq: run.events.length + 1 } as GraphEvent;
    if (run.events.length < MAX_EVENTS || body.type !== 'delta') run.events.push(event);
    run.updatedAt = Date.now();
    for (const listener of run.listeners) listener(event);
  }

  private setStatus(run: GraphRun, status: GraphRunStatus, error?: string): void {
    run.status = status;
    if (error) run.error = error;
    this.emit(run, { type: 'status', status, ...(error ? { error } : {}) });
  }

  private async execute(run: GraphRun, doc: CanvasDocument, scope: string[] | null, snapshots: Map<string, NodeSnapshot>): Promise<void> {
    this.setStatus(run, 'running');
    const signal = run.controller.signal;
    const onStatus = (nodeId: string, status: RunNodeStatus) => {
      const previous = run.nodes[nodeId] ?? {};
      run.nodes[nodeId] = { ...previous, ...status };
      this.emit(run, { type: 'node', nodeId, status });
    };
    const execAgent = async (node: SessionNode, message: string) => {
      const snapshot = snapshots.get(node.id);
      if (!snapshot) return { ok: false, output: '', detail: 'snapshot_missing: node was not admitted' };
      return executeNode(snapshot, message, {
        registry: this.deps.registry, skills: this.deps.skills, signal, sessionId: `graph_${run.id}_${node.id}`,
        onDelta: (delta, turnId) => this.emit(run, { type: 'delta', nodeId: node.id, delta, ...(turnId ? { turnId } : {}) }),
        onTurn: turn => this.emit(run, { type: 'turn', nodeId: node.id, turn }),
      });
    };
    const storedOutput = (id: string) => {
      const node = doc.nodes.find(item => item.id === id);
      return node?.lastOutput && !node.lastOutput.partial ? node.lastOutput.text : null;
    };
    try {
      const summary = run.mode === 'review'
        ? await runReviewGraph({ nodes: doc.nodes, edges: doc.edges, policy: doc.execution!, signal, execAgent, onStatus,
          requireBinding: false, onRound: round => this.emit(run, { type: 'round', round }) })
        : await runGraph({ nodes: doc.nodes, edges: doc.edges, signal, execAgent, onStatus, storedOutput, ...(scope ? { scope } : {}) });
      run.summary = summary;
      this.emit(run, { type: 'summary', summary });
      this.setStatus(run, signal.aborted ? 'cancelled' : summary.ok ? 'completed' : 'failed',
        summary.ok ? undefined : summary.review ? `review_${summary.review.outcome}` : undefined);
    } catch (error) {
      this.deps.log?.(`graph run ${run.id} crashed: ${error instanceof Error ? error.stack : error}`);
      this.setStatus(run, signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  cancel(id: string): GraphRunRecord | null {
    const run = this.runs.get(id);
    if (!run) return null;
    if (run.status === 'queued' || run.status === 'running') run.controller.abort();
    return this.record(run);
  }

  get(id: string): GraphRunRecord | null {
    const run = this.runs.get(id);
    return run ? this.record(run) : null;
  }

  list(): GraphRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt).map(run => this.record(run));
  }

  /** Replay events after `after`, then follow live ones until the run ends. */
  subscribe(id: string, after: number, listener: (event: GraphEvent) => void): (() => void) | null {
    const run = this.runs.get(id);
    if (!run) return null;
    for (const event of run.events) if (event.seq > after) listener(event);
    run.listeners.add(listener);
    return () => { run.listeners.delete(listener); };
  }

  terminal(id: string): boolean {
    const status = this.runs.get(id)?.status;
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  cancelAll(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  private record(run: GraphRun): GraphRunRecord {
    const { fingerprint: _f, controller: _c, events: _e, listeners: _l, ...record } = run;
    return structuredClone(record);
  }

  private prune(): void {
    const finished = [...this.runs.values()].filter(run => run.status !== 'running' && run.status !== 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    while (this.runs.size > MAX_RETAINED_RUNS && finished.length) {
      const oldest = finished.shift()!;
      this.runs.delete(oldest.id);
      this.byOperation.delete(oldest.operationId);
    }
  }
}
