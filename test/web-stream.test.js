import test from "node:test";
import assert from "node:assert/strict";
import { readStreamEvents, createFrameRenderer } from "../web/stream-events.js";

function chunks(bytes, width) {
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += width)
        controller.enqueue(bytes.slice(index, index + width));
      controller.close();
    },
  });
}

test("conversation events preserve UTF-8 and CRLF boundaries at every chunk size", async () => {
  const source = [
    ": keepalive\r\n\r\n",
    'event: delta\r\ndata: {"text":"Hello 🌎"}\r\n\r\n',
    'event: status\ndata: {\ndata: "text":"Working"}\n\n',
    "event: delta\ndata: invalid\n\n",
    'event: done\r\ndata: {"finished":true}',
  ].join("");
  const bytes = new TextEncoder().encode(source);
  for (let width = 1; width <= bytes.length; width++) {
    const stream = chunks(bytes, width);
    const events = [];
    for await (const event of readStreamEvents(stream)) events.push(event);
    assert.deepEqual(
      events,
      [
        { type: "delta", data: { text: "Hello 🌎" } },
        { type: "status", data: { text: "Working" } },
        { type: "done", data: { finished: true } },
      ],
      `chunk width ${width}`,
    );
    assert.equal(stream.locked, false);
  }
});

test("leaving a conversation stream cancels the unread body and releases its lock", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('event: error\ndata: {"error":"Stopped"}\n\n'),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const event of readStreamEvents(stream)) {
    assert.equal(event.type, "error");
    break;
  }
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("stream render bursts share one frame and cancellation prevents stale renders", () => {
  let next = 0,
    renders = 0;
  const pending = new Map();
  const renderer = createFrameRenderer(() => renders++, {
    requestFrame(callback) {
      pending.set(++next, callback);
      return next;
    },
    cancelFrame(id) {
      pending.delete(id);
    },
  });
  for (let i = 0; i < 100; i++) renderer.schedule();
  assert.equal(pending.size, 1);
  pending.get(1)();
  pending.delete(1);
  assert.equal(renders, 1);
  renderer.schedule();
  renderer.cancel();
  assert.equal(pending.size, 0);
  assert.equal(renders, 1);
  renderer.schedule();
  pending.get(3)();
  assert.equal(renders, 2);
});
