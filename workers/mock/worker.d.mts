import type { Server } from 'node:http';

export const VERSION: string;

/** The full deterministic answer the mock gives one /internal/runs request. */
export function respond(request: { systemPrompt?: string; prompt?: string; [key: string]: unknown }): string;

export interface MockWorker {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export function startMockWorker(options?: {
  port?: number;
  host?: string;
  token?: string;
  runtime?: string;
  /** Delay between streamed chunks, in milliseconds. */
  delayMs?: number;
}): Promise<MockWorker>;
