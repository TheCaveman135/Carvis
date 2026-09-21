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
const CRITICAL = new Set([
  "lock",
  "cover",
  "alarm_control_panel",
  "siren",
  "valve",
  "water_heater",
  "climate",
  "humidifier",
]);
const INDIRECT = new Set([
  "scene",
  "script",
  "automation",
  "button",
  "input_button",
  "remote",
]);
const RISK_LABEL =
  /(?:^|[_.\s-])(heater|heating|temperature|nozzle|extruder|furnace|hvac|thermostat|air.?con|humidifier|dehumidifier|purifier|cpap|oxygen|medical|smoke|carbon.?monoxide|co_alarm|leak|flood|water|gas|valve|siren|alarm|lock|door|garage|stove|oven|kettle|iron|fireplace|electric.?blanket)(?:$|[_.\s-])/i;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const SAFE_ATTRIBUTES = new Set([
  "friendly_name",
  "device_class",
  "unit_of_measurement",
  "brightness",
  "rgb_color",
  "color_temp_kelvin",
  "supported_color_modes",
  "min_color_temp_kelvin",
  "max_color_temp_kelvin",
  "effect",
  "effect_list",
  "percentage",
  "volume_level",
  "source",
  "source_list",
  "media_title",
  "media_artist",
  "media_album_name",
  "options",
  "min",
  "max",
  "step",
  "temperature",
  "current_temperature",
  "min_temp",
  "max_temp",
  "humidity",
  "min_humidity",
  "max_humidity",
  "current_position",
]);

