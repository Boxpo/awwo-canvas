/** Human-authored requirements. Unknown persisted versions must remain intact. */
export interface TaskFrame {
  version: 1;
  source: 'manual';
  constraints: string[];
  acceptanceCriteria: string[];
  [key: string]: unknown;
}

export const TASK_FRAME_MAX_ENTRIES = 20;
export const TASK_FRAME_MAX_ENTRY_LENGTH = 2000;
export const TASK_FRAME_MAX_TOTAL_LENGTH = 12000;

export function isTaskFrame(value: unknown): value is TaskFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return Object.keys(frame).length === 4 && frame.version === 1 && frame.source === 'manual'
    && [frame.constraints, frame.acceptanceCriteria].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'));
}

/** Blank entries are omitted; all characters in nonblank entries are preserved. */
export function cleanTaskFrame(frame: TaskFrame): TaskFrame {
  const nonblank = (item: string) => !/^\p{White_Space}*$/u.test(item);
  return { ...frame, constraints: frame.constraints.filter(nonblank), acceptanceCriteria: frame.acceptanceCriteria.filter(nonblank) };
}

export function taskFrameError(value: unknown): 'unsupported' | 'entries' | 'entryLength' | 'totalLength' | null {
  if (value === undefined) return null;
  if (!isTaskFrame(value)) return 'unsupported';
  const frame = cleanTaskFrame(value);
  if (frame.constraints.length > TASK_FRAME_MAX_ENTRIES || frame.acceptanceCriteria.length > TASK_FRAME_MAX_ENTRIES) return 'entries';
  const lengths = [...frame.constraints, ...frame.acceptanceCriteria].map(item => Array.from(item).length);
  if (lengths.some(length => length > TASK_FRAME_MAX_ENTRY_LENGTH)) return 'entryLength';
  return lengths.reduce((sum, length) => sum + length, 0) > TASK_FRAME_MAX_TOTAL_LENGTH ? 'totalLength' : null;
}

/** Stable identity across API JSON key ordering, including fields from future versions. */
export function taskFrameFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry) ?? '';
}
