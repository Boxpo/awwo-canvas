// The canvas assistant: one conversation whose messages the orchestrator routes (AwwO
// CanvasSurface's planning half and its unified assistant, condensed for this edition).
//
//   plan    — the planner proposes operations; the canvas validates them against the CURRENT
//             document and applies them as ONE undoable change, or reports the plan stale when the
//             canvas changed while it was being written. A malformed plan is retried exactly once.
//   execute — one agent does the task now (a direct run under the router's execute skill). Tasks run
//             beside the conversation: the composer stays free and each task has its own stop.
import { useEffect, useRef, useState } from 'react';
import { assistantRouteRequest, type AssistantRoute } from '@awwo/core/assistantRoute';
import type { CanvasDocument } from '@awwo/core/canvasDoc';
import { applyCanvasPlan, canvasPlanRevision, parseCanvasPlan, type CanvasPlan } from '@awwo/core/canvasPlan';
import { buildPlanningContext, loadPlanningConversation, observedProgress, savePlanningConversation,
  type PlanningConversation, type PlanningMessage, type PlanProgress } from '@awwo/core/planningContext';
import { api, ApiError } from './api';
import type { AssistantPending } from './canvas/assistantRouting';
import { canvasText } from './canvas/i18n';
import type { UiLocale } from './locale';
import { shellText } from './text';

export interface AssistantTask {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  text: string;
  runtime?: string;
  model?: string;
  error?: string;
}

export interface AssistantOptions {
  locale: UiLocale;
  getDocument: () => CanvasDocument;
  /** Apply a plan's result as ONE undo step committed under `label`. */
  applyDocument: (doc: CanvasDocument, label: string, addedNodeIds: string[]) => void;
  undoDocument: () => void;
  /** Key of the commit that produced the current document: the plan is undoable while it is the latest change. */
  historyKey: string | null;
  /** Why nothing can be sent now; '' when it can. */
  unavailableReason: string;
  /** A graph run is in progress: the canvas is not re-planned under it. */
  graphRunning: boolean;
  /** Runtime and model an executed task uses; empty = the orchestrator's default. */
  execution: { runtime: string; model: string };
}

const MESSAGE_LIMIT = 60;
const STORED_TEXT = 20_000;
const PLAN_SECONDS_KEY = 'awwo.canvas.planSeconds';
const FRESH: PlanProgress = { stage: 'queued', characters: 0, nodes: 0, edges: 0, reasoning: 0, attempt: 1 };

export class PlanFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PlanFailure';
  }
}

/** One planner stream: progress frames, then exactly one proposal or one error. A stream that ends
 * without a proposal is a failure, never an empty plan: the canvas must not change on a lost connection. */
async function planOnce(prompt: string, context: string, signal: AbortSignal, observed: { last: PlanProgress },
  report: (progress: PlanProgress) => void): Promise<CanvasPlan> {
  const got: { plan?: unknown; failure?: PlanFailure } = {};
  await api.plan({ prompt, context }, frame => {
    if (got.plan !== undefined || got.failure) return;
    if (frame.type === 'progress') {
      observed.last = observedProgress(frame, observed.last);
      report(observed.last);
    } else if (frame.type === 'plan') got.plan = frame.plan;
    else if (frame.type === 'error') {
      got.failure = new PlanFailure(typeof frame.code === 'string' ? frame.code : 'planning_failed', typeof frame.error === 'string' ? frame.error : '');
    }
  }, signal);
  if (got.failure) throw got.failure;
  if (got.plan === undefined) throw new PlanFailure('interrupted', '');
  report({ ...observed.last, stage: 'validating' });
  try {
    return parseCanvasPlan(got.plan);
  } catch (error) {
    // Not conforming to the protocol is the same slip the server's own check catches, so it is retryable alike.
    throw new PlanFailure('invalid_canvas_plan', error instanceof Error ? error.message : '');
  }
}

/** Exactly one more attempt, and only for a malformed plan: retrying a runtime fault or a cancellation
 * cannot succeed. If the retry fails too, the FIRST failure is reported, since it describes what the model did. */
