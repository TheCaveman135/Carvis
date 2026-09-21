/**
 * Deterministic safety layer. The model proposes; this file disposes.
 *
 * Nothing reaches Home Assistant unless it survives every check here, so a
 * confused or jailbroken model still cannot touch an entity you did not
 * explicitly hand it. The model may now reach security and environmental
 * devices, but the invariants in this file are intentionally not configurable.
 */

export const APPLE_TV_BUTTONS = Object.freeze(['up', 'down', 'left', 'right', 'select', 'menu', 'top_menu']);

const SERVICES_BY_DOMAIN = {
  light: ['turn_on', 'turn_off', 'toggle'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle', 'set_percentage'],
  input_boolean: ['turn_on', 'turn_off', 'toggle'],
  media_player: ['turn_on', 'turn_off', 'media_play', 'media_pause', 'media_stop', 'volume_set', 'media_next_track', 'media_previous_track', 'select_source', 'play_media'],
  scene: ['turn_on'],
  script: ['turn_on'],
  automation: ['turn_on', 'turn_off', 'toggle', 'trigger'],
  button: ['press'],
  input_button: ['press'],
  remote: ['turn_on', 'turn_off', 'send_command'],
  humidifier: ['turn_on', 'turn_off', 'toggle', 'set_humidity'],
  climate: ['turn_on', 'turn_off', 'set_temperature'],
  number: ['set_value'],
  input_number: ['set_value'],
  select: ['select_option'],
  input_select: ['select_option'],
  vacuum: ['start', 'pause', 'stop', 'return_to_base'],
  cover: ['open_cover', 'close_cover', 'stop_cover'],
  lock: ['lock', 'unlock'],
  alarm_control_panel: ['alarm_arm_home', 'alarm_arm_away', 'alarm_disarm'],
  siren: ['turn_on', 'turn_off'],
  valve: ['open_valve', 'close_valve'],
  water_heater: ['turn_on', 'turn_off', 'set_temperature'],
};

export const CONTROLLABLE_DOMAINS = Object.freeze(Object.keys(SERVICES_BY_DOMAIN));

/**
 * The owner's "Critical" tier: these can change physical security or affect
 * air/water/heat. They may only run in a live owner turn, and voice
 * additionally requires either the wake word or an explicit swipe
 * confirmation (`ctx.confirmed`) — continuous-room audio and a triage model
 * are not authentication for an unlock on their own.
 *
 * Capability containers (scene, script, automation, button, remote) are kept
 * out of this physical-hazard list because their own domains are not
 * inherently critical. They are still protected separately below: their
 * downstream effects are opaque, so they require live-owner authentication
 * and cannot run from a background model wake.
 *
 * Exported and frozen — read-only. Three modules used to keep their own copy
 * of this list, and one of them had quietly drifted (missing climate and
 * humidifier, patched around at one call site instead of at the source
 * rather than fixed here). One list, imported everywhere, is how that stays
 * fixed instead of recurring the next time a domain is added.
 */
export const CRITICAL_DOMAINS = Object.freeze(new Set([
  'lock',
  'cover',
  'alarm_control_panel',
  'siren',
  'valve',
  'water_heater',
  'climate',
  'humidifier',
]));

/**
 * These domains are capability containers rather than transparent device
 * controls. A scene or script may actuate a lock, garage door, heater, or a
 * dozen other entities that are not visible in the service call itself, so
 * their apparent `turn_on`/`press` operation is not enough to safety-audit
 * them. They therefore share the live-owner authentication boundary with the
 * explicitly critical domains and can never run from a background model wake.
 */
export const INDIRECT_HA_DOMAINS = Object.freeze(new Set([
  'scene',
  'script',
  'automation',
  'button',
  'input_button',
  'remote',
]));

// Ordinary-looking switches can still be heaters, medical equipment or life
// safety relays. Names are not perfect, but this is a useful non-configurable
// backstop beneath the explicit entity allowlist.
export const WELLBEING_HINT = /(?:^|[_.\s-])(heater|heating|temperature|nozzle|extruder|furnace|hvac|thermostat|air.?con|humidifier|dehumidifier|purifier|cpap|oxygen|medical|smoke|carbon.?monoxide|co_alarm|leak|flood|water|gas|valve|siren|alarm|lock|door|garage|stove|oven|kettle|iron|fireplace|electric.?blanket|speaker.?volume|headphone.?volume)(?:$|[_.\s-])/i;

/**
 * Whether an exact HA entity is protected from background/autonomous use.
 *
 * This is deliberately broader than confirmation. A lock may be safely
 * *locked* by a live owner without making them prove intent twice, but no
 * background model should ever lock or unlock it. Keep those two questions
 * separate: "may an unattended thing touch this?" and "does this particular
 * command need an explicit confirm?"
 */
export function requiresLiveOwner(entityId, state = {}, cfg = {}) {
  const id = String(entityId || '').trim();
  if (cfg.entities?.guards?.[id] === 'standard') return false;
  const domain = id.split('.')[0];
  const label = `${id} ${state?.attributes?.friendly_name || ''} ${state?.attributes?.device_class || ''}`;
  // Location labels on actual lights are not appliance controls. Hazard terms remain guarded.
  const riskLabel = domain === 'light' ? label.replace(/\b(?:stove|oven|garage|door)\b|(?:^|_)(?:stove|oven|garage|door)(?=_|$)/gi, ' ') : label;
  return (
    cfg.entities?.guards?.[id] === 'protected' ||
    CRITICAL_DOMAINS.has(domain) ||
    INDIRECT_HA_DOMAINS.has(domain) ||
    WELLBEING_HINT.test(riskLabel)
  );
}

/**
 * Whether this exact protected command needs a second owner signal.
 *
 * Common-sense exception: locking the deadbolt is protective and reversible;
 * a direct live-owner request may do it immediately. Unlocking it remains a
 * physical-security action, so voice needs wake word OR confirmation and
 * typed controls need confirmation. Other protected entities retain their
 * conservative policy until we have service-specific safety rules for them.
 */
export function requiresOwnerConfirmation(entityId, state = {}, service = '', cfg = {}) {
  if (!requiresLiveOwner(entityId, state, cfg)) return false;
  const domain = String(entityId || '').trim().split('.')[0];
  return cfg.entities?.guards?.[entityId] === 'protected' || !(domain === 'lock' && String(service).trim() === 'lock');
}

/**
 * @param action  the proposed {entity_id, service, reason, brightness_pct?, effect?}
 * @param ctx     {cfg, ha, envelope, cooldown, manualTouch, now, origin?}
 *
 * `origin` is 'automation' (the default) or 'voice'. A spoken command is a
 * statement of intent from the person in the room, so it is allowed past the
 * three guards that exist only to second-guess the *model's* judgement about
 * whether you want something: the occupancy envelope, the anti-flap cooldown,
 * and the manual-override hold. You standing in a dark room asking for the
 * light is not the failure those guards were built to catch.
 *
 * It is not allowed past anything protecting the house. The control allowlist,
 * the domain allowlist and the lock/cover/alarm block apply identically to
 * every origin — the microphone is the least trustworthy input Carvis has.
 *
 * @returns {{ok: true, action: object} | {ok: false, reason: string}}
 */
export function vetAction(action, ctx) {
  const { cfg, ha, cooldown, manualTouch, now } = ctx;
  const spoken = ctx.origin === 'voice';
  const entityId = String(action?.entity_id || '').trim();
  const service = String(action?.service || '').trim();

  if (!entityId || !entityId.includes('.')) return deny(entityId, 'malformed entity_id');
  if (!cfg.entities.controlled.includes(entityId)) {
    return deny(entityId, 'not in the controllable list');
  }

  const domain = entityId.split('.')[0];
  if (!cfg.agent.allowedDomains.includes(domain)) {
    return deny(entityId, `domain "${domain}" is not in allowedDomains`);
  }

  const allowed = SERVICES_BY_DOMAIN[domain];
  if (!allowed || !allowed.includes(service)) {
    return deny(entityId, `service "${service}" not permitted on ${domain}`);
  }

  const state = ha.states.get(entityId);
  if (!state) return deny(entityId, 'entity unknown to Home Assistant');
  const stateless = domain === 'button' || domain === 'input_button';
  if (state.state === 'unavailable' || (state.state === 'unknown' && !stateless)) {
    return deny(entityId, `entity is ${state.state}`);
  }

  const triggerType = ctx.triggerType || (spoken ? 'user_voice' : 'automation');
  const directOwner = triggerType === 'user_text' || triggerType === 'user_voice';
  const needsDirectOwner = requiresLiveOwner(entityId, state, cfg);
  const needsConfirmation = requiresOwnerConfirmation(entityId, state, service, cfg);

  if (needsDirectOwner && !directOwner) {
    return deny(entityId, 'wellbeing guard: this device can only change during a live owner request');
  }
  // Voice has two equivalent authentication paths: an exact wake word OR an
  // accepted confirmation. Typed text cannot contain an authenticated wake
  // word — even if a caller tries to set `wakeWord` in its context — so its
  // only path is an explicit confirmation generated and resolved by Carvis.
  if (needsConfirmation && triggerType === 'user_voice' && ctx.wakeWord !== true && ctx.confirmed !== true) {
    return deny(entityId, 'wellbeing guard: say the Carvis wake word (or confirm on the glasses) for security or environmental controls');
  }
  if (needsConfirmation && triggerType === 'user_text' && ctx.confirmed !== true) {
    return deny(entityId, 'wellbeing guard: confirm this security, environmental, or indirect Home Assistant action first');
  }
  const intentError = sensitiveIntentError(service, action.reason);
  if (CRITICAL_DOMAINS.has(domain) && intentError) return deny(entityId, intentError);
  if (numericTargetMustBeExplicit(service, needsDirectOwner)) {
    const requested = numericTarget(action, service);
    if (requested != null && !reasonContainsNumber(action.reason, requested)) {
      return deny(entityId, `wellbeing guard: the owner did not explicitly request the numeric target ${requested}`);
    }
  }

  // No-ops are the most common model mistake — drop them before they hit HA.
  // (Deliberately not extended to automation here: unlike scene/script, an
  // automation genuinely has an on/off state where "already on" is a real
  // no-op, not a re-triggerable action.)
  // A lit lamp can still need its effect changed. Treat an ordinary repeated
  // `turn_on` as a no-op, but let the separately validated `effect` through.
  if (service === 'turn_on' && state.state === 'on' && !action.effect && !(domain === 'light' && ['brightness_pct','rgb_color','color_temp_kelvin'].some(key => action[key] !== undefined)) && domain !== 'scene' && domain !== 'script') {
    return deny(entityId, 'already on');
  }
  if (service === 'turn_off' && state.state === 'off') return deny(entityId, 'already off');

  // Cooldown and the manual-override hold both exist to stop the agent
  // arguing with a human. When the human *is* the request, they do not apply.
  if (!spoken) {
    const lastAct = cooldown.get(entityId) || 0;
    const cooldownMs = cfg.agent.cooldownSec * 1000;
    if (now - lastAct < cooldownMs) {
      const left = Math.ceil((cooldownMs - (now - lastAct)) / 1000);
      return deny(entityId, `cooldown, ${left}s left`);
    }

    const overrideMs = cfg.agent.respectManualOverrideSec * 1000;
    const touched = manualTouch.get(entityId) || 0;
    if (overrideMs > 0 && now - touched < overrideMs) {
      const left = Math.ceil((overrideMs - (now - touched)) / 60000);
      return deny(entityId, `a human changed this recently, holding off ~${left}m`);
    }
  }

  // The occupancy envelope: re-check the room verdicts the model was shown, so
  // a model that ignores the procedure still cannot act outside it. automation
  // is exempt for the same reason scene/script are: a vacant-room "turn off
  // anything left on" sweep is meant for lights and switches, not for
  // disabling an automation — which can itself be security- or safety-
  // relevant — the moment nobody is in the room to notice.
  // A saved deterministic automation is itself the owner's explicit policy
  // ("at sunset, turn on the porch"). Applying the unattended-origin
  // occupancy recipe to it would silently rewrite that policy and make common
  // schedules fail. It still keeps the allowlist, wellbeing/direct-owner gate,
  // no-op checks, cooldown, and manual-override hold above.
  if (!spoken && triggerType !== 'automation' && cfg.agent.enforceOccupancyEnvelope && ctx.envelope && domain !== 'scene' && domain !== 'script' && domain !== 'automation') {
    const verdict = ctx.envelope.verdictByEntity.get(entityId);
    const room = ctx.envelope.areaByEntity.get(entityId) || 'that room';

    if (service === 'toggle') {
      return deny(entityId, 'toggle is ambiguous — say turn_on or turn_off');
    }
    if (service === 'turn_off' && verdict !== 'VACANT') {
      return deny(entityId, `${room} is ${(verdict || 'unassessed').toLowerCase()}, not vacant`);
    }
    if (service === 'turn_on') {
      if (verdict !== 'OCCUPIED') {
        return deny(entityId, `${room} is ${(verdict || 'unassessed').toLowerCase()}, so nothing should switch on there`);
      }
      if (domain === 'light' && ctx.envelope.dark !== true) {
        return deny(entityId, ctx.envelope.dark === false ? 'it is daylight' : 'cannot tell if it is dark');
      }
    }
  }

  const out = {
    entity_id: entityId,
    service,
    domain,
    reason: String(action.reason || '').slice(0, 300),
    service_data: {},
  };

  if (service === 'send_command') {
    if (entityId !== cfg.appleTv?.remoteEntity || !APPLE_TV_BUTTONS.includes(action.command)) {
      return deny(entityId, 'Only a single approved Apple TV navigation button is permitted');
    }
    out.service_data.command = action.command;
  }

  const lighting = ['brightness_pct', 'rgb_color', 'color_temp_kelvin'].filter(key => action[key] !== undefined);
  if (lighting.length && (domain !== 'light' || service !== 'turn_on')) return deny(entityId, 'Light settings require light.turn_on');
  const modes = state.attributes?.supported_color_modes || [];
  if (action.brightness_pct !== undefined) {
    if (!Number.isFinite(action.brightness_pct) || action.brightness_pct < 1 || action.brightness_pct > 100) return deny(entityId, 'brightness_pct must be between 1 and 100');
    if (modes.length && modes.every(mode => mode === 'onoff')) return deny(entityId, 'This light does not support dimming');
  }
  if (action.rgb_color !== undefined && action.color_temp_kelvin !== undefined) return deny(entityId, 'Choose color or white temperature, not both');
  if (action.rgb_color !== undefined) {
    if (!Array.isArray(action.rgb_color) || action.rgb_color.length !== 3 || !action.rgb_color.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return deny(entityId, 'rgb_color needs three integers between 0 and 255');
    if (!modes.some(mode => ['rgb','rgbw','rgbww','hs','xy'].includes(mode))) return deny(entityId, 'This light does not support color');
    out.service_data.rgb_color = action.rgb_color;
  }
  if (action.color_temp_kelvin !== undefined) {
    const kelvin = action.color_temp_kelvin;
    const min = state.attributes?.min_color_temp_kelvin;
    const max = state.attributes?.max_color_temp_kelvin;
    if (!modes.includes('color_temp')) return deny(entityId, 'This light does not support white temperature');
    if (!Number.isInteger(kelvin) || !Number.isFinite(min) || !Number.isFinite(max) || kelvin < min || kelvin > max) return deny(entityId, `White temperature must be within the reported range ${min}–${max} K`);
    out.service_data.color_temp_kelvin = kelvin;
  }
  const pct = Number(action.brightness_pct);
  if (domain === 'light' && service === 'turn_on' && Number.isFinite(pct) && pct > 0) {
    out.service_data.brightness_pct = Math.max(1, Math.min(100, Math.round(pct)));
  }
  if (action.effect !== undefined) {
    if (domain !== 'light' || service !== 'turn_on') {
      return deny(entityId, 'effect is only valid when turning on a light');
    }
    const effect = String(action.effect || '').trim();
    const effects = Array.isArray(state.attributes?.effect_list) ? state.attributes.effect_list : [];
    if (!effect || !effects.includes(effect)) {
      return deny(entityId, `effect "${effect || '(empty)'}" is not available on this light; use ha.light.list_effects`);
    }
    if (state.attributes?.effect === effect && !lighting.length) return deny(entityId, `already using effect "${effect}"`);
    out.service_data.effect = effect;
  }

  if (service === 'set_percentage') {
    const percentage = bounded(action.percentage, 0, 100);
    if (percentage == null) return deny(entityId, 'percentage must be between 0 and 100');
    out.service_data.percentage = Math.round(percentage);
  }
  if (service === 'volume_set') {
    const percent = bounded(action.volume_percent, 0, 85);
    if (percent == null) return deny(entityId, 'wellbeing guard: volume_percent must be between 0 and 85');
    out.service_data.volume_level = percent / 100;
  }
  if (service === 'select_source') {
    const sources = Array.isArray(state.attributes?.source_list) ? state.attributes.source_list : [];
    if (typeof action.source !== 'string' || !sources.includes(action.source)) {
      return deny(entityId, 'source must exactly match an available source from ha.get_state');
    }
    out.service_data.source = action.source;
  }
  if (service === 'play_media') {
    // Music identifiers only, not arbitrary network URLs or indirect HA content.
    const raw = String(action.media_content_id || '').trim();
    let match = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]{22})$/.exec(raw);
    if (!match) {
      try {
        const url = new URL(raw);
        const path = /^\/(track|album|playlist|artist)\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
        if (url.protocol === 'https:' && url.hostname === 'open.spotify.com' && !url.port && !url.username && !url.password && path) match = path;
      } catch {}
    }
    if (!match) return deny(entityId, 'Use a Spotify track, album, playlist, or artist link/URI; title searches are not supported');
    if (action.media_content_type !== match[1]) return deny(entityId, 'media_content_type must match the Spotify link type');
    out.service_data.media_content_id = `spotify:${match[1]}:${match[2]}`;
    out.service_data.media_content_type = match[1];
  }
  if (service === 'set_humidity') {
    const humidity = bounded(action.humidity, 30, 60);
    if (humidity == null) return deny(entityId, 'wellbeing guard: humidity must be between 30% and 60%');
    out.service_data.humidity = Math.round(humidity);
  }
  if (service === 'set_temperature') {
    const requested = Number(action.temperature);
    if (!Number.isFinite(requested)) return deny(entityId, 'temperature is required');
    const unit = String(state.attributes?.temperature_unit || state.attributes?.unit_of_measurement || '°F');
    const celsius = /c/i.test(unit);
    const [min, max] = domain === 'water_heater' ? (celsius ? [43, 54] : [110, 130]) : celsius ? [16, 30] : [60, 86];
    if (requested < min || requested > max) {
      return deny(entityId, `wellbeing guard: temperature must be between ${min} and ${max}${celsius ? '°C' : '°F'}`);
    }
    out.service_data.temperature = requested;
  }
  if (service === 'set_value') {
    const value = Number(action.value);
    const min = Number(state.attributes?.min);
    const max = Number(state.attributes?.max);
    if (!Number.isFinite(value)) return deny(entityId, 'value is required');
    if ((Number.isFinite(min) && value < min) || (Number.isFinite(max) && value > max)) {
      return deny(entityId, `value must stay within the entity range ${min}–${max}`);
    }
    out.service_data.value = value;
  }
  if (service === 'select_option') {
    const option = String(action.option || '');
    const options = Array.isArray(state.attributes?.options) ? state.attributes.options : [];
    if (!option || !options.includes(option)) return deny(entityId, `option must be one of: ${options.join(', ')}`);
    out.service_data.option = option;
  }

  if (!Object.keys(out.service_data).length) delete out.service_data;

  return { ok: true, action: out };
}

