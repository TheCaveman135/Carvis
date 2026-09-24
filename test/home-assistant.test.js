import test from "node:test";
import assert from "node:assert/strict";
import integration, {
  validateConfig,
} from "../server/integrations/home-assistant.js";

function fixture(overrides = {}) {
  const config = {
    baseUrl: "http://ha.test:8123",
    token: "test-token",
    observed: ["light.room"],
    controlled: ["light.room"],
    dryRun: false,
    ...overrides,
  };
  const states = new Map([
    [
      "light.room",
      {
        entity_id: "light.room",
        state: "on",
        attributes: {
          friendly_name: "Room light",
          brightness: 180,
          supported_color_modes: ["rgb", "color_temp"],
          min_color_temp_kelvin: 2000,
          max_color_temp_kelvin: 6500,
          effect_list: ["rainbow"],
        },
      },
    ],
    [
      "lock.entry",
      {
        entity_id: "lock.entry",
        state: "locked",
        attributes: { friendly_name: "Entry lock" },
      },
    ],
    [
      "light.hidden",
      {
        entity_id: "light.hidden",
        state: "on",
        attributes: { friendly_name: "Private room" },
      },
    ],
    [
      "number.speed",
      {
        entity_id: "number.speed",
        state: "10",
        attributes: { min: 0, max: 20, step: 1 },
      },
    ],
    [
      "media_player.television",
      {
        entity_id: "media_player.television",
        state: "playing",
        attributes: { friendly_name: "Apple TV" },
      },
    ],
  ]);
  const calls = [];
  const ctx = {
    config,
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, options });
      if (path === "/api/")
        return new Response(JSON.stringify({ message: "API running" }));
      if (path === "/api/states")
        return new Response(JSON.stringify([...states.values()]));
      if (path.startsWith("/api/states/")) {
        const state = states.get(decodeURIComponent(path.split("/").at(-1)));
        return new Response(JSON.stringify(state), {
          status: state ? 200 : 404,
        });
      }
      if (path.startsWith("/api/services/")) return new Response("[]");
      throw Error("Unexpected request");
    },
    registry: {
      getConfig() {
        throw Error("disabled");
      },
    },
  };
  return {
    ctx,
    config,
    states,
    calls,
    async tool(name) {
      return (await integration.tools(ctx)).find((t) => t.name === name);
    },
  };
}
test("HA configuration is private by default and control implies observation", () => {
  const cfg = validateConfig({
    baseUrl: "https://ha.test/",
    token: "test",
    controlled: "light.room, switch.desk",
  });
  assert.deepEqual(cfg.observed, ["light.room", "switch.desk"]);
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.baseUrl, "https://ha.test");
  assert.throws(
    () => validateConfig({ ...cfg, baseUrl: "https://name:password@ha.test" }),
    /without credentials/,
  );
  assert.throws(
    () => validateConfig({ ...cfg, guards: { "lock.other": "standard" } }),
    /controlled entities/,
  );
});