export async function requestPlan(prompt: string, context: string, signal: AbortSignal, report: (progress: PlanProgress) => void): Promise<CanvasPlan> {
  const observed = { last: FRESH };
  try {
    return await planOnce(prompt, context, signal, observed, report);
  } catch (first) {
    if (signal.aborted || !(first instanceof PlanFailure) || first.code !== 'invalid_canvas_plan') throw first;
    // The next attempt starts from nothing, so its counts start over; the attempt number says it is the second.
    observed.last = { ...FRESH, stage: 'retrying', attempt: 2 };
    report(observed.last);
    try {
      return await planOnce(prompt, context, signal, observed, report);
    } catch (second) {
      throw signal.aborted ? second : first;
    }
  }
}

export function failureText(locale: UiLocale, error: unknown): string {
  if (error instanceof ApiError && error.code === 'network') return canvasText(locale, 'planning.disconnected');
  if (error instanceof PlanFailure) {
    if (error.code === 'interrupted') return canvasText(locale, 'planning.interrupted');
    if (error.code === 'invalid_canvas_plan') return [canvasText(locale, 'planning.invalidResponse'), error.message].filter(Boolean).join(' ');
    if (error.code === 'runtime_unavailable') return shellText(locale)('plannerUnavailable');
  }
  return error instanceof Error && error.message ? error.message : canvasText(locale, 'planning.unavailable');
}

function readSeconds(): number | undefined {
  try { return Number(localStorage.getItem(PLAN_SECONDS_KEY)) || undefined; } catch { return undefined; }
}

