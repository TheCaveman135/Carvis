/**
 * Normalized world state.
 *
 * Home Assistant knows about 888 entities. Almost none of that is worth a
 * model's attention, and pasting it into a prompt was the single biggest thing
 * wrong with the first version of this: it cost tokens on every call and
 * buried the four facts that mattered.
 *
 * This turns raw entities into the semantic shape the spec asks for — rooms
 * with presence and lights, printers with progress, each value carrying how
 * old it is — and resolves the names a person actually says ("the workshop
 * lights") onto entity ids.
 *
 * Confidence is honest here rather than decorative: presence read straight off
 * a sensor is near-certain, presence inferred from a light being on is not,
 * and the model is told which it is looking at.
 */
const OCCUPANCY_CLASSES = new Set(['motion', 'occupancy', 'presence']);
const OCCUPANCY_HINTS = /(motion|occupancy|presence|pir)/i;

export class WorldState {
  constructor(ha, getConfig) {
    this.ha = ha;
    this.getConfig = getConfig;
  }

  /** Entities the owner exposed, grouped by room. Nothing else is in scope. */
  #watched() {
    const cfg = this.getConfig();
    const controlled = new Set(cfg.entities.controlled);
    const all = [...new Set([...cfg.entities.observed, ...controlled])];
    const out = [];
    for (const id of all) {
      const state = this.ha.states.get(id);
      if (!state) continue;
      out.push({
        entity_id: id,
        domain: id.split('.')[0],
        name: state.attributes?.friendly_name || id,
        area: this.ha.areaNameFor(id),
        state: state.state,
        deviceClass: state.attributes?.device_class,
        attributes: state.attributes || {},
        controllable: controlled.has(id),
        ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(state.last_changed)) / 1000)),
      });
    }
    return out;
  }

  areaNames() {
    return [...new Set(this.#watched().map((e) => e.area))].sort();
  }

  /**
   * Resolve what someone said onto entity ids. Accepts an exact entity id, a
   * room name, "all"/"everywhere", or a loose fragment of a device's name.
   * Only ever returns entities marked controllable.
   */
  resolveTarget(target, domains) {
    const wanted = new Set(domains);
    const entities = this.#watched().filter((e) => e.controllable && wanted.has(e.domain));
    const needle = String(target || '').toLowerCase().trim();
    if (!needle) return [];

    const exact = entities.find((e) => e.entity_id.toLowerCase() === needle);
    if (exact) return [exact.entity_id];

    if (needle === 'all' || needle === 'everything' || needle === 'everywhere' || needle === 'the house') {
      return entities.map((e) => e.entity_id);
    }

    const byArea = entities.filter((e) => e.area.toLowerCase() === needle);
    if (byArea.length) return byArea.map((e) => e.entity_id);

    // Partial room match, so "the lab" finds "workspace".
    const looseArea = entities.filter(
      (e) => e.area.toLowerCase().includes(needle) || needle.includes(e.area.toLowerCase()),
    );
    if (looseArea.length) return looseArea.map((e) => e.entity_id);

    const byName = entities.filter(
      (e) => e.name.toLowerCase().includes(needle) || e.entity_id.toLowerCase().includes(needle.replace(/\s+/g, '_')),
    );
    return byName.map((e) => e.entity_id);
  }

  /** One room, normalized. Null when the name matches nothing. */
  area(name) {
    const needle = String(name || '').toLowerCase().trim();
    const entities = this.#watched().filter(
      (e) => e.area.toLowerCase() === needle || e.area.toLowerCase().includes(needle),
    );
    if (!entities.length) return null;

    const areaName = entities[0].area;
    const sensors = entities.filter(isOccupancySensor);
    const lights = entities.filter((e) => e.domain === 'light');
    const on = lights.filter((e) => e.state === 'on');
    const media = entities.filter((e) => e.domain === 'media_player' && e.state === 'playing');
    const temperature = entities.find((e) => e.deviceClass === 'temperature');

    return {
      area: areaName,
      presence: describePresence(sensors),
      lights: {
        total: lights.length,
        on: on.length,
        state: !lights.length ? 'none' : on.length === 0 ? 'off' : on.length === lights.length ? 'on' : 'partial',
        brightness: averageBrightness(on),
      },
      media_playing: media.map((m) => m.attributes?.media_title || m.name),
      temperature: temperature ? Number(temperature.state) : null,
      controllable: entities.filter((e) => e.controllable).map((e) => ({ entity_id: e.entity_id, name: e.name, state: e.state })),
    };
  }

  /** Printer status, assembled from whatever entities the printer exposes. */
  printer(hint) {
    const entities = this.#watched();
    const statuses = entities.filter((e) => /print_status|print_state/.test(e.entity_id));
    if (!statuses.length) return null;

    const needle = String(hint || '').toLowerCase().trim();
    const status = needle ? statuses.find((e) => `${e.entity_id} ${e.name}`.toLowerCase().includes(needle)) : statuses[0];
    if (!status) return null;
    const prefix = status.entity_id.replace(/^sensor\./, '').replace(/_?print_?(status|state)$/, '');

    const near = (pattern) =>
      entities.find((e) => e.entity_id.startsWith(`sensor.${prefix}_`) && pattern.test(e.entity_id) && String(e.state).trim() !== '' && Number.isFinite(Number(e.state)));
    const progress = near(/progress|percent/);
    const remaining = near(/remaining_time|time_remaining|time_left/);

    return {
      printer: prefix,
      state: status.state,
      printing: /^(printing|running|busy|prepare|preparing)$/i.test(status.state),
      progress_percent: progress ? Number(progress.state) : null,
      remaining_minutes: remaining ? durationMinutes(remaining.state, remaining.attributes.unit_of_measurement) : null,
      updated_at: new Date(Date.now() - status.ageSeconds * 1000).toISOString(),
      age_seconds: status.ageSeconds,
    };
  }

  /**
   * The compact block that goes in the Context Packet. Rooms as sentences, not
   * an entity dump — this is roughly a tenth the tokens of the old prompt and
   * says more.
   */
  summary() {
    const entities = this.#watched();
    const areas = [...new Set(entities.map((e) => e.area))].sort();
    const lines = [];

    const where = this.likelyLocation();
    lines.push(`Time: ${new Date().toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`);
    if (where.area) {
      lines.push(`Owner is probably in: ${where.area} (${Math.round(where.confidence * 100)}% — ${where.why})`);
    } else {
      lines.push('Owner location: unknown (no sensor is reading motion)');
    }

    lines.push('', 'ROOMS');
    for (const name of areas) {
      const area = this.area(name);
      if (!area) continue;
      const bits = [`presence ${area.presence.value}`];
      if (area.lights.total) {
        bits.push(`lights ${area.lights.state}${area.lights.brightness ? ` at ${area.lights.brightness}%` : ''}`);
      }
      if (area.media_playing.length) bits.push(`playing ${area.media_playing[0]}`);
      if (area.temperature != null) bits.push(`${area.temperature}°`);
      lines.push(`- ${name}: ${bits.join(', ')}`);
    }

    const printer = this.printer();
    if (printer) {
      lines.push('', 'PRINTER');
      lines.push(
        `- ${printer.printer}: ${printer.state}` +
          (printer.progress_percent != null ? `, ${printer.progress_percent}%` : '') +
          (printer.remaining_minutes != null ? `, ${printer.remaining_minutes} min left` : ''),
      );
    }

    return lines.join('\n');
  }

  /**
   * Best guess at where the owner is. A sensor actively reading motion is
   * strong evidence; one that cleared a minute ago is weaker; a lit room with
   * no sensor is a guess and is labelled as one.
   */
  likelyLocation() {
    const entities = this.#watched();
    const sensors = entities.filter(isOccupancySensor);

    const active = sensors.filter((s) => s.state === 'on');
    if (active.length === 1) {
      return { area: active[0].area, confidence: 0.95, why: `${active[0].name} is reading motion` };
    }
    if (active.length > 1) {
      const freshest = active.reduce((a, b) => (a.ageSeconds < b.ageSeconds ? a : b));
      return { area: freshest.area, confidence: 0.6, why: `${active.length} rooms show motion; ${freshest.name} most recently` };
    }

    const recent = sensors.filter((s) => s.ageSeconds < 600).sort((a, b) => a.ageSeconds - b.ageSeconds)[0];
    if (recent) {
      return {
        area: recent.area,
        confidence: 0.5,
        why: `motion cleared there ${Math.round(recent.ageSeconds / 60)}m ago`,
      };
    }
    return { area: null, confidence: 0, why: 'no recent motion anywhere' };
  }
}