test('Home Assistant connection errors explain setup problems without leaking server responses', async () => {
  const f = fixture();
  const read = await f.tool('ha_list_entities');
  f.ctx.fetch = async () => { throw new TypeError('fetch failed: private fixture host'); };
  await assert.rejects(() => read.execute({}), /Could not reach Home Assistant.*address and connection/);
  f.ctx.fetch = async () => { const e = Error('private timeout detail'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(() => read.execute({}), /did not respond within 15 seconds/);
  f.ctx.fetch = async () => new Response('<html>login</html>', { status: 200 });
  await assert.rejects(() => read.execute({}), /unexpected response.*points to Home Assistant/);
  f.ctx.fetch = async () => new Response('private error body', { status: 401 });
  await assert.rejects(() => read.execute({}), /Check the access token/);
  const cancelled = new AbortController();
  cancelled.abort(Error('request cancelled'));
  f.ctx.signal = cancelled.signal;
  f.ctx.fetch = async () => { throw cancelled.signal.reason; };
  await assert.rejects(() => read.execute({}), /request cancelled/);
});
test("model entity list contains only selected devices, owner picker can enumerate", async () => {
  const f = fixture(),
    tool = await f.tool("ha_list_entities");
  assert.equal(tool.readOnly, true);
  assert.deepEqual(
    (await tool.execute({})).entities.map((s) => s.entity_id),
    ["light.room"],
  );
  assert.equal(
    (await integration.route({ method: "GET", path: "/entities" }, f.ctx))
      .entities.length,
    5,
  );
  const read = await f.tool("ha_get_state");
  await assert.rejects(
    () => read.execute({ entity_id: "light.hidden" }),
    /not selected/,
  );
});
test("state and history sanitization mask unselected IDs and discard sensitive attributes", async () => {
  const f = fixture();
  Object.assign(f.states.get("light.room").attributes, {
    description: "Controlled by light.hidden",
    friendly_name: "See light.hidden",
    access_token: "private-value",
  });
  f.states.get("light.room").state = "Ready after update.hidden_firmware";
  const result = await (
    await f.tool("ha_get_state")
  ).execute({ entity_id: "light.room" });
  assert.equal(result.attributes.access_token, undefined);
  assert.equal(result.attributes.description, undefined);
  assert.equal(result.attributes.friendly_name, "See [unavailable]");
  assert.equal(result.state, "Ready after [unavailable]");
  assert.deepEqual(
    integration.sanitize([{ content: "light.room versus lock.entry" }], f.ctx),
    [{ content: "light.room versus [unavailable]" }],
  );
  assert.equal(
    integration.sanitize("light.room and lock.entry", {
      config: {},
      enabled: false,
    }),
    "[unavailable] and [unavailable]",
  );
  assert.equal(integration.sanitize('update.hidden_firmware and weather.hidden but light.room', f.ctx),
    '[unavailable] and [unavailable] but light.room');
});
test("commands reject unselected entities, inappropriate parameters, and unsupported color without service requests", async () => {
  const f = fixture(),
    t = await f.tool("ha_command");
  await assert.rejects(
    () => t.execute({ entity_id: "light.hidden", service: "turn_off" }),
    /not selected/,
  );
  await assert.rejects(
    () =>
      t.execute({
        entity_id: "light.room",
        service: "turn_off",
        brightness_pct: 50,
      }),
    /do not apply/,
  );
  await assert.rejects(
    () => t.execute({ entity_id: "light.room", service: "unlock" }),
    /not allowed/,
  );
  f.states.get("light.room").attributes.supported_color_modes = ["brightness"];
  await assert.rejects(
    () =>
      t.execute({
        entity_id: "light.room",
        service: "turn_on",
        rgb_color: [1, 2, 3],
      }),
    /supported RGB/,
  );
  assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 0);
});
test("ordinary light parameters are typed, preserve zero brightness, and verify actual state", async () => {
  const f = fixture(),
    t = await f.tool("ha_command");
  const result = await t.execute({
    entity_id: "light.room",
    service: "turn_on",
    brightness_pct: 0,
    rgb_color: [255, 0, 0],
  });
  const sent = JSON.parse(
    f.calls.find((c) => c.options.method === "POST").options.body,
  );
  assert.deepEqual(sent, {
    entity_id: "light.room",
    brightness_pct: 0,
    rgb_color: [255, 0, 0],
  });
  assert.equal(result.accepted, true);
  const off = await t.execute({ entity_id: "light.room", service: "turn_off" });
  assert.equal(off.verified, false);
  assert.match(off.message, /not yet confirmed/);
});

test('light power checks a delayed HA state once more without sending the command twice', async () => {
  const f = fixture(), original = f.ctx.fetch;
  let readsAfterAction = 0;
  f.ctx.fetch = async (url, options) => {
    if (url.includes('/api/states/light.room') && f.calls.some(c => c.options.method === 'POST')) {
      readsAfterAction++;
      if (readsAfterAction === 2) f.states.get('light.room').state = 'off';
    }
    return original(url, options);
  };
  const result = await (await f.tool('ha_command')).execute({ entity_id: 'light.room', service: 'turn_off' });
  assert.equal(result.accepted, true);
  assert.equal(result.verified, true);
  assert.equal(readsAfterAction, 2);
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
});

test('zero brightness is verified as off because HA treats it as turning the light off', async () => {
  const f = fixture(), original = f.ctx.fetch;
  f.ctx.fetch = async (url, options) => {
    const result = await original(url, options);
    if (url.includes('/api/services/light/turn_on')) f.states.get('light.room').state = 'off';
    return result;
  };
  const result = await (await f.tool('ha_command')).execute({ entity_id: 'light.room', service: 'turn_on', brightness_pct: 0 });
  assert.equal(result.accepted, true);
  assert.equal(result.verified, true);
  assert.equal(result.state.state, 'off');
});
test("default guarded devices need confirmation, reject background; locking is a protective exception", async () => {
  const f = fixture({ controlled: ["lock.entry"] }),
    t = await f.tool("ha_command");
  const args = { entity_id: "lock.entry", service: "unlock" };
  assert.match(await t.confirmation(args), /unlock/);
  assert.equal((await t.execute(args)).requiresConfirmation, true);
  assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 0);
  await assert.rejects(
    () => t.execute(args, { confirmed: true, source: "automation" }),
    /live owner/,
  );
  assert.equal(
    (await t.execute(args, { confirmed: true, source: "chat" })).accepted,
    true,
  );
  assert.equal(
    await t.confirmation({ entity_id: "lock.entry", service: "lock" }),
    null,
  );
});
test("explicit standard override works and protected override forces a confirmation", async () => {
  const f = fixture({
      controlled: ["lock.entry"],
      guards: { "lock.entry": "standard" },
    }),
    t = await f.tool("ha_command");
  assert.equal(
    await t.confirmation({ entity_id: "lock.entry", service: "unlock" }),
    null,
  );
  assert.equal(
    (await t.execute({ entity_id: "lock.entry", service: "unlock" })).accepted,
    true,
  );
  f.config.guards["lock.entry"] = "protected";
  assert.equal(
    (await t.execute({ entity_id: "lock.entry", service: "lock" }))
      .requiresConfirmation,
    true,
  );
});
test("dry run never sends a service request and selection is checked again at execute", async () => {
  const f = fixture({ dryRun: true }),
    t = await f.tool("ha_command");
  assert.equal(
    (await t.execute({ entity_id: "light.room", service: "toggle" })).dryRun,
    true,
  );
  assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 0);
  f.config.controlled = [];
  await assert.rejects(
    () =>
      t.execute(
        { entity_id: "light.room", service: "toggle" },
        { confirmed: true },
      ),
    /not selected/,
  );
});
test("device numeric bounds are mandatory and enforced", async () => {
  const f = fixture({ controlled: ["number.speed"] }),
    t = await f.tool("ha_command");
  await assert.rejects(
    () =>
      t.execute({ entity_id: "number.speed", service: "set_value", value: 21 }),
    /range/,
  );
  await assert.rejects(
    () => t.execute({ entity_id: "number.speed", service: "set_value" }),
    /Provide value/,
  );
});
test("failed state verification never loses evidence that a command was already accepted", async () => {
  const f = fixture(),
    normal = f.ctx.fetch;
  let acted = false;
  f.ctx.fetch = async (url, options) => {
    if (acted && url.includes("/api/states/")) throw Error("network lost");
    const result = await normal(url, options);
    if (url.includes("/api/services/")) acted = true;
    return result;
  };
  const result = await (
    await f.tool("ha_command")
  ).execute({ entity_id: "light.room", service: "turn_off" });
  assert.equal(result.accepted, true);
  assert.equal(result.verified, false);
  assert.match(result.message, /before retrying/);
});
test("Apple TV commands are delegated exclusively and disabled integration cannot cause direct fallback", async () => {
  const f = fixture({ controlled: ["media_player.television"] }),
    t = await f.tool("ha_command");
  const args = { entity_id: "media_player.television", service: "media_pause" };
  await assert.rejects(
    () => t.execute(args),
    /Enable and configure TV AI Controller/,
  );
  let invoked;
  f.ctx.registry = {
    getConfig: () => ({ mediaPlayerEntity: "media_player.television" }),
    invoke: async (...a) => {
      invoked = a;
      return { success: true };
    },
  };
  await t.execute(args);
  assert.equal(invoked[0], "tv_command");
  assert.deepEqual(invoked[1], args);
  assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 0);
});

