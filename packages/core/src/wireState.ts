import type { RunNodeStatus } from './runGraph';
import { edgeBezierPath } from './ports';

export type WireState = 'idle' | 'waiting' | 'flowing' | 'delivered' | 'failed' | 'blocked' | 'cancelled';

export interface WireStateOptions {
  kind?: 'data' | 'feedback';
  from?: RunNodeStatus;
  to?: RunNodeStatus;
  running?: boolean;
  round?: number;
}

const hasResult = (status?: RunNodeStatus) => status?.state === 'done' || status?.state === 'cached';

/** Motion means a real receiving execution, never merely that an edge exists. */
export function wireState({ kind = 'data', from, to, running = false, round = 1 }: WireStateOptions): WireState {
  // Feedback consumes the PREVIOUS round. Its source may still be waiting in this round.
  if (kind === 'feedback' && (!Number.isInteger(round) || round < 2)) return 'idle';
  if (to?.state === 'failed' || (kind === 'data' && from?.state === 'failed')) return 'failed';
  if (to?.state === 'blocked' || (kind === 'data' && from?.state === 'blocked')) return 'blocked';
  if (to?.state === 'cancelled' || (kind === 'data' && from?.state === 'cancelled')) return 'cancelled';
  if (to?.unconfirmed || (kind === 'data' && from?.unconfirmed)) return running ? 'waiting' : 'idle';
  if (kind === 'feedback') {
    if (running && to?.state === 'running') return 'flowing';
    if (to?.state === 'done') return 'delivered';
    return running && to?.state === 'waiting' ? 'waiting' : 'idle';
  }
  if (hasResult(from) && hasResult(to)) return 'delivered';
  if (!running) return 'idle';
  if (hasResult(from) && to?.state === 'running') return 'flowing';
  if (from?.state === 'running' || from?.state === 'waiting' || to?.state === 'waiting') return 'waiting';
  return 'idle';
}

interface Point { x: number; y: number }

/** Feedback travels above both tiles and still ends at the actual receiving input. */
export function wirePath(from: Point, to: Point, feedback = false, top = Math.min(from.y, to.y)): string {
  if (!feedback) return edgeBezierPath(from, to);
  const lane = top - 52;
  const shoulder = 48;
  return `M ${from.x} ${from.y} C ${from.x + shoulder} ${from.y}, ${from.x + shoulder} ${lane}, ${from.x + shoulder} ${lane} L ${to.x - shoulder} ${lane} C ${to.x - shoulder} ${lane}, ${to.x - shoulder} ${to.y}, ${to.x} ${to.y}`;
}