function isOccupancySensor(entity) {
  if (entity.domain !== 'binary_sensor') return false;
  return OCCUPANCY_CLASSES.has(entity.deviceClass) || OCCUPANCY_HINTS.test(entity.entity_id);
}

function describePresence(sensors) {
  if (!sensors.length) return { value: 'unknown', confidence: 0, why: 'no sensor in this room' };
  if (sensors.some((s) => s.state === 'on')) return { value: 'occupied', confidence: 0.95, why: 'motion right now' };
  const clearest = sensors.reduce((a, b) => (a.ageSeconds < b.ageSeconds ? a : b));
  const minutes = Math.round(clearest.ageSeconds / 60);
  return {
    value: 'empty',
    confidence: minutes > 10 ? 0.9 : 0.6,
    why: `no motion for ${minutes}m`,
  };
}

function averageBrightness(lights) {
  const values = lights.map((l) => l.attributes?.brightness).filter((b) => Number.isFinite(b));
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length / 255) * 100);
}


/** HA durations carry units; Bambu reports remaining print time in hours. */
export function durationMinutes(value, unit = 'min') {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const factors = {h:60, hr:60, hrs:60, hour:60, hours:60, min:1, mins:1, minute:1, minutes:1, s:1/60, sec:1/60, seconds:1/60};
  const factor = factors[String(unit).trim().toLowerCase()];
  return factor === undefined ? null : Math.round(number * factor * 1000) / 1000;
}