test('Owner entity selector includes rooms and units without expanding model visibility',async()=>{
 const f=fixture(),original=f.ctx.fetch;
 f.ctx.fetch=async(url,options)=>new URL(url).pathname==='/api/template'?new Response(JSON.stringify({'light.room':{id:'living',name:'Living Room'}})):original(url,options);
 const result=await integration.route({method:'GET',path:'/entities'},f.ctx);
 assert.equal(result.entities.find(e=>e.entity_id==='light.room').area_name,'Living Room');
 assert.equal(result.entities.find(e=>e.entity_id==='lock.entry').area_id,'');
 assert.equal(result.areaWarning,undefined);
 const tool=await f.tool('ha_list_entities');assert.deepEqual((await tool.execute({})).entities.map(e=>e.entity_id),['light.room']);
});
test('Room lookup failure leaves owner entity selection available with a warning',async()=>{
 const f=fixture();const result=await integration.route({method:'GET',path:'/entities'},f.ctx);
 assert.ok(result.entities.length);assert.match(result.areaWarning,/Room information/);
 assert.ok(result.entities.every(e=>e.area_id===''));
});

test('white tone reaches HA for every color mode, with approximation reported', async () => {
  const f = fixture(), t = await f.tool('ha_command');
  const args = { entity_id: 'light.room', service: 'turn_on', color_temp_kelvin: 4000, brightness_pct: 35 };
  for (const mode of ['hs', 'xy', 'rgb', 'rgbw', 'rgbww']) {
    // Color-only lights need no native white-temperature limits.
    f.states.get('light.room').attributes = { supported_color_modes: [mode] };
    const result = await t.execute(args);
    assert.equal(result.accepted, true);
    assert.equal(result.approximate, true);
    assert.match(result.note, /approximate/);
    const sent = JSON.parse(f.calls.filter(c => c.options.method === 'POST').at(-1).options.body);
    assert.deepEqual(sent, { entity_id: 'light.room', color_temp_kelvin: 4000, brightness_pct: 35 });
  }
});

