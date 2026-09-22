import { ENTITY } from "./config.js";

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
export function selected(config, entityId, control = false) {
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
export function liveOwner(options = {}) {
  return (
    (!options.source || ["chat", "device"].includes(options.source)) &&
    (!options.triggerType ||
      ["user_text", "user_voice"].includes(options.triggerType))
  );
}
