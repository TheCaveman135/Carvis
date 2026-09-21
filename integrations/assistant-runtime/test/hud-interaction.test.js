import test from "node:test";
import assert from "node:assert/strict";
import {
  configureInteraction,
  interactionDisplay,
  HudInteractions,
} from "../server/hud-interaction.js";
import { buildTools } from "../server/tools/index.js";

function fixture() {
  const cfg = {
    entities: {
      controlled: [
        "light.desk",
        "fan.room",
        "select.mode",
        "scene.movie",
        "number.level",
      ],
      observed: [],
      guards: {},
    },
    agent: { dryRun: false },
  };
  const ha = {
    states: new Map([
      [
        "light.desk",
        {
          state: "on",
          attributes: { brightness: 128, rgb_color: [0, 0, 255] },
        },
      ],
      ["fan.room", { state: "on", attributes: { percentage: 45 } }],
      [
        "select.mode",
        { state: "Night", attributes: { options: ["Day", "Night"] } },
      ],
      ["scene.movie", { state: "unknown", attributes: {} }],
      [
        "number.level",
        { state: "1.5", attributes: { min: 0, max: 4, step: 0.5 } },
      ],
    ]),
    friendlyName: (id) => id,
  };
  const schema = buildTools({ ha, getConfig: () => cfg }).find(
    (t) => t.name === "ha.entity.command",
  ).schema;
  const calls = [],
    confirmations = [];
  const hud = {
    slots: new Map(),
    refresh() {},
    state() {
      return { slots: [...this.slots.values()] };
    },
  };
  const voice = {
    stageDirectConfirmation: (c) => {
      confirmations.push(c);
      return {
        outcome: "confirmation",
        confirmation: { id: "confirm-1", prompt: c.prompt },
      };
    },
  };
  const gateway = {
    call: async (...args) => {
      calls.push(args);
      return { success: true };
    },
  };
  const gestures = new HudInteractions({
    hud,
    ha,
    getConfig: () => cfg,
    gateway,
    voice,
  });
  function create(interaction, display = {}) {
    const binding = configureInteraction(
      { interaction, display },
      cfg,
      ha,
      schema,
    );
    hud.slots.set(1, {
      slot: 1,
      type: "interactive",
      binding,
      data: interactionDisplay({ ha, getConfig: () => cfg }, binding),
    });
    return { slot: 1, widget_id: binding._id, request_id: "gesture-123" };
  }
  return {
    cfg,
    ha,
    schema,
    calls,
    confirmations,
    hud,
    voice,
    gateway,
    gestures,
    create,
  };
}