test('white-tone fallback preserves native limits, validation, selection, guards, and dry run', async () => {
  const f = fixture(), t = await f.tool('ha_command');
  const args = { entity_id: 'light.room', service: 'turn_on', color_temp_kelvin: 4000 };
  assert.equal((await t.execute(args)).approximate, undefined);
  const before = f.calls.filter(c => c.options.method === 'POST').length;
  await assert.rejects(() => t.execute({ ...args, color_temp_kelvin: 7000 }), /reported range/);
  await assert.rejects(() => t.execute({ ...args, rgb_color: [255, 255, 255] }), /not both/);
  for (const mode of ['brightness', 'onoff', 'white']) {
    f.states.get('light.room').attributes = { supported_color_modes: [mode] };
    await assert.rejects(() => t.execute(args), /cannot change/);
  }
  f.states.get('light.room').attributes = { supported_color_modes: ['xy'] };
  for (const color_temp_kelvin of [0, 999, 40001, 4000.5, '4000', NaN])
    await assert.rejects(() => t.execute({ ...args, color_temp_kelvin }), /whole number/);
  await assert.rejects(() => t.execute({ ...args, service: 'turn_off' }), /do not apply/);
  f.config.guards = { 'light.room': 'protected' };
  assert.equal((await t.execute(args)).requiresConfirmation, true);
  f.config.dryRun = true;
  const preview = await t.execute(args, { source: 'chat' });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.approximate, true);
  f.config.controlled = [];
  f.config.guards = {};
  await assert.rejects(() => t.execute(args, { confirmed: true }), /not selected/);
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, before);
});
