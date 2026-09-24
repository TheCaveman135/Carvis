import { validateConfig } from "./config.js";
import { selected } from "./permissions.js";
import { haRequest } from "./client.js";

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

export function createStateView(config) {
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
  return (state) => ({
    entity_id: state.entity_id,
    state: scrub(state.state),
    attributes: scrub(
      Object.fromEntries(
        Object.entries(state.attributes || {}).filter(([key]) =>
          SAFE_ATTRIBUTES.has(key),
        ),
      ),
    ),
  });
}

export function visibleState(state, config) {
  return createStateView(config)(state);
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