test("creating controls never actuates; live state is independent of blank display", () => {
  const f = fixture();
  f.create(
    { kind: "slider", entity_id: "light.desk", field: "brightness_pct" },
    { blank: true },
  );
  const w = f.hud.slots.get(1);
  assert.equal(w.data.value, "");
  assert.equal(w.data.title, "");
  assert(Math.abs(w.data.control_value - 50.2) < 0.1);
  assert.equal(f.calls.length, 0);
  f.ha.states.get("light.desk").state = "off";
  assert.equal(
    interactionDisplay({ ha: f.ha, getConfig: () => f.cfg }, w.binding)
      .control_value,
    0,
  );
});
test("presets resolve real device options and color labels; custom actions stay typed", () => {
  const f = fixture();
  f.create({
    kind: "dropdown",
    entity_id: "select.mode",
    preset: "entity_options",
  });
  let w = f.hud.slots.get(1);
  assert.equal(w.data.control_index, 1);
  assert.equal(w.data.value, "Night");
  f.create({ kind: "dropdown", entity_id: "light.desk", preset: "colors" });
  w = f.hud.slots.get(1);
  assert.equal(w.data.value, "Blue");
  assert.equal(w.binding.interaction.options.length, 5);
  assert.throws(
    () =>
      f.create({ kind: "dropdown", entity_id: "fan.room", preset: "colors" }),
    /light/,
  );
  assert.throws(
    () =>
      f.create({
        kind: "button",
        command: { entity_id: "light.hidden", service: "toggle" },
      }),
    /controllable/,
  );
  assert.throws(
    () =>
      f.create({
        kind: "button",
        command: { entity_id: "light.desk", service: "unlock" },
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      f.create({
        kind: "slider",
        entity_id: "light.desk",
        field: "brightness_pct",
        step: 0.5,
      }),
    /whole-number/,
  );
});
test("gestures bypass models, deduplicate concurrent/retried toggles, and reject stale or revoked targets", async () => {
  const f = fixture(),
    gesture = f.create({
      kind: "button",
      mode: "toggle",
      entity_id: "light.desk",
    });
  const results = await Promise.all([
    f.gestures.act(gesture),
    f.gestures.act(gesture),
  ]);
  assert(results.every((r) => r.success));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "ha.entity.command");
  assert.deepEqual(f.calls[0][1], {
    entity_id: "light.desk",
    service: "toggle",
  });
  await assert.rejects(f.gestures.act({ ...gesture, value: 9 }), /reused/);
  await assert.rejects(
    f.gestures.act({
      ...gesture,
      request_id: "gesture-456",
      widget_id: "stale",
    }),
    /changed/,
  );
  f.cfg.entities.controlled = [];
  await assert.rejects(
    f.gestures.act({ ...gesture, request_id: "gesture-789" }),
    /no longer/,
  );
});
test("slider and dropdown values are bounded and only the final chosen typed action is sent", async () => {
  const f = fixture(),
    gesture = f.create({
      kind: "slider",
      entity_id: "number.level",
      field: "value",
    });
  await assert.rejects(f.gestures.act({ ...gesture, value: 5 }), /range/);
  await assert.rejects(
    f.gestures.act({ ...gesture, request_id: "gesture-234", value: 1.2 }),
    /step/,
  );
  assert(
    (await f.gestures.act({ ...gesture, request_id: "gesture-345", value: 2 }))
      .success,
  );
  assert.equal(f.calls[0][1].value, 2);
  const dropdown = f.create({
    kind: "dropdown",
    entity_id: "select.mode",
    preset: "entity_options",
  });
  await assert.rejects(
    f.gestures.act({ ...dropdown, request_id: "gesture-456", index: 99 }),
    /option/,
  );
  await f.gestures.act({ ...dropdown, request_id: "gesture-567", index: 0 });
  assert.equal(f.calls[1][1].option, "Day");
});
test("configured guards still require confirmation and preserve the exact command parameters", async () => {
  const f = fixture();
  f.cfg.entities.guards["light.desk"] = "protected";
  const gesture = f.create({
    kind: "button",
    command: {
      entity_id: "light.desk",
      service: "turn_on",
      rgb_color: [1, 2, 3],
      brightness_pct: 75,
    },
  });
  const result = await f.gestures.act(gesture);
  assert.equal(result.requires_confirmation, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.confirmations[0].source, "glasses");
  assert.equal(f.confirmations[0].command.brightness_pct, 75);
  assert.deepEqual(f.confirmations[0].command.rgb_color, [1, 2, 3]);
  f.voice.pendingConfirmation = { id: "other" };
  await assert.rejects(
    f.gestures.act({ ...gesture, request_id: "gesture-456" }),
    /pending confirmation/,
  );
});

test("zero brightness turns off; custom display text does not replace the control live value", async () => {
  const f = fixture(),
    gesture = f.create(
      { kind: "slider", entity_id: "light.desk", field: "brightness_pct" },
      { value: "My light" },
    );
  const w = f.hud.slots.get(1);
  assert.equal(w.binding.interaction.min, 0);
  assert.equal(w.data.value, "My light");
  assert(w.data.control_value > 50);
  await f.gestures.act({ ...gesture, value: 0 });
  assert.deepEqual(f.calls[0][1], {
    entity_id: "light.desk",
    service: "turn_off",
  });
  f.ha.states.get("light.desk").state = "unavailable";
  assert.equal(
    interactionDisplay({ ha: f.ha, getConfig: () => f.cfg }, w.binding)
      .control_value,
    undefined,
  );
});
