// Server-sent events over fetch. EventSource cannot POST and cannot send an Authorization header,
// and the orchestrator streams both plans (POST) and token-protected graph runs, so the canvas
// reads every stream through this one parser.

export interface SseFrame {
  id?: number;
  event?: string;
  data: unknown;
}

/** Split the complete frames off `buffer`. Comments (`: ping`) and unparsable data are skipped. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const text = buffer.replace(/\r\n/g, '\n');
  const frames: SseFrame[] = [];
  let start = 0;
  for (let end = text.indexOf('\n\n', start); end >= 0; end = text.indexOf('\n\n', start)) {
    const block = text.slice(start, end);
    start = end + 2;
    let id: number | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id' && Number.isFinite(Number(value))) id = Number(value);
    }
    if (!data.length) continue;
    try {
      frames.push({ ...(id !== undefined ? { id } : {}), ...(event ? { event } : {}), data: JSON.parse(data.join('\n')) });
    } catch {
      // A frame that is not JSON is not ours; skip it rather than end the stream.
    }
  }
  return { frames, rest: text.slice(start) };
}

/** Read a text/event-stream body to its end, handing each frame over as it completes. */
export async function readSse(body: ReadableStream<Uint8Array>, onFrame: (frame: SseFrame) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parsed = parseSseFrames(buffer + decoder.decode(value, { stream: true }));
    buffer = parsed.rest;
    for (const frame of parsed.frames) onFrame(frame);
  }
  for (const frame of parseSseFrames(`${buffer}${decoder.decode()}\n\n`).frames) onFrame(frame);
}
