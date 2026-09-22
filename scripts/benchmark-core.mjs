// Synthetic, local-only comparisons. These measure CPU work, not response or
// device latency. No configured installation, model provider or home is used.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { recentMessages } from "../server/conversation-context.js";
import { createStateView, visibleState } from "../server/home/state.js";

function measure(run) {
  for (let i = 0; i < 3; i++) run();
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

function compare(name, before, after) {
  assert.deepEqual(after(), before(), `${name}: output must remain identical`);
  const oldMs = measure(before);
  const newMs = measure(after);
  return {
    workload: name,
    beforeMs: Number(oldMs.toFixed(4)),
    afterMs: Number(newMs.toFixed(4)),
    speedup: `${(oldMs / newMs).toFixed(1)}x`,
  };
}

const conversation = {
  messages: Array.from({ length: 100_000 }, (_, i) => ({
    role: i % 3 === 0 ? "event" : i % 3 === 1 ? "user" : "assistant",
    content: `Synthetic message ${i}`,
  })),
};
const config = {
  observed: Array.from({ length: 2000 }, (_, i) => `light.fixture_${i}`),
};
const states = Array.from({ length: 4000 }, (_, i) => ({
  entity_id: `light.fixture_${i}`,
  state: "on",
  attributes: { friendly_name: `Fixture ${i}`, source: "light.unselected" },
}));

console.table([
  compare(
    "Recent 24 messages from 100,000",
    () =>
      conversation.messages
        .filter((message) => ["user", "assistant"].includes(message.role))
        .slice(-24),
    () => recentMessages(conversation),
  ),
  compare(
    "2,000 selected states from 4,000",
    () =>
      states
        .filter((state) => config.observed.includes(state.entity_id))
        .map((state) => visibleState(state, config)),
    () => {
      const selected = new Set(config.observed);
      const view = createStateView(config);
      return states.filter((state) => selected.has(state.entity_id)).map(view);
    },
  ),
]);
