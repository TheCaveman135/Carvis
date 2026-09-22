import test from "node:test";
import assert from "node:assert/strict";
import {
  executionRecords,
  recentMessages,
} from "../server/conversation-context.js";

function record(index, outcome = {}) {
  return {
    role: "event",
    createdAt: index,
    event: {
      type: "confirmation_result",
      source: "carvis_registry",
      confirmationId: String(index),
      tool: "fixture_write",
      decision: "declined",
      summary: "Fixture action",
      outcome,
    },
  };
}

test("recent context stops before old history and keeps chronological ordering", () => {
  const messages = new Array(100_000);
  Object.defineProperty(messages, 0, {
    get() {
      throw Error("Scanned old history");
    },
  });
  for (let i = 1; i < messages.length; i++)
    messages[i] = { role: "user", content: String(i) };
  messages.push(record(100_000));
  const recent = recentMessages({ messages });
  assert.equal(recent.length, 24);
  assert.equal(recent[0].content, "99976");
  assert.equal(recent.at(-1).content, "99999");
  for (let i = 0; i < 30; i++) messages.push(record(i));
  assert.deepEqual(
    executionRecords({ messages }).map((event) => event.confirmationId),
    Array.from({ length: 16 }, (_, i) => String(i + 14)),
  );
});

test("execution evidence excludes message claims and applies exact count and serialized-size limits", () => {
  const messages = Array.from({ length: 30 }, (_, i) =>
    record(i, {
      success: false,
      message: '"\\'.repeat(2000),
      nested: { secret: true },
    }),
  );
  messages.push({ ...record(999), role: "assistant" });
  messages.push({
    ...record(998),
    event: { ...record(998).event, source: "model" },
  });
  const records = executionRecords({ messages });
  assert.ok(records.length > 0 && records.length < 16);
  assert.ok(JSON.stringify(records).length <= 16000);
  assert.equal(records.at(-1).confirmationId, "29");
  assert.equal(records.at(-1).outcome.message.length, 2000);
  assert.equal(records.at(-1).outcome.nested, undefined);
  const omitted = executionRecords({
    messages: [messages[29 - records.length]],
  })[0];
  assert.ok(JSON.stringify([omitted, ...records]).length > 16000);
});

test("an oversized newest evidence record does not let older evidence replace it", () => {
  const fields = [
    "success",
    "accepted",
    "verified",
    "dryRun",
    "declined",
    "requiresConfirmation",
    "error",
    "message",
    "id",
    "status",
  ];
  const oversized = Object.fromEntries(
    fields.map((field) => [field, "x".repeat(2000)]),
  );
  assert.deepEqual(
    executionRecords({ messages: [record(1), record(2, oversized)] }),
    [],
  );
});
