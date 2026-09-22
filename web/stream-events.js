/** Parse the JSON event payloads emitted by the conversation endpoint. */
function parseEvent(block) {
  let type = "message";
  const lines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
  }
  if (!lines.length) return null;
  try {
    return { type, data: JSON.parse(lines.join("\n")) };
  } catch {
    return null;
  }
}

/** Preserve UTF-8 and event boundaries even when a CRLF spans two chunks. */
export async function* readStreamEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      completed = done;
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = parseEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (event) yield event;
      }
    }
    const finalEvent = parseEvent(buffer);
    if (finalEvent) yield finalEvent;
  } finally {
    // If a consumer exits on an error event, release the underlying connection.
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Coalesce token updates into at most one visible render per animation frame. */
export function createFrameRenderer(
  render,
  {
    requestFrame = globalThis.requestAnimationFrame,
    cancelFrame = globalThis.cancelAnimationFrame,
  } = {},
) {
  let frame = null;
  return {
    schedule() {
      if (frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        render();
      });
    },
    cancel() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}
