import { describe, expect, it } from 'vitest';
import { parseSseFrames, readSse } from '../src/sse';
import { commit, createHistory, mapAll, redo, undo } from '../src/history';

describe('parseSseFrames', () => {
  it('returns complete frames with ids and keeps the unfinished tail', () => {
    const { frames, rest } = parseSseFrames(': connected\n\nid: 3\ndata: {"type":"node"}\n\ndata: {"type":"del');
    expect(frames).toEqual([{ id: 3, data: { type: 'node' } }]);
    expect(rest).toBe('data: {"type":"del');
  });

  it('joins multi-line data, accepts CRLF and skips comments and non-JSON frames', () => {
    const { frames } = parseSseFrames('event: plan\r\ndata: {"a":\r\ndata: 1}\r\n\r\n: ping\n\ndata: not json\n\n');
    expect(frames).toEqual([{ event: 'plan', data: { a: 1 } }]);
  });

  it('reads a chunked stream to its end, including a final frame without a blank line', async () => {
    const chunks = ['data: {"n":', '1}\n\nda', 'ta: {"n":2}'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    await readSse(body, frame => seen.push(frame.data));
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('history', () => {
  it('coalesces one gesture into one undo step and stacks separate edits', () => {
    let history = createHistory('a');
    history = commit(history, 'b', 'drag:1', 1000);
    history = commit(history, 'c', 'drag:1', 1100);
    history = commit(history, 'd', 'title', 1200);
    expect(history.past).toEqual(['a', 'c']);
    history = undo(history);
    expect(history.present).toBe('c');
    history = undo(history);
    expect(history.present).toBe('a');
    history = redo(history);
    expect(history.present).toBe('c');
  });

  it('does not coalesce a key reused after the window, and a new edit clears redo', () => {
    let history = commit(createHistory('a'), 'b', 'title', 0);
    history = commit(history, 'c', 'title', 5000);
    expect(history.past).toEqual(['a', 'b']);
    history = commit(undo(history), 'x');
    expect(history.future).toEqual([]);
  });

  it('writes run results into every snapshot without adding a step', () => {
    let history = commit(commit(createHistory({ v: 1, out: '' }), { v: 2, out: '' }), { v: 3, out: '' });
    history = mapAll(history, value => ({ ...value, out: 'result' }));
    expect(history.past.length).toBe(2);
    expect(undo(history).present).toEqual({ v: 2, out: 'result' });
  });
});
