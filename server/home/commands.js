import { validateConfig } from "./config.js";
import { haRequest } from "./client.js";
import { readState, visibleState } from "./state.js";
import { liveOwner, needsLiveOwner, needsConfirmation } from "./permissions.js";

const SERVICES = Object.freeze({
  light: ["turn_on", "turn_off", "toggle"],
  switch: ["turn_on", "turn_off", "toggle"],
  fan: ["turn_on", "turn_off", "toggle", "set_percentage"],
  input_boolean: ["turn_on", "turn_off", "toggle"],
  media_player: [
    "turn_on",
    "turn_off",
    "media_play",
    "media_pause",
    "media_stop",
    "media_next_track",
    "media_previous_track",
    "volume_set",
    "select_source",
    "play_media",
  ],
  remote: ["turn_on", "turn_off", "send_command"],
  scene: ["turn_on"],
  script: ["turn_on"],
  automation: ["turn_on", "turn_off", "toggle", "trigger"],
  button: ["press"],
  input_button: ["press"],
  number: ["set_value"],
  input_number: ["set_value"],
  select: ["select_option"],
  input_select: ["select_option"],
  lock: ["lock", "unlock"],
  cover: ["open_cover", "close_cover", "stop_cover"],
  alarm_control_panel: ["alarm_arm_home", "alarm_arm_away", "alarm_disarm"],
  siren: ["turn_on", "turn_off"],
  climate: ["turn_on", "turn_off", "set_temperature"],
  humidifier: ["turn_on", "turn_off", "toggle", "set_humidity"],
  water_heater: ["turn_on", "turn_off", "set_temperature"],
  valve: ["open_valve", "close_valve"],
  vacuum: ["start", "pause", "stop", "return_to_base"],
});
const NUMBER = { type: "number" };
const properties = {
  entity_id: { type: "string" },
  service: { type: "string" },
  brightness_pct: { ...NUMBER, minimum: 0, maximum: 100 },
  rgb_color: {
    type: "array",
    items: { type: "integer", minimum: 0, maximum: 255 },
    minItems: 3,
    maxItems: 3,
  },
  color_temp_kelvin: { type: "integer" },
  effect: { type: "string" },
  percentage: { ...NUMBER, minimum: 0, maximum: 100 },
  volume_percent: { ...NUMBER, minimum: 0, maximum: 100 },
  source: { type: "string" },
  media_content_id: { type: "string" },
  media_content_type: { type: "string" },
  value: NUMBER,
  option: { type: "string" },
  temperature: NUMBER,
  humidity: { ...NUMBER, minimum: 0, maximum: 100 },
  command: {
    type: "string",
    enum: ["up", "down", "left", "right", "select", "menu", "top_menu"],
  },
};
export const commandSchema = {
  type: "object",
  properties,
  required: ["entity_id", "service"],
  additionalProperties: false,
};
export function commandData(args, state) {
  const domain = args.entity_id.split(".")[0],
    service = args.service,
    attrs = state.attributes || {};
  if (!SERVICES[domain]?.includes(service))
    throw Error("That service is not allowed for this device type.");
  if (
    state.state === "unavailable" ||
    (state.state === "unknown" && !["button", "input_button"].includes(domain))
  )
    throw Error("This device is unavailable.");
  const data = { entity_id: args.entity_id };
  const applied = new Set(["entity_id", "service"]);
  const takeNumber = (key, min, max, to = key) => {
    if (args[key] === undefined) return;
    const v = args[key];
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      v < min ||
      v > max
    )
      throw Error(`${key} must fit the device range ${min}–${max}.`);
    data[to] = v;
    applied.add(key);
  };
  const takeChoice = (key, options) => {
    if (args[key] === undefined) return;
    if (
      typeof args[key] !== "string" ||
      !Array.isArray(options) ||
      !options.includes(args[key])
    )
      throw Error(`Choose one of the device's current ${key} options.`);
    data[key] = args[key];
    applied.add(key);
  };
  if (domain === "light" && service === "turn_on") {
    takeNumber("brightness_pct", 0, 100);
    takeChoice("effect", attrs.effect_list);
    if (args.rgb_color !== undefined) {
      if (
        !attrs.supported_color_modes?.some((m) =>
          ["rgb", "rgbw", "rgbww", "hs", "xy"].includes(m),
        ) ||
        !Array.isArray(args.rgb_color) ||
        args.rgb_color.length !== 3 ||
        args.rgb_color.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
      )
        throw Error("This light requires a supported RGB color.");
      data.rgb_color = args.rgb_color;
      applied.add("rgb_color");
    }
    if (args.color_temp_kelvin !== undefined) {
      if (!attrs.supported_color_modes?.includes("color_temp"))
        throw Error("This light does not support white temperature.");
      takeNumber(
        "color_temp_kelvin",
        attrs.min_color_temp_kelvin,
        attrs.max_color_temp_kelvin,
      );
    }
  }
  if (domain === "fan" && service === "set_percentage")
    takeNumber("percentage", 0, 100);
  if (domain === "media_player" && service === "volume_set") {
    takeNumber("volume_percent", 0, 100, "volume_level");
    if (data.volume_level !== undefined) data.volume_level /= 100;
  }
  if (domain === "media_player" && service === "select_source")
    takeChoice("source", attrs.source_list);
  if (domain === "media_player" && service === "play_media")
    for (const key of ["media_content_id", "media_content_type"]) {
      if (
        typeof args[key] !== "string" ||
        !args[key].trim() ||
        args[key].length > 2000
      )
        throw Error("Provide a media content ID and type.");
      data[key] = args[key];
      applied.add(key);
    }
  if (["number", "input_number"].includes(domain) && service === "set_value")
    takeNumber("value", attrs.min, attrs.max);
  if (
    ["select", "input_select"].includes(domain) &&
    service === "select_option"
  )
    takeChoice("option", attrs.options);
  if (
    ["climate", "water_heater"].includes(domain) &&
    service === "set_temperature"
  )
    takeNumber("temperature", attrs.min_temp, attrs.max_temp);
  if (domain === "humidifier" && service === "set_humidity")
    takeNumber("humidity", attrs.min_humidity ?? 0, attrs.max_humidity ?? 100);
  if (domain === "remote" && service === "send_command") {
    if (!properties.command.enum.includes(args.command))
      throw Error("Choose a supported remote navigation button.");
    data.command = args.command;
    applied.add("command");
  }
  const required = {
    set_percentage: "percentage",
    volume_set: "volume_percent",
    select_source: "source",
    set_value: "value",
    select_option: "option",
    set_temperature: "temperature",
    set_humidity: "humidity",
  }[service];
  if (required && !applied.has(required)) throw Error(`Provide ${required}.`);
  if (Object.keys(args).some((key) => !applied.has(key)))
    throw Error(
      "This command includes parameters that do not apply to its service.",
    );
  return data;
}
export async function authorization(ctx, args) {
  const cfg = validateConfig(ctx.config),
    state = await readState(ctx, args.entity_id, true);
  const data = commandData(args, state);
  return {
    cfg,
    state,
    data,
    summary: `${args.service.replaceAll("_", " ")}: ${state.attributes?.friendly_name || args.entity_id}${Object.keys(data).length > 1 ? ` (${JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k]) => k !== "entity_id")))})` : ""}`,
  };
}
export async function command(ctx, args, options = {}) {
  const { cfg, state, data, summary } = await authorization(ctx, args);
  if (needsLiveOwner(cfg, args.entity_id, state) && !liveOwner(options))
    throw Error("This device requires a live owner request.");
  if (
    needsConfirmation(cfg, args.entity_id, state, args.service) &&
    !options.confirmed &&
    !cfg.dryRun
  )
    return { requiresConfirmation: true, summary };
  let tvConfig;
  try {
    tvConfig = ctx.registry?.getConfig("apple-tv");
  } catch {}
  const tvTarget =
    [tvConfig?.remoteEntity, tvConfig?.mediaPlayerEntity].includes(
      args.entity_id,
    ) ||
    /(?:^|[_.\s])apple[_.\s]?tv(?:$|[_.\s])/i.test(
      `${args.entity_id} ${state.attributes?.friendly_name || ""}`,
    );
  if (tvTarget) {
    if (!tvConfig)
      throw Error(
        "Enable and configure TV AI Controller to control this device. No direct remote fallback is allowed.",
      );
    return ctx.registry.invoke("tv_command", args, options);
  }
  if (cfg.dryRun)
    return {
      success: true,
      dryRun: true,
      message: "Dry run: no device command was sent.",
      command: data,
      service: args.service,
    };
  const domain = args.entity_id.split(".")[0];
  await haRequest(ctx, `/api/services/${domain}/${args.service}`, data);
  let fresh;
  try {
    fresh = await readState(ctx, args.entity_id);
  } catch {
    return {
      success: true,
      accepted: true,
      verified: false,
      message:
        "Home Assistant accepted the command, but its resulting state could not be read. Check state before retrying.",
    };
  }
  const expected = {
    turn_on: "on",
    turn_off: "off",
    lock: "locked",
    unlock: "unlocked",
    open_cover: "open",
    close_cover: "closed",
  }[args.service];
  return {
    success: true,
    accepted: true,
    verified: expected ? fresh.state === expected : false,
    message:
      expected && fresh.state !== expected
        ? "Home Assistant accepted the command; the requested state is not yet confirmed."
        : "Home Assistant accepted the command.",
    state: visibleState(fresh, cfg),
  };
}
