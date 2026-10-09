// A model's scratchpad is not a deliverable. Some models open their answer with a <think>…</think>
// span; AwwO removes it at the runtime boundary so it never reaches the canvas, a downstream
// prompt or a team member. A reply that is ONLY a scratchpad (unterminated, or nothing after it)
// delivered nothing and fails as `reasoning_only_output` rather than publishing the scratchpad.

const OPEN = '<think>';
const CLOSE = '</think>';

export function splitReasoning(text: string): { answer: string; delivered: boolean; reasoning: number } {
  const start = text.length - text.trimStart().length;
  if (!text.startsWith(OPEN, start)) return { answer: text, delivered: true, reasoning: 0 };
  const end = text.indexOf(CLOSE, start + OPEN.length);
  if (end < 0) return { answer: '', delivered: false, reasoning: text.length - start };
  const answer = text.slice(end + CLOSE.length).trimStart();
  return { answer, delivered: answer.trim().length > 0, reasoning: end - start - OPEN.length };
}

/** Idempotent normalization for stored text (a delivered answer stays unchanged). */
export function stripReasoningPreamble(text: string): string {
  const { answer, delivered } = splitReasoning(text);
  return delivered ? answer : text;
}

/** Streaming twin of splitReasoning: feeds deltas, emits only answer text. */
export class ReasoningStream {
  private mode: 'undecided' | 'thinking' | 'answer' = 'undecided';
  private buffer = '';
  reasoningCharacters = 0;

  push(delta: string): string {
    if (this.mode === 'answer') return delta;
    this.buffer += delta;
    if (this.mode === 'undecided') {
      const trimmed = this.buffer.trimStart();
      if (trimmed.length < OPEN.length && OPEN.startsWith(trimmed)) return '';
      if (!trimmed.startsWith(OPEN)) {
        this.mode = 'answer';
        const out = this.buffer;
        this.buffer = '';
        return out;
      }
      this.mode = 'thinking';
      this.buffer = trimmed.slice(OPEN.length);
    }
    const end = this.buffer.indexOf(CLOSE);
    if (end < 0) {
      // Keep only enough tail to recognise a closing tag split across deltas.
      const keep = CLOSE.length - 1;
      this.reasoningCharacters += Math.max(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(-keep);
      return '';
    }
    this.reasoningCharacters += end;
    const rest = this.buffer.slice(end + CLOSE.length).trimStart();
    this.buffer = '';
    this.mode = 'answer';
    return rest;
  }
}
