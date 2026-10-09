// Worker protocol client. Completion is accepted only as AwwO accepts it: an HTTP 200 event stream
// that ends in a `completed` event whose full text is consistent with the streamed deltas. An
// HTTP 200 alone, a dropped stream or a reply that disagrees with what was streamed is a failure,
// never a result.
import type { CompletionRequest, WorkerEvent, WorkerRunRequest } from '@awwo/core/protocol';

export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface WorkerEndpoint { url: string; token: string }

export type WorkerRunOutcome =
  | { status: 'completed'; text: string }
  | { status: 'failed'; code: string; message: string; text: string }
  | { status: 'cancelled'; text: string };

export interface WorkerRunOptions {
  endpoint: WorkerEndpoint;
  request: WorkerRunRequest;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onReasoning?: (characters: number) => void;
  /** Only planning runs ask for reasoning-size events (AwwO's X-Awwo-Run-Activity header). */
  reasoningActivity?: boolean;
  fetchImpl?: typeof fetch;
}

const headers = (token: string, extra: Record<string, string> = {}) => ({
  ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra,
});

/** Best-effort, bounded cancellation of one call; safe to repeat. */
export async function cancelWorkerRun(endpoint: WorkerEndpoint, runId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    await fetchImpl(`${endpoint.url}/internal/runs/${encodeURIComponent(runId)}`, { method: 'DELETE', headers: headers(endpoint.token), signal: controller.signal });
  } catch { /* the worker's own run timeout still bounds the call */ }
  finally { clearTimeout(timer); }
}

/** Parse an SSE byte stream into `data:` JSON payloads. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line === '') {
          if (data.length) {
            const payload = data.join('\n');
            data = [];
            try { yield JSON.parse(payload); } catch { yield { type: '__invalid__' }; }
          }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
    if (data.length) {
      try { yield JSON.parse(data.join('\n')); } catch { yield { type: '__invalid__' }; }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runOnWorker(options: WorkerRunOptions): Promise<WorkerRunOutcome> {
  const { endpoint, request, signal, onDelta, onReasoning } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  let output = '';
  if (signal?.aborted) return { status: 'cancelled', text: '' };
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint.url}/internal/runs`, {
      method: 'POST', signal,
      headers: headers(endpoint.token, { 'content-type': 'application/json', accept: 'text/event-stream',
        ...(options.reasoningActivity ? { 'x-awwo-run-activity': 'reasoning' } : {}) }),
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (signal?.aborted) {
      await cancelWorkerRun(endpoint, request.runId, fetchImpl);
      return { status: 'cancelled', text: '' };
    }
    return { status: 'failed', code: 'runtime_unavailable', message: error instanceof Error ? error.message : 'Worker unreachable', text: '' };
  }
  if (response.status !== 200 || !(response.headers.get('content-type') ?? '').startsWith('text/event-stream') || !response.body) {
    const detail = await response.text().catch(() => '');
    return { status: 'failed', code: 'runtime_rejected', message: `Worker answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`, text: '' };
  }
  let produced = 0;
  try {
    for await (const raw of sseEvents(response.body)) {
      const event = raw as WorkerEvent | { type: '__invalid__' };
      switch (event.type) {
        case 'text_delta': {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          produced += Buffer.byteLength(delta);
          if (produced > MAX_OUTPUT_BYTES) {
            await cancelWorkerRun(endpoint, request.runId, fetchImpl);
            return { status: 'failed', code: 'output_limit', message: 'Model output exceeds 2 MiB', text: output };
          }
          output += delta;
          if (delta) onDelta?.(delta);
          break;
        }
        case 'reasoning':
          if (!options.reasoningActivity) return { status: 'failed', code: 'invalid_runtime_event', message: 'Unrequested reasoning event', text: output };
          if (typeof event.characters === 'number' && Number.isFinite(event.characters)) onReasoning?.(Math.max(0, Math.trunc(event.characters)));
          break;
        case 'completed': {
          const text = typeof event.text === 'string' ? event.text : '';
          if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES || !text.startsWith(output)) {
            return { status: 'failed', code: 'inconsistent_runtime_output', message: 'Completed text disagrees with the streamed output', text: output };
          }
          return { status: 'completed', text };
        }
        case 'failed':
          return { status: 'failed', code: typeof event.code === 'string' && event.code ? event.code.slice(0, 80) : 'runtime_failed',
            message: typeof event.message === 'string' ? event.message.slice(0, 500) : 'The runtime reported a failure', text: output };
        case 'cancelled':
          return { status: 'cancelled', text: output };
        default:
          await cancelWorkerRun(endpoint, request.runId, fetchImpl);
          return { status: 'failed', code: 'invalid_runtime_event', message: 'Worker sent an unknown event', text: output };
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      await cancelWorkerRun(endpoint, request.runId, fetchImpl);
      return { status: 'cancelled', text: output };
    }
    return { status: 'failed', code: 'runtime_stream_ended', message: error instanceof Error ? error.message : 'Stream broke', text: output };
  }
  if (signal?.aborted) {
    await cancelWorkerRun(endpoint, request.runId, fetchImpl);
    return { status: 'cancelled', text: output };
  }
  return { status: 'failed', code: 'runtime_stream_ended', message: 'The stream ended without a terminal event', text: output };
}

/** One-shot completion (the router's small call). Returns the first choice's text. */
export async function completeOnWorker(endpoint: WorkerEndpoint, body: CompletionRequest, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${endpoint.url}/internal/completions`, {
    method: 'POST', signal, headers: headers(endpoint.token, { 'content-type': 'application/json' }), body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== 200 || text.length > 64 * 1024) throw new Error(`completion_status_${response.status}`);
  const parsed = JSON.parse(text) as { completion?: { choices?: Array<{ message?: { content?: unknown } }> } };
  const content = parsed.completion?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('completion_unreadable');
  return content;
}
