import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export type Params = Record<string, string>;
export type Handler = (req: IncomingMessage, res: ServerResponse, params: Params, url: URL) => Promise<void> | void;

interface Route { method: string; parts: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Params } | 'method' | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Params = {};
      const ok = route.parts.every((part, index) => {
        if (part.startsWith(':')) {
          try { params[part.slice(1)] = decodeURIComponent(parts[index]); } catch { return false; }
          return true;
        }
        return part === parts[index];
      });
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

export function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: message, code });
}

/** Read a JSON body with a hard byte cap. Only application/json is accepted for writes. */
export async function readJson(req: IncomingMessage, maxBytes = 512 * 1024): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Send the request body as application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'body_too_large', `Request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

export interface SseStream {
  send(data: unknown, options?: { event?: string; id?: number }): void;
  close(): void;
  readonly closed: boolean;
  /** Aborted when the client disconnects. */
  readonly signal: AbortSignal;
}

export function openSse(req: IncomingMessage, res: ServerResponse): SseStream {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const controller = new AbortController();
  let closed = false;
  const heartbeat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15_000);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
  };
  // 'close' on the response fires when the client goes away (or after end()).
  res.on('close', finish);
  return {
    send(data, options = {}) {
      if (closed) return;
      let frame = '';
      if (options.id !== undefined) frame += `id: ${options.id}\n`;
      if (options.event) frame += `event: ${options.event}\n`;
      frame += `data: ${JSON.stringify(data)}\n\n`;
      res.write(frame);
    },
    close() {
      if (closed) return;
      finish();
      res.end();
    },
    get closed() { return closed; },
    signal: controller.signal,
  };
}

export interface GuardOptions {
  /** Origins allowed to send state-changing browser requests. */
  origins: ReadonlySet<string>;
  /** Host headers accepted (DNS-rebinding defence); empty = any. */
  hosts: ReadonlySet<string>;
  /** When set, every /api request except GET /api/health needs `Authorization: Bearer <token>`. */
  token: string;
}

/**
 * The orchestrator can spend the user's model credentials, so a page on another site must not be
 * able to drive it through the browser: writes from a foreign Origin are refused, the Host header
 * must be one this server answers to, and an optional bearer token covers non-loopback binds.
 */
export function guard(req: IncomingMessage, url: URL, options: GuardOptions): HttpError | null {
  const host = (req.headers.host ?? '').toLowerCase();
  if (options.hosts.size && !options.hosts.has(host)) return new HttpError(421, 'misdirected_request', 'Unknown Host header');
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD' && !options.origins.has(origin)) {
    return new HttpError(403, 'origin_forbidden', 'Requests from this origin are not allowed');
  }
  if (options.token && !(req.method === 'GET' && url.pathname === '/api/health')) {
    const auth = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return new HttpError(401, 'unauthorized', 'Missing or invalid bearer token');
  }
  return null;
}
