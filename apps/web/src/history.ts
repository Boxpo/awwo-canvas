// Undo/redo for the canvas document. Pure, so the rules are testable without a browser:
//  - one continuous gesture (a drag, typing into one field) is ONE step: commits that carry the
//    same key within COALESCE_MS replace the present instead of stacking up;
//  - run results are not edits: `mapAll` writes them into every snapshot, so undoing a move made
//    before a run does not also throw away what the run produced.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Key of the commit that produced `present` (null = not coalescible). */
  key: string | null;
  at: number;
}

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 1500;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], key: null, at: 0 };
}

export function commit<T>(history: History<T>, next: T, key: string | null = null, now = Date.now()): History<T> {
  if (Object.is(next, history.present)) return history;
  if (key !== null && key === history.key && now - history.at < COALESCE_MS) return { ...history, present: next, at: now };
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [], key, at: now };
}

export function undo<T>(history: History<T>): History<T> {
  if (!history.past.length) return history;
  return { past: history.past.slice(0, -1), present: history.past[history.past.length - 1],
    future: [history.present, ...history.future], key: null, at: 0 };
}

export function redo<T>(history: History<T>): History<T> {
  if (!history.future.length) return history;
  return { past: [...history.past, history.present], present: history.future[0], future: history.future.slice(1), key: null, at: 0 };
}

/** Apply a change to every snapshot (past, present and future) without adding an undo step. */
export function mapAll<T>(history: History<T>, change: (value: T) => T): History<T> {
  return { ...history, past: history.past.map(change), present: change(history.present), future: history.future.map(change) };
}

/** Start over from `present` (load, import): nothing before it can be undone into. */
export function reset<T>(present: T): History<T> {
  return createHistory(present);
}
