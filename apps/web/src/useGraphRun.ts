// Graph runs from the canvas. The orchestrator owns the run: the canvas submits one frozen document,
// follows the event log by sequence number (so a dropped stream or a page reload resumes where it
// left off), and writes the outputs back once the run has ended.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasDocument, CanvasNode, NodeOutput } from '@awwo/core/canvasDoc';
import { invalidateOutputs } from '@awwo/core/invalidateOutputs';
import type { RunNodeStatus, RunSummary } from '@awwo/core/runGraph';
import { api, ApiError, TERMINAL, type GraphEvent, type GraphRunRecord, type GraphRunStatus, type TeamTurn } from './api';

/** The run this browser is following, kept so a reload picks it up again. */
export const ACTIVE_RUN_KEY = 'awwo.canvas.activeRun';
const LIVE_TAIL = 4000;

export interface RunState {
  id: string;
  status: GraphRunStatus;
  mode: 'workflow' | 'review';
  scope: string[] | null;
  nodes: Record<string, RunNodeStatus>;
  /** Text streamed by each node's current call. */
  live: Record<string, string>;
  turns: Record<string, TeamTurn[]>;
  round: number;
  summary?: RunSummary;
  error?: string;
}

export function runFromRecord(record: GraphRunRecord): RunState {
  const nodes = Object.fromEntries(Object.entries(record.nodes).map(([id, { runtime: _runtime, model: _model, ...status }]) => [id, status]));
  return { id: record.id, status: record.status, mode: record.mode, scope: record.scope, nodes, live: {}, turns: {}, round: 1,
    ...(record.summary ? { summary: record.summary } : {}), ...(record.error ? { error: record.error } : {}) };
}

export function reduceRun(state: RunState, event: GraphEvent): RunState {
  switch (event.type) {
    case 'status': return { ...state, status: event.status, ...(event.error ? { error: event.error } : {}) };
    case 'node': {
      // A node that starts again (the next review round) starts its live text over.
      const restarted = event.status.state === 'running' && state.nodes[event.nodeId]?.state !== 'running';
      return { ...state, nodes: { ...state.nodes, [event.nodeId]: event.status }, live: restarted ? { ...state.live, [event.nodeId]: '' } : state.live };
    }
    case 'delta': return { ...state, live: { ...state.live, [event.nodeId]: ((state.live[event.nodeId] ?? '') + event.delta).slice(-LIVE_TAIL) } };
    case 'turn': {
      const list = state.turns[event.nodeId] ?? [];
      const index = list.findIndex(turn => turn.id === event.turn.id);
      return { ...state, turns: { ...state.turns, [event.nodeId]: index < 0 ? [...list, event.turn] : list.map((turn, position) => position === index ? event.turn : turn) } };
    }
    case 'round': return { ...state, round: event.round };
    case 'summary': return { ...state, summary: event.summary };
    default: return state;
  }
}

/**
 * A finished run's results in a document: executed nodes get their fresh output (a failed node's
 * text is kept as a partial, never as a result), and stored outputs downstream of them that the run
 * did not refresh are cleared, because they were derived from what has just been replaced.
 */
export function settleOutputs(doc: CanvasDocument, record: GraphRunRecord, at = Date.now()): CanvasDocument {
  const fresh = new Map<string, NodeOutput>();
  for (const [id, status] of Object.entries(record.nodes)) {
    if (!status.output?.trim()) continue;
    if (status.state === 'done') fresh.set(id, { text: status.output, at, source: 'run' });
    else if (status.state === 'failed') fresh.set(id, { text: status.output, at, source: 'run', partial: true });
  }
  if (!doc.nodes.some(node => fresh.has(node.id))) return doc;
  const withFresh = (nodes: CanvasNode[]) => nodes.map((node): CanvasNode => fresh.has(node.id) ? { ...node, lastOutput: fresh.get(node.id)! } : node);
  const invalidated = invalidateOutputs(doc, { ...doc, nodes: withFresh(doc.nodes) });
  return { ...invalidated, nodes: withFresh(invalidated.nodes) };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const remember = (id: string) => { try { localStorage.setItem(ACTIVE_RUN_KEY, id); } catch { /* resume is a convenience */ } };
const forget = () => { try { localStorage.removeItem(ACTIVE_RUN_KEY); } catch { /* nothing to clear */ } };

export function useGraphRun({ getDocument, onSettle }: { getDocument: () => CanvasDocument; onSettle: (record: GraphRunRecord) => void }) {
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  const runRef = useRef(run);
  runRef.current = run;
  const getDocumentRef = useRef(getDocument);
  getDocumentRef.current = getDocument;
  const onSettleRef = useRef(onSettle);
  onSettleRef.current = onSettle;
  const abort = useRef<AbortController | null>(null);
  // Deltas arrive per token; they are applied once per animation frame, not once per event.
  const queue = useRef<GraphEvent[]>([]);
  const frame = useRef<number | null>(null);
  const running = run !== null && !TERMINAL.has(run.status);

  const flush = useCallback((id: string) => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    const events = queue.current;
    queue.current = [];
    if (events.length) setRun(current => current?.id === id ? events.reduce(reduceRun, current) : current);
  }, []);

  const follow = useCallback(async (id: string) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    let after = 0;
    const onEvent = (event: GraphEvent) => {
      after = Math.max(after, event.seq);
      queue.current.push(event);
      if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; flush(id); });
    };
    const gone = () => { forget(); setRun(current => current?.id === id ? null : current); };
    for (let attempt = 0; attempt < 120 && !controller.signal.aborted; attempt += 1) {
      try {
        await api.followGraphRun(id, after, onEvent, controller.signal);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 404) return gone();
      }
      try {
        const { run: record } = await api.graphRun(id);
        if (TERMINAL.has(record.status)) {
          flush(id);
          setRun(current => current?.id === id ? { ...current, status: record.status, ...(record.summary ? { summary: record.summary } : {}),
            ...(record.error ? { error: record.error } : {}) } : current);
          setStopping(false);
          forget();
          onSettleRef.current(record);
          return;
        }
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 404) return gone();
      }
      await sleep(1000);
    }
  }, [flush]);

  const start = useCallback(async (scope?: string[]) => {
    if (runRef.current && !TERMINAL.has(runRef.current.status)) return;
    setError('');
    const document: CanvasDocument = { ...getDocumentRef.current(), view: null };
    try {
      const { run: record } = await api.startGraphRun({ document, ...(scope?.length ? { scope } : {}), operationId: `run-${crypto.randomUUID()}` });
      setRun(runFromRecord(record));
      remember(record.id);
      void follow(record.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [follow]);

  const stop = useCallback(async () => {
    const current = runRef.current;
    if (!current || TERMINAL.has(current.status)) return;
    setStopping(true);
    try { await api.cancelGraphRun(current.id); } catch (failure) {
      setStopping(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  // A run started before a reload keeps going on the orchestrator; pick it up again.
  useEffect(() => {
    let id = '';
    try { id = localStorage.getItem(ACTIVE_RUN_KEY) ?? ''; } catch { /* no storage, nothing to resume */ }
    let cancelled = false;
    if (id) {
      api.graphRun(id).then(({ run: record }) => {
        if (cancelled) return;
        setRun(runFromRecord(record));
        if (TERMINAL.has(record.status)) { forget(); onSettleRef.current(record); } else void follow(id);
      }, () => { if (!cancelled) forget(); });
    }
    return () => { cancelled = true; abort.current?.abort(); };
  }, [follow]);

  return { run, running, stopping, error, setError, start, stop, dismiss: () => setRun(null) };
}
