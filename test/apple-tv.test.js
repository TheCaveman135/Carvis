import test from "node:test";
import assert from "node:assert/strict";
import integration, {
  validateConfig,
} from "../server/integrations/apple-tv.js";
let serial = 0;
function fixture() {
  const config = {
    addonSlug: "local_apple_tv_ai",
    mediaPlayerEntity: "media_player.tv",
    remoteEntity: "remote.tv",
    context: "",
  };
  const ha = {
    baseUrl: "https://ha.test",
    token: `test-${++serial}`,
    observed: ["media_player.tv", "remote.tv"],
    controlled: ["media_player.tv", "remote.tv"],
    guards: { "remote.tv": "standard" },
    dryRun: false,
  };
  const messages = [],
    requests = [];
  let next = { id: "task-1", status: "running" },
    status = {
      run: { id: "task-1", status: "running" },
      history: [],
      model: "test-model",
    };
  class Socket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.emit({ type: "auth_required" }));
    }
    emit(data) {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(data) }),
      );
    }
    close() {}
    send(raw) {
      const msg = JSON.parse(raw);
      messages.push(msg);
      queueMicrotask(() =>
        this.emit(
          msg.type === "auth"
            ? { type: "auth_ok" }
            : {
                type: "result",
                id: msg.id,
                success: true,
                result: msg.endpoint.endsWith("/info")
                  ? {
                      state: "started",
                      ingress_url: "/api/hassio_ingress/example/",
                    }
                  : { session: "session-test" },
              },
        ),
      );
    }
  }
  const ctx = {
    config,
    createWebSocket: () => new Socket(),
    registry: {
      getConfig(name) {
        assert.equal(name, "home-assistant");
        return ha;
      },
    },
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      requests.push({ path, options });
      if (path.startsWith("/api/states/"))
        return new Response(
          JSON.stringify({
            entity_id: decodeURIComponent(path.split("/").at(-1)),
            state: "on",
            attributes: {
              friendly_name: "TV",
              volume_level: 0.3,
              source_list: ["Streaming"],
            },
          }),
        );
      return new Response(
        JSON.stringify(path.endsWith("/api/status") ? status : next),
      );
    },
  };
  return {
    ctx,
    ha,
    config,
    messages,
    requests,
    setNext: (value) => (next = value),
    setStatus: (value) => (status = value),
    async tool(name) {
      return (await integration.tools(ctx)).find((t) => t.name === name);
    },
  };
}
test("TV configuration requires real entity input and rejects unsafe slugs", () => {
  assert.throws(() => validateConfig({}), /Select/);
  assert.throws(
    () => validateConfig({ remoteEntity: "remote.tv", addonSlug: "../bad" }),
    /slug/,
  );
  assert.equal(
    validateConfig({ remoteEntity: "remote.tv" }).addonSlug,
    "local_apple_tv_ai",
  );
});
test("TV tool instructions follow the owner's reply options", async () => {
  const f = fixture();
  assert.match((await f.tool('tv_button')).description, /stay silent/);
  assert.match((await f.tool('tv_command')).description, /one short reply/);
  f.config.silentNavigation = false;
  f.config.shortReplies = false;
  assert.doesNotMatch((await f.tool('tv_button')).description, /stay silent/);
  assert.match((await f.tool('tv_command')).description, /results naturally/);
});
test("TV authenticates through exact Home Assistant ingress contract", async () => {
  const f = fixture();
  await (await f.tool("tv_start")).execute({ goal: "Find a comedy" });
  assert.deepEqual(f.messages.map((m) => m.endpoint).filter(Boolean), [
    "/addons/local_apple_tv_ai/info",
    "/ingress/session",
  ]);
  const sent = f.requests.find((r) => r.path.endsWith("/api/start"));
  assert.equal(sent.options.headers.Cookie, "ingress_session=session-test");
  assert.equal(sent.options.headers["X-TV-Controller"], "1");
  assert.equal(sent.options.headers.Authorization, undefined);
  const body = JSON.parse(sent.options.body);
  assert.equal(body.goal, "Find a comedy");
  assert.ok(body.request_id);
  assert.equal(body.token, undefined);
});
test("TV preserves contextual instructions and corrects the existing task without restart", async () => {
  const f = fixture();
  f.config.context = "Prefer subtitles";
  await (await f.tool("tv_start")).execute({ goal: "Find a movie" });
  assert.match(
    JSON.parse(
      f.requests.find((r) => r.path.endsWith("/api/start")).options.body,
    ).goal,
    /Prefer subtitles/,
  );
  f.setNext({
    id: "task-1",
    status: "running",
    context_revision: 2,
    applied_context_revision: 1,
  });
  const result = await (
    await f.tool("tv_context")
  ).execute({ id: "task-1", context: "Use the other streaming app" });
  const body = JSON.parse(
    f.requests.find((r) => r.path.endsWith("/api/context")).options.body,
  );
  assert.equal(body.task_id, "task-1");
  assert.equal(body.context, "Use the other streaming app");
  assert.ok(body.update_id);
  assert.equal(result.applied, false);
  assert.equal(
    f.requests.filter((r) => r.path.endsWith("/api/start")).length,
    1,
  );
  assert.equal(
    f.requests.filter((r) => r.path.endsWith("/api/stop")).length,
    0,
  );
});
test("TV reports historical task status and verifies only with explicit completion evidence", async () => {
  const f = fixture();
  f.setStatus({
    run: { id: "new", status: "running" },
    history: [
      { id: "old", status: "completed", completion_check: { confirmed: true } },
    ],
    model: "test",
  });
  const t = await f.tool("tv_status");
  assert.equal(t.readOnly, true);
  const result = await t.execute({ id: "old" });
  assert.equal(result.id, "old");
  assert.equal(result.completion_verified, true);
  assert.equal(result.live_observation, false);
});
test("TV navigation uses AI controller only and reports silent success without visual verification", async () => {
  const f = fixture();
  f.setNext({ id: "command-1", status: "completed" });
  const result = await (await f.tool("tv_button")).execute({ button: "left" });
  const body = JSON.parse(
    f.requests.find((r) => r.path.endsWith("/api/command")).options.body,
  );
  assert.deepEqual(body.data, { command: "left" });
  assert.equal(body.entity_id, "remote.tv");
  assert.equal(result.silent, true);
  assert.equal(result.verified, false);
  assert.equal(
    f.requests.filter((r) => r.path.startsWith("/api/services/")).length,
    0,
  );
});
test("TV navigation checks the remote that will receive the command, including its guard", async () => {
  const f = fixture();
  const button = await f.tool("tv_button");
  f.ha.controlled = ["remote.tv"];
  f.ha.guards["remote.tv"] = "protected";
  assert.match(await button.confirmation({ button: "left" }), /TV button: left/);
  assert.equal(
    (await button.execute({ button: "left" })).requiresConfirmation,
    true,
  );
  assert.equal(f.requests.filter((r) => r.path.endsWith("/api/command")).length, 0);
  f.setNext({ id: "command-2", status: "completed" });
  assert.equal(
    (await button.execute({ button: "left" }, { confirmed: true })).success,
    true,
  );
  f.ha.controlled = ["media_player.tv"];
  delete f.ha.guards["remote.tv"];
  await assert.rejects(
    () => button.execute({ button: "left" }),
    /Select this TV for control/,
  );
  assert.equal(f.requests.filter((r) => r.path.endsWith("/api/command")).length, 1);
});
test("Visual TV tasks require every configured control target and honor the strongest guard", async () => {
  const f = fixture();
  f.ha.controlled = ["media_player.tv"];
  delete f.ha.guards["remote.tv"];
  await assert.rejects(
    () => (f.tool("tv_start")).then((tool) => tool.execute({ goal: "Open a movie" })),
    /Select this TV for control/,
  );
  await assert.rejects(() => integration.test(f.ctx), /Select this TV for control/);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/api/start")).length, 0);

  f.ha.controlled.push("remote.tv");
  f.ha.guards["remote.tv"] = "protected";
  for (const [name, args] of [
    ["tv_start", { goal: "Open a movie" }],
    ["tv_context", { id: "task-1", context: "Try Netflix" }],
    ["tv_cancel", { id: "task-1" }],
  ]) {
    const tool = await f.tool(name);
    assert.match(await tool.confirmation(args), /TV task/);
    assert.equal((await tool.execute(args)).requiresConfirmation, true);
  }
  assert.equal(f.requests.filter((r) => r.path.includes("/api/hassio_ingress/")).length, 0);
});
test("TV volume converts human percent to HA level before controller transport", async () => {
  const f = fixture();
  f.setNext({ id: "command-1", status: "completed" });
  await (
    await f.tool("tv_command")
  ).execute({
    entity_id: "media_player.tv",
    service: "volume_set",
    volume_percent: 25,
  });
  assert.equal(
    JSON.parse(
      f.requests.find((r) => r.path.endsWith("/api/command")).options.body,
    ).data.volume_level,
    0.25,
  );
});
test("TV dry run, guard, background and reselected entity gates happen before actuation", async () => {
  const f = fixture(),
    t = await f.tool("tv_start");
  f.ha.dryRun = true;
  assert.equal((await t.execute({ goal: "Open streaming" })).dryRun, true);
  assert.equal(f.messages.length, 0);
  f.ha.dryRun = false;
  f.ha.guards["media_player.tv"] = "protected";
  assert.equal(
    (await t.execute({ goal: "Open streaming" })).requiresConfirmation,
    true,
  );
  await assert.rejects(
    () =>
      t.execute(
        { goal: "Open streaming" },
        { confirmed: true, source: "automation" },
      ),
    /live owner/,
  );
  f.ha.controlled = [];
  f.ha.guards = {};
  await assert.rejects(
    () => t.execute({ goal: "Open streaming" }, { confirmed: true }),
    /Select this TV for control/,
  );
  assert.equal(f.messages.length, 0);
});
test("TV stop sends the exact task ID and disabled HA blocks every route", async () => {
  const f = fixture();
  f.setNext({ id: "task-1", status: "stopped" });
  await (await f.tool("tv_cancel")).execute({ id: "task-1" });
  assert.deepEqual(
    JSON.parse(
      f.requests.find((r) => r.path.endsWith("/api/stop")).options.body,
    ),
    { request_id: "task-1" },
  );
  f.ctx.registry.getConfig = () => {
    throw Error("Integration disabled");
  };
  await assert.rejects(
    () => integration.route({ method: "GET", path: "/status" }, f.ctx),
    /disabled/,
  );
});
test("TV uncertain mutation and busy responses are never retried automatically", async () => {
  for (const failure of ["network", "busy"]) {
    const f = fixture(),
      normal = f.ctx.fetch;
    let mutations = 0;
    f.ctx.fetch = async (url, options) => {
      if (url.endsWith("/api/start")) {
        mutations++;
        if (failure === "network") throw Error("lost");
        return new Response("{}", { status: 409 });
      }
      return normal(url, options);
    };
    await assert.rejects(
      () => f.tool("tv_start").then((t) => t.execute({ goal: "Find a movie" })),
      failure === "network" ? /uncertain/ : /busy/,
    );
    assert.equal(mutations, 1);
  }
});

test('screen capture accepts camera IDs and rejects media players',()=>{
 assert.equal(validateConfig({remoteEntity:'remote.tv',cameraEntity:'camera.hdmi'}).cameraEntity,'camera.hdmi');
 assert.throws(()=>validateConfig({remoteEntity:'remote.tv',cameraEntity:'media_player.tv'}),/camera entity/);
});
