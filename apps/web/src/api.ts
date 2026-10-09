// The canvas's only way to the orchestrator: same-origin /api, an optional bearer token, and
// fetch-based event streams. Worker endpoints and tokens never reach the browser.
import type { AssistantRouteRequest, AssistantRouteResult } from '@awwo/core/assistantRoute';
import type { CanvasDocument } from '@awwo/core/canvasDoc';
import type { RuntimeView } from '@awwo/core/protocol';
import type { RunNodeStatus, RunSummary } from '@awwo/core/runGraph';
import { readSse } from './sse';

export const API_TOKEN_KEY = 'awwo.apiToken';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Health { ok: boolean; version: string; runtimes: number; defaultRuntime: string; skillsError: string | null }

export type GraphRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface TeamTurn {
  id: string; memberId: string; memberName: string; role: string; round: number; ordinal: number;
  purpose: 'work' | 'aggregate' | 'review' | 'revise'; status: 'running' | 'completed' | 'failed' | 'cancelled';
  runtime: string; model: string; output?: string; error?: string;
}
export type GraphEvent =
  | { seq: number; type: 'status'; status: GraphRunStatus; error?: string }
  | { seq: number; type: 'node'; nodeId: string; status: RunNodeStatus }
  | { seq: number; type: 'delta'; nodeId: string; delta: string; turnId?: string }
  | { seq: number; type: 'turn'; nodeId: string; turn: TeamTurn }
  | { seq: number; type: 'round'; round: number }
  | { seq: number; type: 'summary'; summary: RunSummary };
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

export const TERMINAL: ReadonlySet<GraphRunStatus> = new Set(['completed', 'failed', 'cancelled']);

function token(): string {
  try { return globalThis.localStorage?.getItem(API_TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function saveApiToken(value: string): void {
  try {
    if (value) localStorage.setItem(API_TOKEN_KEY, value);
    else localStorage.removeItem(API_TOKEN_KEY);
  } catch { /* the token then lasts only for this page */ }
}

export function hasApiToken(): boolean {
  return Boolean(token());
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const bearer = token();
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network', 'The orchestrator is not reachable (npm run dev starts it).');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
    throw new ApiError(response.status, typeof body?.code === 'string' ? body.code : `http_${response.status}`,
      typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`);
  }
  return response;
}

const json = <T>(response: Response) => response.json() as Promise<T>;
const id = (value: string) => encodeURIComponent(value);

async function stream(path: string, init: RequestInit, onFrame: (data: Record<string, unknown>) => void): Promise<void> {
  const response = await call(path, { ...init, headers: { ...init.headers, accept: 'text/event-stream' } });
  if (!response.body) throw new ApiError(0, 'no_stream', 'The response carried no event stream');
  await readSse(response.body, frame => {
    if (frame.data && typeof frame.data === 'object') onFrame(frame.data as Record<string, unknown>);
  });
}

export const api = {
  health: (signal?: AbortSignal) => call('/api/health', { signal }).then(json<Health>),
  runtimes: (signal?: AbortSignal) => call('/api/runtimes', { signal }).then(json<{ items: RuntimeView[]; defaultRuntime: string }>),
  registerRuntime: (entry: { id: string; url: string; label?: string; token?: string }) =>
    call('/api/runtimes', { method: 'POST', body: JSON.stringify(entry) }).then(json<{ runtime: RuntimeView }>),
  unplugRuntime: (runtime: string) => call(`/api/runtimes/${id(runtime)}`, { method: 'DELETE' }).then(json<{ removed: string }>),
  probeRuntime: (runtime: string) => call(`/api/runtimes/${id(runtime)}/probe`, { method: 'POST', body: '{}' }).then(json<{ runtime: RuntimeView }>),
  /** Plain GET, in the shape AwwO's node-team editor reads catalogs with. */
  readJson: (path: string) => call(path).then(json<unknown>),
  route: (request: AssistantRouteRequest, signal?: AbortSignal) =>
    call('/api/assistant/route', { method: 'POST', body: JSON.stringify(request), signal }).then(json<AssistantRouteResult>),
  plan: (body: { prompt: string; context: string }, onFrame: (frame: Record<string, unknown>) => void, signal?: AbortSignal) =>
    stream('/api/plan', { method: 'POST', body: JSON.stringify(body), signal }, onFrame),
  directRun: (body: { prompt: string; purpose?: 'execute'; runtime?: string; model?: string; effort?: string; persona?: string;
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>; sessionId?: string },
  onFrame: (frame: Record<string, unknown>) => void, signal?: AbortSignal) =>
    stream('/api/runs', { method: 'POST', body: JSON.stringify(body), signal }, onFrame),
  startGraphRun: (body: { document: CanvasDocument; scope?: string[]; operationId: string }) =>
    call('/api/graph-runs', { method: 'POST', body: JSON.stringify(body) }).then(json<{ run: GraphRunRecord }>),
  graphRun: (run: string) => call(`/api/graph-runs/${id(run)}`).then(json<{ run: GraphRunRecord }>),
  cancelGraphRun: (run: string) => call(`/api/graph-runs/${id(run)}/cancel`, { method: 'POST', body: '{}' }).then(json<{ run: GraphRunRecord }>),
  /** Replays events after `after`, then follows live ones; the stream ends when the run ends. */
  followGraphRun: (run: string, after: number, onEvent: (event: GraphEvent) => void, signal?: AbortSignal) =>
    stream(`/api/graph-runs/${id(run)}/events?after=${after}`, { signal }, frame => onEvent(frame as unknown as GraphEvent)),
};
