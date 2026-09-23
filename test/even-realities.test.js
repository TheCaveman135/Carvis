import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import even, {
  normalizeWidget,
  pcmToWav,
} from "../server/integrations/even-realities.js";
import { WidgetFocus } from "../integrations/even-realities/basic/focus.ts";
import { UtteranceDetector } from "../integrations/even-realities/basic/audio.ts";

function context(overrides = {}) {
  const state = new Map(),
    calls = [];
  const ctx = {
    config: {
      publicBaseUrl: "https://carvis.example",
      pairingToken: "test-token-for-local-automated-tests-only",
    },
    store: {
      get: (key, fallback) => structuredClone(state.get(key) ?? fallback),
      set: (key, value) => state.set(key, structuredClone(value)),
    },
    registry: {
      describe: async (name) =>
        ["ha_command", "ha_get_state"].includes(name)
          ? {
              name,
              readOnly: name === "ha_get_state",
              parameters: {
                type: "object",
                properties: {
                  entity_id: { type: "string" },
                  service: { type: "string" },
                  brightness_pct: { type: "number" },
                  value: { type: "number" },
                },
                required: ["entity_id"],
                additionalProperties: false,
              },
            }
          : null,
      invoke: async (name, args, options) => {
        calls.push({ name, args, options });
        return name === "ha_get_state"
          ? { state: "on", attributes: { brightness: 127.5 } }
          : { success: true };
      },
      confirm: async (id, accepted, options) => ({
        success: true,
        id,
        accepted,
        options,
      }),
    },
    chat: async ({ text }) => ({
      reply: `Reply to ${text}`,
      conversationId: "test-conversation",
    }),
    ...overrides,
  };
  return { ctx, calls };
}
const command = (service = "toggle") => ({
  tool: "ha_command",
  arguments: { entity_id: "light.demo", service },
});
const put = async (ctx, interaction, display = { title: "Example light" }) =>
  even.tools(ctx)[0].execute({ slot: 1, display, interaction });
const route = (ctx, path, body = {}, method = "POST") =>
  even.route({ path, body, method }, ctx);
const press = (widget, more = {}) => ({
  slot: 1,
  widgetId: widget.widgetId,
  requestId: randomUUID(),
  ...more,
});