function bounded(value, min, max) {
  const num = Number(value);
  return Number.isFinite(num) && num >= min && num <= max ? num : null;
}

function sensitiveIntentError(service, reason) {
  const text = String(reason || '').toLowerCase();
  const requires = {
    // A resolved one-shot confirmation is explicit intent itself. Do not make
    // it fail just because ASR/model wording used "unlatch" or "open the
    // door" instead of the literal tool service name.
    unlock: /\b(?:unlock|unlatch)\b|\bopen\b(?:\s+\w+){0,3}\s+\b(?:door|deadbolt|lock)\b|\blet\s+(?:me|us|them|someone)\s+in\b/,
    lock: /\b(?:lock|secure)\b/,
    open_cover: /\b(?:open|raise)\b/,
    close_cover: /\b(?:close|lower|shut)\b/,
    alarm_arm_home: /\b(?:arm|secure)\b/,
    alarm_arm_away: /\b(?:arm|secure)\b/,
    alarm_disarm: /\bdisarm\b/,
    open_valve: /\bopen\b/,
    close_valve: /\b(?:close|shut)\b/,
  };
  const pattern = requires[service];
  return pattern && !pattern.test(text)
    ? `wellbeing guard: the owner did not explicitly request ${service}`
    : null;
}

function numericTargetMustBeExplicit(service, needsDirectOwner) {
  return needsDirectOwner || ['set_temperature', 'set_humidity', 'volume_set'].includes(service);
}

function numericTarget(action, service) {
  const field = {
    set_temperature: 'temperature',
    set_humidity: 'humidity',
    volume_set: 'volume_percent',
    set_percentage: 'percentage',
    set_value: 'value',
  }[service];
  if (!field) return null;
  const value = Number(action[field]);
  return Number.isFinite(value) ? value : null;
}

function reasonContainsNumber(reason, target) {
  const numbers = String(reason || '').match(/-?\d+(?:\.\d+)?/g) || [];
  return numbers.some((value) => Math.abs(Number(value) - target) < 0.0001);
}

function deny(entityId, reason) {
  return { ok: false, entity_id: entityId, reason };
}

export { SERVICES_BY_DOMAIN };