function entityList(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\s,]+/)
        .filter(Boolean);
  if (list.some((id) => typeof id !== "string" || !ENTITY.test(id)))
    throw Error("Use Home Assistant entity IDs, such as light.living_room.");
  return [...new Set(list)];
}
export function validateConfig(config = {}) {
  const baseUrl = String(config.baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Error("Enter the Home Assistant URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw Error(
      "Use an HTTP or HTTPS Home Assistant URL without credentials or query parameters.",
    );
  const token = String(config.token || "").trim();
  if (!token || /[\r\n]/.test(token))
    throw Error("Enter a Home Assistant long-lived access token.");
  const controlled = entityList(config.controlled),
    observed = [...new Set([...entityList(config.observed), ...controlled])];
  let guards = config.guards || {};
  if (typeof guards === "string") {
    try {
      guards = JSON.parse(guards || "{}");
    } catch {
      throw Error(
        "Guards must be a JSON object of entity IDs and standard or protected.",
      );
    }
  }
  if (
    !guards ||
    typeof guards !== "object" ||
    Array.isArray(guards) ||
    Object.entries(guards).some(
      ([id, level]) =>
        !controlled.includes(id) || !["standard", "protected"].includes(level),
    )
  )
    throw Error(
      "Guards may configure controlled entities as standard or protected.",
    );
  return {
    baseUrl,
    token,
    observed,
    controlled,
    guards: { ...guards },
    dryRun: config.dryRun !== false,
  };
}
export async function haRequest(ctx, path, body) {
  const config = validateConfig(ctx.config);
  const response = await ctx.fetch(`${config.baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      `Home Assistant request failed (${response.status}).${response.status === 401 ? " Check the access token." : ""}`,
    );
  return response.json();
}
export function needsLiveOwner(config, entityId, state = {}) {
  if (config.guards?.[entityId] === "standard") return false;
  const domain = entityId.split(".")[0];
  let label = `${entityId} ${state.attributes?.friendly_name || ""} ${state.attributes?.device_class || ""}`;
  if (domain === "light")
    label = label.replace(
      /\b(?:stove|oven|garage|door)\b|(?:^|_)(?:stove|oven|garage|door)(?=_|$)/gi,
      " ",
    );
  return (
    config.guards?.[entityId] === "protected" ||
    CRITICAL.has(domain) ||
    INDIRECT.has(domain) ||
    RISK_LABEL.test(label)
  );
}
export function needsConfirmation(config, entityId, state, service) {
  return (
    needsLiveOwner(config, entityId, state) &&
    (config.guards?.[entityId] === "protected" ||
      !(entityId.startsWith("lock.") && service === "lock"))
  );
}
function selected(config, entityId, control = false) {
  if (
    !ENTITY.test(entityId || "") ||
    !(control ? config.controlled : config.observed).includes(entityId)
  )
    throw Error(
      control
        ? "This entity is not selected for control."
        : "This entity is not selected for observation.",
    );
}
export function visibleState(state, config) {
  const visible = new Set(config.observed);
  const scrub = (value) =>
    typeof value === "string"
      ? value.replace(/\b[a-z_]+\.[a-z0-9_]+\b/g, (id) =>
          visible.has(id) ? id : "[unavailable]",
        )
      : Array.isArray(value)
        ? value.map(scrub)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, scrub(v)]),
            )
          : value;
  return {
    entity_id: state.entity_id,
    state: state.state,
    attributes: scrub(
      Object.fromEntries(
        Object.entries(state.attributes || {}).filter(([key]) =>
          SAFE_ATTRIBUTES.has(key),
        ),
      ),
    ),
  };
}
export async function readState(ctx, entityId, control = false) {
  const cfg = validateConfig(ctx.config);
  selected(cfg, entityId, control);
  const state = await haRequest(
    ctx,
    `/api/states/${encodeURIComponent(entityId)}`,
  );
  if (!state || state.entity_id !== entityId)
    throw Error("Home Assistant returned the wrong entity.");
  return state;
}
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
export function liveOwner(options = {}) {
  return (
    (!options.source || ["chat", "device"].includes(options.source)) &&
    (!options.triggerType ||
      ["user_text", "user_voice"].includes(options.triggerType))
  );
}
async function authorization(ctx, args) {
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
async function command(ctx, args, options = {}) {
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
        "Enable and configure Apple TV AI to control this device. No direct remote fallback is allowed.",
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
export default {
  id: "home-assistant",
  name: "Home Assistant",
  version: "1.0.0",
  icon: "home",
  description:
    "Connect selected home devices with explicit control permissions and per-device guards.",
  permissions: [
    "Read only selected entity states",
    "Control only selected entities",
    "Connect to your configured Home Assistant server",
  ],
  fields: [
    {
      key: "baseUrl",
      label: "Home Assistant URL",
      type: "url",
      required: true,
      description: "Your own reachable Home Assistant address.",
    },
    {
      key: "token",
      label: "Long-lived access token",
      type: "password",
      required: true,
    },
    {
      key: "observed",
      label: "Entities Carvis may see",
      type: "entities",
      description:
        "Entity IDs selected for observation. Unselected entities are never sent to the model.",
    },
    {
      key: "controlled",
      label: "Entities Carvis may control",
      type: "entities",
      description:
        "Control is opt-in per entity; these entities are also visible.",
    },
    {
      key: "guards",
      label: "Guard overrides",
      type: "textarea",
      description:
        'JSON object: {"light.example":"standard","lock.example":"protected"}. Omitted devices use inferred guards. Standard explicitly permits normal control; protected requires confirmation.',
    },
    {
      key: "dryRun",
      label: "Dry run",
      type: "boolean",
      description:
        "Enabled by default. Validate commands without sending them to devices.",
    },
  ],
  validateConfig,
  async test(ctx) {
    await haRequest(ctx, "/api/");
    return { success: true, message: "Connected to Home Assistant." };
  },
  async tools(ctx) {
    return [
      {
        name: "ha_list_entities",
        readOnly: true,
        description:
          "List only Home Assistant entities the owner selected. Omitted devices are unavailable to you.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          const cfg = validateConfig(ctx.config);
          if (!cfg.observed.length) return { entities: [] };
          const all = await haRequest(ctx, "/api/states");
          return {
            entities: all
              .filter((s) => cfg.observed.includes(s.entity_id))
              .map((s) => visibleState(s, cfg)),
          };
        },
      },
      {
        name: "ha_get_state",
        readOnly: true,
        description: "Read a fresh state for a selected Home Assistant entity.",
        parameters: {
          type: "object",
          properties: { entity_id: { type: "string" } },
          required: ["entity_id"],
          additionalProperties: false,
        },
        async execute({ entity_id }) {
          return visibleState(
            await readState(ctx, entity_id),
            validateConfig(ctx.config),
          );
        },
      },
      {
        name: "ha_command",
        description:
          "Control a selected Home Assistant entity. Use short service names and exact user-requested values. Protected devices require owner confirmation. Apple TV commands are routed exclusively through Apple TV AI.",
        parameters: commandSchema,
        execute: (args, opts) => command(ctx, args, opts),
        async confirmation(args) {
          const { cfg, state, summary } = await authorization(ctx, args);
          return !cfg.dryRun &&
            needsConfirmation(cfg, args.entity_id, state, args.service)
            ? summary
            : null;
        },
      },
    ];
  },
  sanitize(value, ctx) {
    const selected = new Set(
      ctx.enabled === false
        ? []
        : [
            ...(Array.isArray(ctx.config?.observed) ? ctx.config.observed : []),
            ...(Array.isArray(ctx.config?.controlled)
              ? ctx.config.controlled
              : []),
          ],
    );
    const scrub = (v) =>
      typeof v === "string"
        ? v.replace(
            /\b(?:light|switch|fan|input_boolean|media_player|remote|scene|script|automation|button|input_button|number|input_number|select|input_select|lock|cover|alarm_control_panel|siren|climate|humidifier|water_heater|valve|vacuum|sensor|binary_sensor|camera)\.[a-z0-9_]+\b/g,
            (id) => (selected.has(id) ? id : "[unavailable]"),
          )
        : Array.isArray(v)
          ? v.map(scrub)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [k, scrub(x)]),
              )
            : v;
    return scrub(value);
  },
  async context(ctx) {
    const cfg = validateConfig(ctx.config);
    return `Home Assistant is enabled. Only selected devices are visible and controllable. Read current state before reporting it. Never infer permissions from conversation. ${cfg.dryRun ? "Dry run is enabled: commands cannot actuate devices." : ""}`;
  },
  async route({ method, path }, ctx) {
    if (method === "GET" && path === "/entities") {
      const states = await haRequest(ctx, "/api/states");
      let areas = {}, areaWarning;
      try {
        areas = await haRequest(ctx, "/api/template", {template: "{% set ns = namespace(items={}) %}{% for s in states %}{% set id = area_id(s.entity_id) %}{% if id %}{% set ns.items = dict(ns.items, **{s.entity_id: {'id': id, 'name': area_name(id)}}) %}{% endif %}{% endfor %}{{ ns.items | to_json }}"});
        if (!areas || typeof areas !== 'object' || Array.isArray(areas)) throw Error('Invalid room metadata');
      } catch { areaWarning = "Room information could not be loaded. Entities are still available under Unassigned."; }
      return {
        areaWarning,
        entities: states.map((s) => ({
          entity_id: s.entity_id,
          name: s.attributes?.friendly_name || s.entity_id,
          defaultGuard: needsLiveOwner({}, s.entity_id, s) ? "critical" : "standard",
          state: s.state,
          domain: s.entity_id.split(".")[0],
          unit: s.attributes?.unit_of_measurement || "",
          area_id: areas[s.entity_id]?.id || "",
          area_name: areas[s.entity_id]?.name || "",
        })),
      };
    }
    return null;
  },
};
