import { validateConfig } from "./home/config.js";
import { haRequest } from "./home/client.js";
import { needsLiveOwner, needsConfirmation } from "./home/permissions.js";
import { readState, visibleState, createStateView } from "./home/state.js";
import { commandSchema, authorization, command } from "./home/commands.js";

// Preserve the public API used by integrations and existing installations.
export { validateConfig } from "./home/config.js";
export { haRequest } from "./home/client.js";
export {
  needsLiveOwner,
  needsConfirmation,
  liveOwner,
} from "./home/permissions.js";
export { readState, visibleState } from "./home/state.js";
export { commandSchema, commandData } from "./home/commands.js";

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
      key: "homeName",
      label: "Home name",
      type: "text",
      description: "The name Carvis uses for your home.",
    },
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
          const selected = new Set(cfg.observed);
          const view = createStateView(cfg);
          return {
            entities: all.filter((s) => selected.has(s.entity_id)).map(view),
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
          "Control a selected Home Assistant entity. Use short service names and exact user-requested values. Protected devices require owner confirmation. Apple TV commands are routed exclusively through TV AI Controller.",
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
            /\b(?:light|switch|fan|input_boolean|media_player|remote|scene|script|automation|button|input_button|number|input_number|select|input_select|lock|cover|alarm_control_panel|siren|climate|humidifier|water_heater|valve|vacuum|sensor|binary_sensor|camera|update|person|device_tracker|weather|calendar|sun|event|text|input_text|datetime|input_datetime|date|time|todo|image|image_processing|lawn_mower)\.[a-z0-9_]+\b/g,
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
      let areas = {},
        areaWarning;
      try {
        areas = await haRequest(ctx, "/api/template", {
          template:
            "{% set ns = namespace(items={}) %}{% for s in states %}{% set id = area_id(s.entity_id) %}{% if id %}{% set ns.items = dict(ns.items, **{s.entity_id: {'id': id, 'name': area_name(id)}}) %}{% endif %}{% endfor %}{{ ns.items | to_json }}",
        });
        if (!areas || typeof areas !== "object" || Array.isArray(areas))
          throw Error("Invalid room metadata");
      } catch {
        areaWarning =
          "Room information could not be loaded. Entities are still available under Unassigned.";
      }
      return {
        areaWarning,
        entities: states.map((s) => ({
          entity_id: s.entity_id,
          name: s.attributes?.friendly_name || s.entity_id,
          defaultGuard: needsLiveOwner({}, s.entity_id, s)
            ? "critical"
            : "standard",
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
