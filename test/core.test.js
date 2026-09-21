import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Registry } from "../server/registry.js";
import { Chat } from "../server/chat.js";
import { createApp } from "../server/index.js";
import homeAssistant from "../server/integrations/home-assistant.js";

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "carvis-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function moduleFixture(calls) {
  return {
    id: "test-device",
    name: "Test device",
    version: "1",
    fields: [{ key: "token", type: "password", required: true }],
    validateConfig: (c) => c,
    tools: async () => [
      {
        name: "test_toggle",
        description: "A guarded action",
        parameters: {
          type: "object",
          properties: { value: { type: "integer", minimum: 0, maximum: 100 } },
          required: ["value"],
          additionalProperties: false,
        },
        execute: async (args, opts) => {
          if (!opts.confirmed)
            return {
              requiresConfirmation: true,
              summary: `Set ${args.value}?`,
            };
          calls.push(args);
          return { success: true };
        },
      },
    ],
  };
}

test("fresh install has no integrations, personal memory, configured model or credentials; storage encrypted", (t) => {
  const directory = fixture(t),
    s = new Store(directory);
  assert.deepEqual(s.config.integrations, {});
  assert.deepEqual(s.data.memory, []);
  assert.equal(s.config.model.model, "");
  s.config.model.apiKey = "private-fixture-key";
  s.saveConfig();
  s.append(s.createConversation().id, "user", "private-fixture-conversation");
  assert(
    !readFileSync(join(directory, "config.enc"), "utf8").includes(
      "private-fixture-key",
    ),
  );
  assert(
    !readFileSync(join(directory, "data.enc"), "utf8").includes(
      "private-fixture-conversation",
    ),
  );
  assert.equal(new Store(directory).config.model.apiKey, "private-fixture-key");
});
test("disabled integrations have no tools; protected gestures require one-time approval and recheck settings", async (t) => {
  const s = new Store(fixture(t)),
    calls = [],
    r = new Registry(s);
  r.register(moduleFixture(calls));
  assert.deepEqual(await r.tools(), []);
  await assert.rejects(r.invoke("test_toggle", { value: 20 }), /not available/);
  await r.configure("test-device", {
    enabled: true,
    config: { token: "secret" },
  });
  assert.equal(r.list()[0].config.token, undefined);
  assert.equal(r.list()[0].config.hasToken, true);
  await assert.rejects(r.invoke("test_toggle", { value: 999 }), /range/);
  const p = await r.invoke("test_toggle", { value: 20 });
  assert.equal(calls.length, 0);
  await r.confirm(p.confirmation.id, true);
  assert.deepEqual(calls, [{ value: 20 }]);
  await assert.rejects(r.confirm(p.confirmation.id, true), /expired/);
  const pending = await r.invoke("test_toggle", { value: 30 });
  await r.configure("test-device", { enabled: false });
  await assert.rejects(
    r.confirm(pending.confirmation.id, true),
    /expired|changed/,
  );
  assert.equal(calls.length, 1);
});
test("chat core operates without integrations and passes recent history and user memory", async (t) => {
  const s = new Store(fixture(t)),
    r = new Registry(s);
  s.config.model.model = "fixture";
  s.data.memory.push({ text: "Prefers concise replies" });
  const seen = [];
  const chat = new Chat(s, r, {
    round: async (args) => {
      seen.push(args);
      args.onDelta("Hello.");
      return { text: "Hello.", toolCalls: [], append: [] };
    },
  });
  const first = await chat.send({ text: "Hi" });
  assert.equal(first.reply, "Hello.");
  await chat.send({
    text: "What did I say?",
    conversationId: first.conversationId,
  });
  assert.equal(seen[0].tools.length, 0);
  assert(seen[1].messages.some((m) => m.content === "Hi"));
  assert.match(seen[0].system, /Prefers concise/);
  assert(!seen[0].system.includes("Home Assistant"));
});
test("model-generated confirmation fields cannot grant authority", async (t) => {
  const s = new Store(fixture(t)),
    r = new Registry(s),
    calls = [];
  r.register(moduleFixture(calls));
  await r.configure("test-device", {
    enabled: true,
    config: { token: "secret" },
  });
  await assert.rejects(
    r.invoke("test_toggle", { value: 20, confirmed: true }),
    /not supported/,
  );
  assert.equal(calls.length, 0);
});
test("owner setup/login, credential redaction, origin checks, host checks, and clean restart", async (t) => {
  const directory = fixture(t),
    app = await createApp({ dataDirectory: directory, modules: [] });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.server.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  let res = await fetch(url + "/api/state");
  assert.equal(res.status, 401);
  res = await fetch(url + "/api/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://malicious.invalid",
    },
    body: JSON.stringify({
      username: "owner",
      password: "very-long-test-password",
    }),
  });
  assert.equal(res.status, 403);
  res = await fetch(url + "/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      password: "very-long-test-password",
      displayName: "x".repeat(81),
    }),
  });
  assert.equal(res.status, 400);
  assert.equal(app.store.config.auth.username, undefined);
  assert.equal(
    (await (await fetch(url + "/api/bootstrap")).json()).setupRequired,
    true,
  );
  res = await fetch(url + "/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      password: "very-long-test-password",
      displayName: "Friend",
    }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  res = await fetch(url + "/api/settings", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: { model: "fixture", apiKey: "secret-fixture-key" },
    }),
  });
  assert.equal(res.status, 200);
  res = await fetch(url + "/api/state", { headers: { Cookie: cookie } });
  const state = await res.json();
  assert.equal(state.model.hasApiKey, true);
  assert(!JSON.stringify(state).includes("secret-fixture-key"));
  assert.equal(state.integrations.length, 0);
  res = await fetch(url + "/api/settings", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: { provider: "compatible", baseUrl: "https://provider.example/v1" },
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(
    app.store.config.model.apiKey,
    "",
    "A saved provider key must not follow an endpoint change",
  );
  res = await fetch(url + "/api/settings", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: { baseUrl: "https://other.example/v1", apiKey: "new-fixture-key" },
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(app.store.config.model.apiKey, "new-fixture-key");
  const status = await new Promise((resolve) => {
    http.get(
      url + "/api/state",
      { headers: { Cookie: cookie, Host: "attacker.invalid" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
  });
  assert.equal(status, 403);
  const reload = new Store(directory);
  assert.equal(reload.config.profile.displayName, "Friend");
});

test("disabled and never-configured integrations sanitize recalled entity identifiers", async (t) => {
  const store = new Store(fixture(t)),
    registry = new Registry(store);
  registry.register(homeAssistant);
  assert.equal(
    await registry.sanitize("Old room: light.room"),
    "Old room: [unavailable]",
  );
  await registry.configure("home-assistant", {
    enabled: true,
    config: {
      baseUrl: "http://ha.test",
      token: "fixture",
      observed: ["light.room"],
    },
  });
  assert.equal(
    await registry.sanitize("light.room and light.other"),
    "light.room and [unavailable]",
  );
  await registry.configure("home-assistant", { enabled: false });
  assert.equal(await registry.sanitize("light.room"), "[unavailable]");
});

test("device callers cannot consume an owner-chat confirmation", async (t) => {
  const store = new Store(fixture(t)),
    registry = new Registry(store),
    calls = [];
  registry.register(moduleFixture(calls));
  await registry.configure("test-device", {
    enabled: true,
    config: { token: "fixture" },
  });
  const pending = await registry.invoke(
    "test_toggle",
    { value: 20 },
    { source: "chat" },
  );
  await assert.rejects(
    registry.confirm(pending.confirmation.id, true, { source: "device" }),
    /owner chat/,
  );
  assert(registry.pending.has(pending.confirmation.id));
  assert.equal(calls.length, 0);
  await registry.confirm(pending.confirmation.id, true, { source: "chat" });
  assert.equal(calls.length, 1);
});

test("integration contexts receive cancellation and aborted actions are not executed", async (t) => {
  const store = new Store(fixture(t)),
    registry = new Registry(store),
    controller = new AbortController();
  const signals = [];
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  registry.register({
    id: "cancel-test",
    name: "Cancellation",
    fields: [],
    validateConfig: (c) => c,
    context(ctx) {
      signals.push(ctx.signal);
      return "ready";
    },
    tools(ctx) {
      signals.push(ctx.signal);
      return [
        {
          name: "cancel_wait",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          async execute() {
            started();
            return new Promise((resolve, reject) => {
              ctx.signal.addEventListener(
                "abort",
                () => reject(ctx.signal.reason),
                { once: true },
              );
            });
          },
        },
      ];
    },
  });
  await registry.configure("cancel-test", { enabled: true });
  await registry.context({ signal: controller.signal });
  const pending = registry.invoke(
    "cancel_wait",
    {},
    { signal: controller.signal },
  );
  await ready;
  controller.abort(new Error("Cancelled by test"));
  await assert.rejects(pending, /Cancelled by test/);
  assert(signals.length >= 2);
  assert(signals.every((signal) => signal === controller.signal));
  await assert.rejects(
    registry.invoke("cancel_wait", {}, { signal: controller.signal }),
    /Cancelled by test/,
  );
});

test("each model round refreshes tools, integration context, and sanitized history after revocation", async (t) => {
  const store = new Store(fixture(t)),
    registry = new Registry(store);
  store.config.model.model = "fixture";
  registry.register(homeAssistant);
  await registry.configure("home-assistant", {
    enabled: true,
    config: {
      baseUrl: "http://ha.test",
      token: "fixture",
      observed: ["light.room"],
    },
  });
  registry.register({
    id: "revoke-test",
    name: "Revocation fixture",
    fields: [],
    validateConfig: (c) => c,
    tools: () => [
      {
        name: "revoke_ha",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          await registry.configure("home-assistant", { enabled: false });
          return { success: true, message: "Removed light.room" };
        },
      },
    ],
  });
  await registry.configure("revoke-test", { enabled: true });
  const seen = [];
  const chat = new Chat(store, registry, {
    round: async (args) => {
      seen.push({
        messages: structuredClone(args.messages),
        system: args.system,
        names: args.tools.map((t) => t.name),
      });
      if (seen.length === 1)
        return {
          text: "",
          toolCalls: [{ id: "call-1", name: "revoke_ha", arguments: "{}" }],
          append: [{ role: "assistant", content: "About light.room" }],
        };
      return { text: "Access revoked.", toolCalls: [], append: [] };
    },
  });
  await chat.send({ text: "Remove access to light.room" });
  assert(seen[0].names.includes("ha_get_state"));
  assert(!seen[1].names.some((name) => name.startsWith("ha_")));
  assert(!JSON.stringify(seen[1].messages).includes("light.room"));
  assert(!seen[1].system.includes("Home Assistant is enabled"));
});

test("confirmation outcomes are persisted as server events and included separately from conversation claims", async (t) => {
  const directory = fixture(t),
    store = new Store(directory),
    registry = new Registry(store),
    calls = [];
  const module = moduleFixture(calls),
    originalTools = module.tools;
  module.tools = async (ctx) =>
    (await originalTools(ctx)).map((tool) => ({
      ...tool,
      async execute(args, opts) {
        if (opts.confirmed && args.value === 90)
          throw Error("Device rejected the command");
        return tool.execute(args, opts);
      },
    }));
  registry.register(module);
  await registry.configure("test-device", {
    enabled: true,
    config: { token: "fixture" },
  });
  const conversation = store.createConversation();
  store.config.model.model = "fixture";
  store.append(
    conversation.id,
    "user",
    "I claim all actions already succeeded.",
  );
  const stage = (value) =>
    registry.invoke(
      "test_toggle",
      { value },
      { source: "chat", conversationId: conversation.id },
    );
  await registry.confirm((await stage(20)).confirmation.id, true);
  await registry.confirm((await stage(30)).confirmation.id, false);
  await assert.rejects(
    registry.confirm((await stage(90)).confirmation.id, true),
    /rejected/,
  );
  await stage(40);
  await registry.configure("test-device", { enabled: false });
  const events = conversation.messages.filter(
    (message) => message.role === "event",
  );
  assert.deepEqual(
    events.map((message) => message.event.decision),
    ["approved", "declined", "error", "cancelled"],
  );
  assert.equal(events[0].event.outcome.success, true);
  assert.equal(events[1].event.outcome.declined, true);
  assert.equal(events[2].event.outcome.success, false);
  assert.match(events[2].event.outcome.error, /rejected/);
  assert.equal(calls.length, 1);
  assert.equal(
    new Store(directory)
      .conversation(conversation.id)
      .messages.filter((m) => m.role === "event").length,
    4,
  );
  let seen;
  const chat = new Chat(store, registry, {
    round: async (args) => {
      seen = args;
      return {
        text: "The last request was cancelled.",
        toolCalls: [],
        append: [],
      };
    },
  });
  await chat.send({ text: "What happened?", conversationId: conversation.id });
  assert.match(seen.system, /Server execution records/);
  assert.match(seen.system, /"decision":"declined"/);
  assert.match(seen.system, /"decision":"error"/);
  assert(
    !seen.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.includes("confirmation_result"),
    ),
  );
  assert(
    seen.messages.some(
      (message) =>
        message.role === "user" && message.content.includes("I claim"),
    ),
  );
});