test("Even settings require secure pairing without a second speech provider", () => {
  const { ctx } = context();
  assert.equal(even.validateConfig(ctx.config), ctx.config);
  assert.throws(
    () => even.validateConfig({ ...ctx.config, pairingToken: "short" }),
    /32/,
  );
  assert.throws(
    () =>
      even.validateConfig({
        ...ctx.config,
        publicBaseUrl: "http://remote.example",
      }),
    /HTTPS/,
  );
  assert.equal(even.validateConfig(ctx.config), ctx.config);
  assert(!even.fields.some(field => field.key.startsWith('speech') || field.key === 'microphoneEnabled'));
});
test("widgets keep display and interaction separate and reject invalid controls", () => {
  const widget = normalizeWidget({
    slot: 2,
    display: { blank: true },
    interaction: { kind: "button", action: command() },
  });
  assert.equal(widget.display.blank, true);
  assert.equal(widget.interaction.action.tool, "ha_command");
  assert.throws(() => normalizeWidget({ slot: 5 }), /Slot/);
  assert.throws(
    () =>
      normalizeWidget({
        slot: 1,
        interaction: { kind: "slider", action: command(), min: 100, max: 0 },
      }),
    /limits/,
  );
  assert.throws(
    () =>
      normalizeWidget({
        slot: 1,
        interaction: { kind: "dropdown", options: [] },
      }),
    /choices/,
  );
  assert.throws(
    () =>
      normalizeWidget({
        slot: 1,
        interaction: {
          kind: "button",
          action: { tool: "even_realities_clear_screen" },
        },
      }),
    /cannot call/,
  );
});
test("creating widgets validates enabled tools and does not execute an action", async () => {
  const { ctx, calls } = context();
  await put(ctx, { kind: "button", action: command() });
  assert.equal(calls.length, 0);
  await assert.rejects(
    () =>
      put(ctx, {
        kind: "button",
        action: { tool: "unknown_tool", arguments: {} },
      }),
    /not enabled/,
  );
  await assert.rejects(
    () =>
      put(ctx, { kind: "slider", action: command(), argument: "unsupported" }),
    /unsupported/,
  );
});
test("button requests are idempotent and always use normal device permission checks", async () => {
  const { ctx, calls } = context(),
    widget = await put(ctx, { kind: "button", action: command() }),
    body = press(widget);
  const first = await route(ctx, "/action", body),
    second = await route(ctx, "/action", body);
  assert.deepEqual(first, second);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { confirmed: false, source: "device" });
  await assert.rejects(
    () => route(ctx, "/action", { ...body, value: 4 }),
    /already used/,
  );
  await put(ctx, { kind: "button", action: command("turn_off") });
  await assert.rejects(() => route(ctx, "/action", press(widget)), /changed/);
});
test("sliders validate ranges and steps before invoking the exact selected tool", async () => {
  const { ctx, calls } = context();
  const widget = await put(ctx, {
    kind: "slider",
    action: command("turn_on"),
    argument: "brightness_pct",
    min: 0,
    max: 100,
    step: 5,
    value: 50,
    unit: "%",
  });
  await assert.rejects(
    () => route(ctx, "/action", press(widget, { value: 101 })),
    /limits/,
  );
  await assert.rejects(
    () => route(ctx, "/action", press(widget, { value: 53 })),
    /step/,
  );
  const result = await route(ctx, "/action", press(widget, { value: 55 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.brightness_pct, 55);
  assert.equal(result.hud.slots[0].display.value, "55%");
});
test("dropdowns use their stored action and do not accept injected client commands", async () => {
  const { ctx, calls } = context();
  const widget = await put(ctx, {
    kind: "dropdown",
    options: [
      { label: "On", action: command("turn_on") },
      { label: "Off", action: command("turn_off") },
    ],
  });
  await route(
    ctx,
    "/action",
    press(widget, {
      index: 1,
      tool: "other_tool",
      arguments: { entity_id: "light.hidden" },
    }),
  );
  assert.equal(calls[0].args.service, "turn_off");
  assert.equal(calls[0].args.entity_id, "light.demo");
  await assert.rejects(
    () => route(ctx, "/action", press(widget, { index: 4 })),
    /option/,
  );
});
test("guarded actions return confirmation and dry runs never claim to change widget state", async () => {
  const { ctx } = context();
  const widget = await put(
    ctx,
    { kind: "slider", action: command(), min: 0, max: 100, step: 5, value: 10 },
    { value: "10" },
  );
  ctx.registry.invoke = async () => ({
    requiresConfirmation: true,
    confirmation: { id: "one-time-id", summary: "Confirm light change?" },
  });
  const guarded = await route(ctx, "/action", press(widget, { value: 20 }));
  assert.equal(guarded.requiresConfirmation, true);
  assert.equal(guarded.hud.slots[0].interaction.value, 10);
  ctx.registry.invoke = async () => ({ success: true, dryRun: true });
  const preview = await route(ctx, "/action", press(widget, { value: 20 }));
  assert.equal(preview.hud.slots[0].interaction.value, 10);
  const confirmed = await route(ctx, "/confirm", {
    id: "one-time-id",
    accepted: true,
  });
  assert.deepEqual(confirmed.options, { source: "device" });
  assert.equal(
    confirmed.hud.slots[0].interaction.value,
    20,
    "confirmed slider updates only after the registry accepts it",
  );
});
test("live display bindings require read-only tools and strip action details from device feed", async () => {
  const { ctx, calls } = context();
  await assert.rejects(
    () => put(ctx, null, { source: { ...command(), path: "state" } }),
    /read-only/,
  );
  await put(
    ctx,
    {
      kind: "slider",
      action: command("turn_on"),
      argument: "brightness_pct",
      min: 0,
      max: 100,
      step: 5,
      unit: "%",
    },
    {
      title: "Brightness",
      source: {
        tool: "ha_get_state",
        arguments: { entity_id: "light.demo" },
        path: "attributes.brightness",
        scale: 100 / 255,
        suffix: "%",
      },
    },
  );
  const result = await route(ctx, "/feed", {}, "GET");
  assert.equal(result.slots[0].display.value, "50%");
  assert.equal(result.slots[0].interaction.value, 50);
  assert.equal(calls.length, 1);
  assert.equal(result.slots[0].display.source, undefined);
  assert.equal(result.slots[0].interaction.action, undefined);
  await route(ctx, "/feed", {}, "GET");
  assert.equal(calls.length, 1, "read-only polling is throttled");
});
test("chat appears at the bottom and clear removes widgets plus captions", async () => {
  const { ctx } = context();
  await put(ctx, { kind: "button", action: command() });
  const result = await route(ctx, "/chat", { text: "Hello" });
  assert.equal(result.hud.reply, "Reply to Hello");
  assert.equal(result.conversationId, "test-conversation");
  const cleared = await route(ctx, "/clear");
  assert.equal(cleared.reply, "");
  assert.deepEqual(cleared.slots, [null, null, null, null]);
});
test("voice and phone chat retain each confirmation emitted by the core chat loop", async () => {
  const { ctx } = context();
  ctx.chat = async ({ emit }) => {
    emit("confirmation", { id: "first", summary: "Confirm first action" });
    emit("confirmation", { id: "second", summary: "Confirm second action" });
    return { reply: "Please confirm these actions." };
  };
  const result = await route(ctx, "/chat", { text: "Set two guarded things" });
  assert.deepEqual(
    result.confirmations.map((item) => item.id),
    ["first", "second"],
  );
});
test("PCM conversion produces a bounded valid WAV header", () => {
  const wave = pcmToWav(Buffer.alloc(16000).toString("base64"));
  assert.equal(wave.toString("ascii", 0, 4), "RIFF");
  assert.equal(wave.readUInt32LE(24), 16000);
  assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt32LE(40), 16000);
  assert.equal(wave.length, 16044);
  assert.throws(() => pcmToWav("invalid?"), /30 seconds/);
  assert.throws(
    () => pcmToWav(Buffer.alloc(960002).toString("base64")),
    /30 seconds/,
  );
});
function sharedVoice(ctx) {
  const config = {profile:{},model:{},integrations:{
    'assistant-engine':{enabled:true,config:{}},
    'even-realities':{enabled:true,config:{}},
    voice:{enabled:true,config:{voice__enabled:true,voice__inputMuted:false,voice__inputDevice:'even-glasses',stt__enabled:true,stt__engine:'deepgram',stt__model:'nova-3'}},
  },apiKeys:{deepgram:'global-test-key'}};
  ctx.registry.store={config,plugin:()=>({get:(_key,fallback)=>fallback})};
  ctx.registry.available=id=>config.integrations[id]?.enabled && config.integrations['assistant-engine'].enabled;
  return config;
}
test("glasses audio uses the shared Voice provider, model and rotating global key", async () => {
  const {ctx} = context();
  const audio={pcmBase64:Buffer.alloc(16000).toString('base64')};
  await assert.rejects(()=>route(ctx,'/audio',audio),/Enable Voice/);
  const config=sharedVoice(ctx);
  let expectedKey='global-test-key',calls=0;
  ctx.config.speechApiKey='obsolete-key-that-must-not-be-used';
  ctx.fetch=async(url,options)=>{
    calls++;
    assert.equal(new URL(url).hostname,'api.deepgram.com');
    assert.equal(new URL(url).searchParams.get('model'),'nova-3');
    assert.equal(options.headers.Authorization,`Token ${expectedKey}`);
    assert.equal(options.body.toString('ascii',0,4),'RIFF');
    return Response.json({results:{channels:[{alternatives:[{transcript:'Hello Carvis',confidence:.99}]}]}});
  };
  let result=await route(ctx,'/audio',audio);
  assert.equal(result.transcript,'Hello Carvis');assert.equal(result.reply,'Reply to Hello Carvis');
  config.apiKeys.deepgram=expectedKey='rotated-global-key';
  await route(ctx,'/audio',audio);assert.equal(calls,2);
  assert.equal((await route(ctx,'/feed',{},'GET')).voiceEnabled,true);
  config.integrations.voice.config.voice__inputMuted=true;
  await assert.rejects(()=>route(ctx,'/audio',audio),/Enable Voice/);
  assert.equal((await route(ctx,'/feed',{},'GET')).voiceEnabled,false);
  config.integrations.voice.config.voice__inputMuted=false;
  config.integrations.voice.config.voice__inputDevice='local:synthetic';
  await assert.rejects(()=>route(ctx,'/audio',audio),/Enable Voice/);
  config.integrations.voice.config.voice__inputDevice='even-glasses';
  config.integrations.voice.enabled=false;
  await assert.rejects(()=>route(ctx,'/audio',audio),/Enable Voice/);
  config.integrations.voice.enabled=true;
  delete config.apiKeys.deepgram;
  await assert.rejects(()=>route(ctx,'/audio',audio),/Enable Voice/);
  assert.equal(calls,2);
});
test('glasses do not act if microphone access changes during transcription',async()=>{
 const {ctx}=context();const config=sharedVoice(ctx);let chatted=false;
 ctx.chat=async()=>{chatted=true;};
 ctx.fetch=async()=>{
  config.integrations.voice.config.voice__inputMuted=true;
  return Response.json({results:{channels:[{alternatives:[{transcript:'Turn on the light'}]}]}});
 };
 await assert.rejects(()=>route(ctx,'/audio',{pcmBase64:Buffer.alloc(16000).toString('base64')}),/during transcription/);
 assert.equal(chatted,false);
});
test("gesture order is numeric and double tap discards edits without removing widgets", () => {
  const focus = new WidgetFocus();
  const hud = {
    slots: [1, 2, 3, 4].map((slot) => ({
      slot,
      id: `widget-${slot}`,
      display: { value: "50%" },
      interaction: {
        kind: "slider",
        min: 0,
        max: 100,
        value: 50,
        step: 5,
        unit: "%",
      },
    })),
  };
  for (const expected of [1, 2, 3, 4, 1]) {
    focus.swipe(1, hud);
    assert.equal(focus.selected, expected);
  }
  assert.equal(focus.press(hud), null);
  focus.swipe(1, hud);
  assert.equal(focus.preview(hud.slots[0]), "55% · tap to set");
  focus.clear();
  assert.equal(focus.selected, null);
  assert.equal(focus.editing, false);
  assert.equal(hud.slots.filter(Boolean).length, 4);
  focus.swipe(1, hud);
  focus.press(hud);
  focus.swipe(-1, hud);
  assert.deepEqual(focus.press(hud), {
    slot: 1,
    widgetId: "widget-1",
    value: 45,
  });
  hud.slots[0].id = "replaced-widget";
  focus.sync(hud);
  assert.equal(focus.selected, null);
});
test("voice segmentation keeps silence local and includes speech with pre-roll", () => {
  const vad = new UtteranceDetector();
  const quiet = new Uint8Array(3200),
    loud = new Uint8Array(3200);
  const samples = new DataView(loud.buffer);
  for (let i = 0; i < loud.length; i += 2) samples.setInt16(i, 2500, true);
  for (let i = 0; i < 20; i++) assert.equal(vad.push(quiet), null);
  for (let i = 0; i < 5; i++) assert.equal(vad.push(loud), null);
  let utterance;
  for (let i = 0; i < 10; i++) utterance = vad.push(quiet);
  assert.ok(utterance instanceof Uint8Array);
  assert.ok(utterance.length > loud.length * 5);
  assert.equal(vad.finish(), null);
});
