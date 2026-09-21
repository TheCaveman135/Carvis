import { randomUUID } from "node:crypto";
import {
  requiresLiveOwner,
  requiresOwnerConfirmation,
  SERVICES_BY_DOMAIN,
} from "./guards.js";
import { validate } from "./tools/gateway.js";
const FIELDS = {
  brightness_pct: { service: "turn_on", domain: "light", min: 0, max: 100 },
  percentage: { service: "set_percentage", domain: "fan", min: 0, max: 100 },
  volume_percent: {
    service: "volume_set",
    domain: "media_player",
    min: 0,
    max: 100,
  },
  value: { service: "set_value", domain: "number" },
};
export const COLOR_OPTIONS = [
  ["Red", [255, 0, 0]],
  ["Green", [0, 255, 0]],
  ["Blue", [0, 0, 255]],
  ["Warm white", [255, 190, 120]],
  ["White", [255, 255, 255]],
];
// Zero brightness is an explicit off command; HA brightness_pct accepts 1–100.
function sliderCommand(control, value) {
  return control.field === "brightness_pct" && value === 0
    ? { entity_id: control.entity_id, service: "turn_off" }
    : {
        entity_id: control.entity_id,
        service: FIELDS[control.field].service,
        [control.field]: value,
      };
}
export function configureInteraction(
  { display = {}, interaction },
  cfg,
  ha,
  commandSchema,
) {
  const c = structuredClone(interaction || {}),
    visible = new Set([
      ...(cfg.entities.observed || []),
      ...(cfg.entities.controlled || []),
    ]);
  const check = (command) => {
    if (!cfg.entities.controlled.includes(command?.entity_id))
      throw Error("Choose a controllable entity.");
    const v = validate(command, commandSchema);
    if (!v.ok) throw Error(v.error);
    if (
      !SERVICES_BY_DOMAIN[command.entity_id.split(".")[0]]?.includes(
        command.service,
      )
    )
      throw Error("Command does not match this entity.");
  };
  if (!["button", "slider", "dropdown"].includes(c.kind))
    throw Error("Choose button, slider or dropdown.");
  if (c.kind === "button") {
    if (c.mode === "toggle") {
      if (
        !["light", "switch", "fan", "input_boolean"].includes(
          c.entity_id?.split(".")[0],
        )
      )
        throw Error("This entity does not support a toggle widget.");
      check({ entity_id: c.entity_id, service: "toggle" });
    } else {
      check(c.command);
      c.mode = "action";
    }
  }
  if (c.kind === "slider") {
    const f = FIELDS[c.field];
    if (
      !f ||
      !(c.field === "value" ? ["number", "input_number"] : [f.domain]).includes(
        c.entity_id?.split(".")[0],
      )
    )
      throw Error("Slider field does not match this entity.");
    const attrs = ha.states.get(c.entity_id)?.attributes || {};
    const low = f.min ?? Number(attrs.min),
      high = f.max ?? Number(attrs.max);
    c.min = c.min ?? low;
    c.max = c.max ?? high;
    c.step = c.step ?? (c.field === "value" ? Number(attrs.step) || 1 : 5);
    if (
      ![c.min, c.max, c.step, low, high].every(Number.isFinite) ||
      c.min < low ||
      c.max > high ||
      c.max <= c.min ||
      c.step <= 0 ||
      c.step > c.max - c.min
    )
      throw Error("Slider bounds must fit the device range.");
    if (c.field !== "value" && ![c.min, c.max, c.step].every(Number.isInteger))
      throw Error("Percentage sliders need whole-number steps.");
    check(sliderCommand(c, c.min));
    check(sliderCommand(c, c.max));
  }
  if (c.kind === "dropdown") {
    if (c.preset === "colors" && c.entity_id?.split(".")[0] !== "light")
      throw Error("Colors require a light.");
    if (
      c.preset === "entity_options" &&
      !["select", "input_select"].includes(c.entity_id?.split(".")[0])
    )
      throw Error("Entity options require a select.");
    if (c.preset === "colors")
      c.options = COLOR_OPTIONS.map(([label, rgb_color]) => ({
        label,
        command: { entity_id: c.entity_id, service: "turn_on", rgb_color },
      }));
    if (c.preset === "entity_options")
      c.options = (ha.states.get(c.entity_id)?.attributes?.options || []).map(
        (option) => ({
          label: option,
          command: { entity_id: c.entity_id, service: "select_option", option },
        }),
      );
    if (
      !Array.isArray(c.options) ||
      c.options.length < 1 ||
      c.options.length > 20
    )
      throw Error("Dropdown needs 1–20 options.");
    for (const option of c.options) {
      if (
        typeof option.label !== "string" ||
        !option.label.trim() ||
        option.label.length > 40
      )
        throw Error("Use short dropdown labels.");
      check(option.command);
    }
  }
  const d = { ...display };
  d.entity_id = d.entity_id || c.entity_id || c.command?.entity_id;
  if (d.entity_id && !visible.has(d.entity_id))
    throw Error("Display entity is unavailable.");
  return { _id: randomUUID(), display: d, interaction: c };
}
export function interactionDisplay({ ha, getConfig }, binding) {
  const d = binding.display || {},
    c = binding.interaction,
    selected = new Set([
      ...(getConfig().entities.observed || []),
      ...(getConfig().entities.controlled || []),
    ]);
  if (d.entity_id && !selected.has(d.entity_id))
    return { title: "Widget", value: "unavailable" };
  if (c.entity_id && !selected.has(c.entity_id))
    return { title: "Widget", value: "unavailable" };
  const s = ha.states.get(d.entity_id),
    title = d.title ?? (d.entity_id ? ha.friendlyName(d.entity_id) : "");
  let control_value, control_index;
  let value = d.value ?? s?.state ?? "";
  const target = ha.states.get(c.entity_id);
  if (c.kind === "slider" && target) {
    const s = target;
    const a = s.attributes || {};
    const n =
      c.field === "brightness_pct"
        ? s.state === "off"
          ? 0
          : (Number(a.brightness) * 100) / 255
        : c.field === "percentage"
          ? Number(a.percentage)
          : c.field === "volume_percent"
            ? Number(a.volume_level) * 100
            : Number(s.state);
    control_value =
      !["unknown", "unavailable"].includes(s.state) && Number.isFinite(n)
        ? n
        : undefined;
    if (d.value === undefined && d.entity_id === c.entity_id)
      value =
        control_value !== undefined
          ? `${Math.round(n * 100) / 100}${c.field === "value" ? "" : "%"}`
          : "unavailable";
  }
  if (
    c.kind === "dropdown" &&
    target &&
    !["unknown", "unavailable"].includes(target.state)
  ) {
    const s = target;
    control_index = c.options.findIndex((o) => {
      const cmd = o.command;
      if (cmd.entity_id !== c.entity_id) return false;
      if (cmd.option !== undefined) return cmd.option === s.state;
      if (cmd.rgb_color)
        return cmd.rgb_color.every(
          (v, i) => Math.abs(v - (s.attributes?.rgb_color?.[i] ?? -999)) < 5,
        );
      return false;
    });
    if (
      control_index >= 0 &&
      d.value === undefined &&
      d.entity_id === c.entity_id
    )
      value = c.options[control_index].label;
  }
  return {
    title: d.blank ? "" : title,
    value: d.blank ? "" : String(value),
    control_value,
    control_index,
  };
}
export class HudInteractions {
  constructor({ hud, ha, getConfig, gateway, voice }) {
    Object.assign(this, { hud, ha, getConfig, gateway, voice });
    this.requests = new Map();
    this.busy = false;
  }
  async act({ slot, widget_id, request_id, value, index }) {
    if (typeof request_id !== "string" || !/^[\w-]{8,100}$/.test(request_id))
      throw Error("Invalid gesture request.");
    const signature = JSON.stringify({ slot, widget_id, value, index });
    const prior = this.requests.get(request_id);
    if (prior) {
      if (prior.signature !== signature) throw Error("Gesture ID was reused.");
      return prior.promise;
    }
    if (this.busy) throw Error("Another widget action is still finishing.");
    this.busy = true;
    const promise = this.execute({ slot, widget_id, value, index }).finally(
      () => {
        this.busy = false;
      },
    );
    this.requests.set(request_id, { signature, promise });
    while (this.requests.size > 200)
      this.requests.delete(this.requests.keys().next().value);
    return promise;
  }
  async execute({ slot, widget_id, value, index }) {
    if (
      !Number.isInteger(slot) ||
      slot < 1 ||
      slot > 4 ||
      typeof widget_id !== "string" ||
      !widget_id
    )
      throw Error("Invalid widget.");
    const w = this.hud.slots.get(slot);
    if (
      !w ||
      w.type !== "interactive" ||
      w.binding?._id !== widget_id ||
      (w.expires_at && Date.now() > w.expires_at)
    )
      throw Error("Widget changed or expired. Select it again.");
    const c = w.binding.interaction;
    let command;
    if (c.kind === "button")
      command =
        c.mode === "toggle"
          ? { entity_id: c.entity_id, service: "toggle" }
          : c.command;
    if (c.kind === "slider") {
      if (!Number.isFinite(value) || value < c.min || value > c.max)
        throw Error("Slider value is outside its range.");
      const steps = (value - c.min) / c.step;
      if (Math.abs(steps - Math.round(steps)) > 0.00001 && value !== c.max)
        throw Error("Slider value is not on a step.");
      command = sliderCommand(c, value);
    }
    if (c.kind === "dropdown") {
      if (!Number.isInteger(index) || !c.options[index])
        throw Error("Choose a dropdown option.");
      command = c.options[index].command;
    }
    const cfg = this.getConfig();
    if (!command || !cfg.entities.controlled.includes(command.entity_id))
      throw Error("This control is no longer available.");
    const state = this.ha.states.get(command.entity_id);
    if (this.voice.pendingConfirmation)
      throw Error("Answer the pending confirmation first.");
    if (
      requiresOwnerConfirmation(command.entity_id, state, command.service, cfg)
    ) {
      const { confirmation } = this.voice.stageDirectConfirmation({
        prompt: `${this.ha.friendlyName(command.entity_id)}: ${c.kind === "dropdown" ? c.options[index].label : c.kind === "slider" ? `${value}${c.field === "value" ? "" : "%"}` : command.service.replaceAll("_", " ")}?`,
        entityId: command.entity_id,
        service: command.service,
        reason: "Glasses widget gesture",
        source: "glasses",
        command,
      });
      return { success: false, confirmation, requires_confirmation: true };
    }
    const result = await this.gateway.call(
      requiresLiveOwner(command.entity_id, state, cfg)
        ? "ha.secure.command"
        : "ha.entity.command",
      command,
      {
        triggerType: "user_text",
        reason: "Glasses widget gesture",
        confirmed: false,
      },
    );
    this.hud.refresh();
    return { ...result, hud: this.hud.state() };
  }
}
