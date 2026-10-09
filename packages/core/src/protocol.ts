// Runtime worker protocol, version 1 — the hot-plug seam.
//
// AwwO's control plane never links an agent SDK. Every execution engine (Pi, OpenAI Agents JS,
// its Python twin, …) is a separate worker process behind the same small HTTP contract, and the
// orchestrator routes each model call to the worker named by the member's frozen runtime. Adding
// an engine therefore means writing a worker, not changing the orchestrator:
//
//   GET    /health                    → RuntimeHealth   (catalog: models, tools, capacity)
//   POST   /internal/runs             → text/event-stream of WorkerEvent (one model call)
//   DELETE /internal/runs/{runId}     → stop that call (idempotent)
//   POST   /internal/completions      → CompletionResponse (one-shot call, e.g. the router)
//
// Every request carries `Authorization: Bearer <worker token>` when the registry entry has one.
// Endpoints and tokens are orchestrator configuration only: they never enter a canvas document,
// an execution snapshot or anything sent to a browser.

export const WORKER_PROTOCOL_VERSION = 1;

/** Runtime ids are registry keys: lowercase letters, digits, '-' or '_'. */
export const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** AwwO caps any advertised input budget at 256 KiB of UTF-8 text. */
export const MAX_CONTEXT_TEXT_BYTES = 262_144;
export const MAX_RUNTIME_MODELS = 256;

export interface RuntimeModel {
  /** Public selection id, unique within its runtime. May differ from the provider's model name. */
  id: string;
  /** Provider model name (informational). */
  model?: string;
  provider?: string;
  /** Must equal the id this worker is registered under, so a miswired URL cannot silently reroute. */
  runtime: string;
  label?: string;
  /** Input budget in UTF-8 bytes (prompt + system + history). Defaults to and is capped at 256 KiB. */
  maxContextTextBytes?: number;
  /** Per-message framing the worker adds, in bytes. */
  messageOverheadBytes?: number;
  /** Reasoning-effort levels this model accepts; an explicit effort outside this list is refused. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface RuntimeTool {
  id: string;
  /** Context the tool's description/result costs, in bytes (1–65536). */
  contextTextBytes: number;
  description?: string;
}

export interface RuntimeHealth {
  ready: boolean;
  protocol?: number;
  /** The runtime id the worker believes it serves (checked against the registry key when present). */
  runtime?: string;
  /** Default model id; must be listed in `models`. */
  model: string;
  models: RuntimeModel[];
  tools?: RuntimeTool[];
  maxConcurrency?: number;
  activeRuns?: number;
  /** Options /internal/completions honours ("thinking", "maxTokens"). */
  completionOptions?: string[];
  /** Free-form implementation label (e.g. "mock-worker 0.1.0"). */
  sdkVersion?: string;
}

export interface WorkerMessage { role: 'user' | 'assistant'; content: string }

export interface WorkerRunRequest {
  runId: string;
  /** Stable conversation identity (a node session, or a derived per-member identity). */
  sessionId: string;
  prompt: string;
  /** History chosen and bounded by the orchestrator; the worker never loads history itself. */
  messages: WorkerMessage[];
  systemPrompt: string;
  model: string;
  runtime: string;
  effort?: string;
  tools?: string[];
}

export type WorkerEvent =
  | { type: 'text_delta'; delta: string }
  /** Only a COUNT of reasoning characters — reasoning text never leaves the worker. */
  | { type: 'reasoning'; characters: number }
  | { type: 'completed'; text: string }
  | { type: 'failed'; code: string; message?: string }
  | { type: 'cancelled' };

export interface CompletionRequest {
  runId: string;
  model: string;
  effort?: string;
  thinking?: boolean;
  maxTokens?: number;
  completion: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> };
}

export interface CompletionResponse {
  completion: { choices: Array<{ message: { content: string | null } }> };
}

/** What the orchestrator publishes about a registered runtime (no URL secrets, never a token). */
export interface RuntimeView {
  id: string;
  label: string;
  status: 'ready' | 'unavailable' | 'probing';
  error?: string;
  source: 'file' | 'api';
  defaultModel: string;
  models: Array<{ id: string; label: string; provider: string; reasoningEfforts: string[]; defaultReasoningEffort: string }>;
  tools: string[];
  maxConcurrency: number;
  activeRuns: number;
  sdkVersion: string;
  checkedAt: number;
}