export function useAssistant(options: AssistantOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [conversation, setConversation] = useState<PlanningConversation>(loadPlanningConversation);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const [pending, setPending] = useState<AssistantPending>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PlanProgress>();
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState<Record<string, AssistantTask>>({});
  const [planLabel, setPlanLabel] = useState<string | null>(null);
  const [expectedSeconds, setExpectedSeconds] = useState(readSeconds);
  /** The routed or planned message in flight: there is at most one, and it holds the composer. */
  const request = useRef<{ id: string; prompt: string; phase: 'route' | 'plan'; controller: AbortController } | null>(null);
  const taskControllers = useRef(new Map<string, AbortController>());
  const sequence = useRef(0);

  useEffect(() => { savePlanningConversation(conversation); }, [conversation]);
  useEffect(() => () => {
    request.current?.controller.abort();
    for (const controller of taskControllers.current.values()) controller.abort();
  }, []);

  const append = (...messages: PlanningMessage[]) =>
    setConversation(previous => ({ ...previous, messages: [...previous.messages, ...messages].slice(-MESSAGE_LIMIT) }));
  /** The message joins the conversation; the box is emptied only where it still holds that message. */
  const accept = (prompt: string, ...messages: PlanningMessage[]) => setConversation(previous => ({
    draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages, ...messages].slice(-MESSAGE_LIMIT) }));
  const restoreDraft = (prompt: string) => setConversation(previous => ({ ...previous, draft: previous.draft || prompt }));
  const patchMessage = (id: string, patch: Partial<PlanningMessage>) => setConversation(previous => ({
    ...previous, messages: previous.messages.map(message => message.id === id ? { ...message, ...patch } : message) }));

  const plan = async (id: string, prompt: string, controller: AbortController) => {
    const { locale, getDocument } = latest.current;
    const current = () => request.current?.id === id && !controller.signal.aborted;
    const history = conversationRef.current.messages;
    const snapshot = getDocument();
    const revision = canvasPlanRevision(snapshot);
    const startedAt = Date.now();
    request.current = { id, prompt, phase: 'plan', controller };
    setBusy(true);
    setProgress(undefined);
    accept(prompt, { id: `${id}-user`, role: 'user', content: prompt, route: 'plan' });
    try {
      const proposal = await requestPlan(prompt, buildPlanningContext(snapshot, history, locale), controller.signal,
        next => { if (current()) setProgress(next); });
      if (!current()) return;
      const before = latest.current.getDocument();
      // The plan was written for `snapshot`; applied to anything else it could undo edits made meanwhile.
      if (latest.current.graphRunning || canvasPlanRevision(before) !== revision) {
        append({ id: `${id}-assistant`, role: 'assistant', content: canvasText(locale, 'assistant.stale'), status: 'stale', route: 'plan' });
        restoreDraft(prompt);
        return;
      }
      const applied = applyCanvasPlan(before, proposal, locale);
      const changed = proposal.operations.length > 0;
      if (changed) {
        latest.current.applyDocument(applied.doc, `ai:${id}`, applied.addedNodeIds);
        setPlanLabel(`ai:${id}`);
      }
      append({ id: `${id}-assistant`, role: 'assistant', content: applied.summary.trim() || canvasText(locale, 'assistant.applied'),
        ...(changed ? { status: 'applied' as const } : {}), route: 'plan' });
      // Only a plan that arrived and was accepted is a measurement worth setting expectations with.
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (seconds > 0) {
        setExpectedSeconds(seconds);
        try { localStorage.setItem(PLAN_SECONDS_KEY, String(seconds)); } catch { /* an expectation, not state */ }
      }
    } catch (failure) {
      if (!current()) return;
      const message = failureText(locale, failure);
      setError(message);
      append({ id: `${id}-assistant`, role: 'assistant', content: message, status: 'error', route: 'plan' });
      restoreDraft(prompt);
    } finally {
      if (request.current?.id === id) {
        request.current = null;
        setBusy(false);
        setProgress(undefined);
      }
    }
  };

  const execute = (id: string, prompt: string) => {
    const { execution, locale } = latest.current;
    const taskId = `task-${id}`;
    const messageId = `${id}-task`;
    const controller = new AbortController();
    taskControllers.current.set(taskId, controller);
    // Earlier executed turns are the task's conversation; planning turns are the canvas's business.
    const turns = conversationRef.current.messages.filter(message => message.route === 'execute' && message.content.trim())
      .slice(-20).map(({ role, content }) => ({ role, content }));
    setTasks(previous => ({ ...previous, [taskId]: { id: taskId, status: 'running', text: '' } }));
    accept(prompt, { id: `${id}-user`, role: 'user', content: prompt, route: 'execute' },
      { id: messageId, role: 'assistant', content: '', route: 'execute', taskId });
    let text = '';
    let paint: number | null = null;
    const end: { status?: AssistantTask['status']; text?: string; error?: string } = {};
    const update = (patch: Partial<AssistantTask>) =>
      setTasks(previous => previous[taskId] ? { ...previous, [taskId]: { ...previous[taskId], ...patch } } : previous);
    const finish = (status: AssistantTask['status'], final: string, failure = '') => {
      if (paint !== null) cancelAnimationFrame(paint);
      taskControllers.current.delete(taskId);
      update({ status, text: final, ...(failure ? { error: failure } : {}) });
      // The stored turn keeps the result, so a reload still shows it and the next task can build on it.
      patchMessage(messageId, { content: (final || failure).slice(0, STORED_TEXT), ...(status === 'failed' ? { status: 'error' as const } : {}) });
    };
    void api.directRun({ prompt, purpose: 'execute', messages: turns,
      ...(execution.runtime ? { runtime: execution.runtime } : {}), ...(execution.model ? { model: execution.model } : {}) }, frame => {
      if (frame.type === 'started') update({ runtime: String(frame.runtime ?? ''), model: String(frame.model ?? '') });
      else if (frame.type === 'delta' && typeof frame.delta === 'string') {
        text += frame.delta;
        if (paint === null) paint = requestAnimationFrame(() => { paint = null; update({ text }); });
      } else if (frame.type === 'completed') Object.assign(end, { status: 'completed', text: typeof frame.text === 'string' ? frame.text : text });
      else if (frame.type === 'cancelled') Object.assign(end, { status: 'cancelled', text: typeof frame.text === 'string' ? frame.text : text });
      else if (frame.type === 'failed') Object.assign(end, { status: 'failed', text, error: typeof frame.error === 'string' && frame.error ? frame.error : failureText(locale, null) });
    }, controller.signal).then(
      () => end.status ? finish(end.status, end.text ?? text, end.error) : finish('failed', text, shellText(latest.current.locale)('taskInterrupted')),
      failure => controller.signal.aborted ? finish('cancelled', text) : finish('failed', text, failureText(latest.current.locale, failure)));
  };

  const send = async (forced?: AssistantRoute, text?: string) => {
    const prompt = (text ?? conversationRef.current.draft).trim();
    if (!prompt || request.current) return;
    const { unavailableReason, getDocument, locale } = latest.current;
    if (unavailableReason) { setError(unavailableReason); return; }
    const id = `turn-${Date.now()}-${++sequence.current}`;
    const controller = new AbortController();
    request.current = { id, prompt, phase: 'route', controller };
    setError('');
    let route = forced;
    if (!route) {
      setPending({ id, prompt, phase: 'routing' });
      try {
        route = (await api.route(assistantRouteRequest(prompt, ['plan', 'execute'], getDocument(), conversationRef.current.messages), controller.signal)).route;
      } catch {
        // A router that cannot answer leaves the cheap way: a plan makes one call and is undone in one step.
        route = 'plan';
      }
      if (request.current?.id !== id || controller.signal.aborted) return;
      setPending(undefined);
    }
    if (route === 'execute') {
      request.current = null;
      execute(id, prompt);
      return;
    }
    if (latest.current.graphRunning) {
      request.current = null;
      setError(shellText(locale)('planBusy'));
      return;
    }
    await plan(id, prompt, controller);
  };

  const cancel = () => {
    const current = request.current;
    if (!current) return;
    request.current = null;
    current.controller.abort();
    setPending(undefined);
    setBusy(false);
    setProgress(undefined);
    restoreDraft(current.prompt);
    if (current.phase === 'plan') append({ id: `${current.id}-cancelled`, role: 'assistant', content: shellText(latest.current.locale)('planCancelled'), route: 'plan' });
  };

  // The assistant's own undo reverts its plan only while that plan is the latest change; Ctrl+Z covers the rest.
  const canUndo = planLabel !== null && options.historyKey === planLabel && !busy;
  const undo = () => {
    if (!canUndo) return;
    latest.current.undoDocument();
    setPlanLabel(null);
    append({ id: `undo-${Date.now()}`, role: 'assistant', content: shellText(latest.current.locale)('undone'), route: 'plan' });
  };

  // The router can be wrong: the latest request can be handed to the other way.
  const last = conversation.messages.at(-1);
  const lastRequest = [...conversation.messages].reverse().find(message => message.role === 'user' && message.route);
  const switchRoute = !busy && !pending && last?.role === 'assistant' && last.route && last.status !== 'stale' && lastRequest?.route
    ? { to: lastRequest.route === 'plan' ? 'execute' as const : 'plan' as const,
      onSwitch: () => void send(lastRequest.route === 'plan' ? 'execute' : 'plan', lastRequest.content) }
    : undefined;

  /** A task as it runs, or as its stored turn left it after a reload. */
  const taskView = (taskId: string): AssistantTask => {
    if (tasks[taskId]) return tasks[taskId];
    const message = conversation.messages.find(item => item.taskId === taskId);
    if (message?.status === 'error') return { id: taskId, status: 'failed', text: '', error: message.content };
    return { id: taskId, status: message?.content ? 'completed' : 'cancelled', text: message?.content ?? '' };
  };

  return {
    messages: conversation.messages,
    draft: conversation.draft,
    setDraft: (draft: string) => setConversation(previous => ({ ...previous, draft })),
    send: () => void send(),
    cancel,
    busy,
    pending,
    progress,
    error,
    expectedSeconds,
    canUndo,
    undo,
    switchRoute,
    taskView,
    stopTask: (taskId: string) => taskControllers.current.get(taskId)?.abort(),
    clear: () => setConversation(previous => ({ ...previous, messages: [] })),
  };
}
