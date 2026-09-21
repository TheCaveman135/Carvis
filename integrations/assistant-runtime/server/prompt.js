/**
 * Turns a world snapshot into the text the model sees.
 *
 * The important design choice lives here: anything that is arithmetic or
 * lookup — has motion been clear long enough, does this room even have a
 * sensor, is it dark — is computed in JavaScript and handed to the model as a
 * conclusion. Small local models are unreliable at "is 27m more than 10m" and
 * at noticing an absent sensor, and they fail silently. They are good at
 * mapping a stated situation onto a policy. So we do the counting; they do the
 * deciding.
 *
 * `server/agent.js` builds a world from live Home Assistant state;
 * `scripts/eval.mjs` builds one from fixtures. Both go through this file, so
 * the eval scores the prompt you actually run.
 */

const OCCUPANCY_CLASSES = new Set(['motion', 'occupancy', 'presence']);
const OCCUPANCY_HINTS = /(motion|occupancy|presence|pir)/i;

export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function isOccupancySensor(e) {
  if (e.domain !== 'binary_sensor') return false;
  return OCCUPANCY_CLASSES.has(e.device_class) || OCCUPANCY_HINTS.test(e.entity_id);
}

/**
 * Classify one room. Returns the line the model reads, plus a machine-readable
 * verdict the caller can use for its own bookkeeping.
 */
export function roomStatus(entities, vacancyMinutes) {
  const sensors = entities.filter(isOccupancySensor);
  const media = entities.filter((e) => e.domain === 'media_player' && e.state === 'playing');
  const thresholdSec = vacancyMinutes * 60;

  let verdict;
  let detail;

  if (!sensors.length) {
    verdict = 'NO SENSOR';
    detail = 'this room has no motion or occupancy sensor, so occupancy is unknowable — never turn anything off here';
  } else if (sensors.some((s) => s.state === 'on')) {
    const active = sensors.find((s) => s.state === 'on');
    verdict = 'OCCUPIED';
    detail = `${active.entity_id} is reading motion right now — someone is in this room`;
  } else if (sensors.every((s) => s.state === 'off')) {
    const clearest = sensors.reduce((a, b) => (a.secondsSince < b.secondsSince ? a : b));
    if (clearest.secondsSince >= thresholdSec) {
      verdict = 'VACANT';
      detail = `no motion for ${humanDuration(clearest.secondsSince * 1000)}, which is past the ${vacancyMinutes}m threshold — safe to turn things off here`;
    } else {
      const left = Math.ceil((thresholdSec - clearest.secondsSince) / 60);
      verdict = 'RECENTLY ACTIVE';
      detail = `motion cleared only ${humanDuration(clearest.secondsSince * 1000)} ago, ${left}m short of the ${vacancyMinutes}m threshold — not vacant yet, leave it alone`;
    }
  } else {
    verdict = 'UNKNOWN';
    detail = 'occupancy sensors are unavailable — treat as occupied and leave things alone';
  }

  if (media.length) {
    detail += `; ${media[0].entity_id} is playing, so do not turn anything off in this room`;
    if (verdict === 'VACANT') verdict = 'VACANT BUT MEDIA PLAYING';
  }

  return { verdict, detail };
}

/** Dark enough to justify turning a light on? */
export function darkness(entities, sunState) {
  if (sunState === 'below_horizon') return { dark: true, why: 'sun is below the horizon' };
  if (sunState === 'above_horizon') return { dark: false, why: 'sun is above the horizon — it is daylight' };

  const lux = entities.find((e) => e.device_class === 'illuminance' && Number.isFinite(Number(e.state)));
  if (lux) {
    const value = Number(lux.state);
    return { dark: value < 20, why: `${lux.entity_id} reads ${value} lx` };
  }
  return { dark: null, why: 'no sun entity and no light sensor — darkness is unknown, so do not turn lights on' };
}

/**
 * The same verdicts the prompt shows, indexed per entity so the guard layer can
 * enforce them. The model sees these conclusions and the guards re-check them,
 * which means a model that ignores the procedure cannot act outside it.
 */
export function computeEnvelope(world) {
  const verdictByEntity = new Map();
  const areaByEntity = new Map();
  for (const area of world.areas) {
    const { verdict } = roomStatus(area.entities, world.vacancyMinutes);
    for (const e of area.entities) {
      verdictByEntity.set(e.entity_id, verdict);
      areaByEntity.set(e.entity_id, area.name);
    }
  }
  return {
    verdictByEntity,
    areaByEntity,
    dark: darkness(world.areas.flatMap((a) => a.entities), world.sunState).dark,
  };
}

const INTERESTING_ATTRS = {
  light: ['brightness'],
  sensor: ['unit_of_measurement'],
  media_player: ['media_title'],
  climate: ['current_temperature', 'temperature'],
  fan: ['percentage'],
};

/**
 * @param world {{
 *   now: number, sunState: string|undefined, vacancyMinutes: number,
 *   areas: Array<{name: string, note?: string, entities: Array<{
 *     entity_id: string, domain: string, name: string, state: string,
 *     secondsSince: number, device_class?: string, attributes?: object,
 *     controllable: boolean }>}>,
 *   changes: Array<{entity_id: string, from: string, to: string, secondsAgo: number, byAgent: boolean}>,
 *   recentActions: Array<{entity_id: string, service: string, reason: string, secondsAgo: number, dryRun?: boolean}>,
 *   held: Array<{entity_id: string, secondsAgo: number}>,
 * }}
 */
export function buildPrompt(world) {
  const { now, sunState, vacancyMinutes, areas, changes, recentActions, held } = world;
  const lines = [];
  const allEntities = areas.flatMap((a) => a.entities);
  const dark = darkness(allEntities, sunState);

  lines.push(
    `TIME: ${new Date(now).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}`,
  );
  lines.push(`LIGHT LEVEL: ${dark.dark === true ? 'DARK' : dark.dark === false ? 'DAYLIGHT' : 'UNKNOWN'} — ${dark.why}`);
  lines.push(`VACANCY THRESHOLD: ${vacancyMinutes} minutes.`);

  lines.push('');
  lines.push('=== ROOM STATUS (already worked out for you — trust these verdicts) ===');
  for (const area of areas) {
    const { verdict, detail } = roomStatus(area.entities, vacancyMinutes);
    lines.push(`${area.name}: ${verdict} — ${detail}`);
    if (area.note) lines.push(`    owner's note: ${area.note}`);
  }

  lines.push('');
  lines.push('=== ENTITIES ===');
  for (const area of areas) {
    lines.push(`\n## ${area.name}`);
    for (const e of [...area.entities].sort((a, b) => a.entity_id.localeCompare(b.entity_id))) {
      const tag = e.controllable ? 'CONTROLLABLE' : 'read-only';
      const attrs = (INTERESTING_ATTRS[e.domain] || [])
        .map((k) => (e.attributes?.[k] != null ? `${k}=${e.attributes[k]}` : null))
        .filter(Boolean)
        .join(' ');
      lines.push(
        `- [${tag}] ${e.entity_id} "${e.name}" = ${e.state} (for ${humanDuration(e.secondsSince * 1000)})${attrs ? ` {${attrs}}` : ''}`,
      );
    }
  }

  lines.push('');
  lines.push('=== RECENT CHANGES ===');
  if (!changes.length) lines.push('(nothing changed)');
  for (const c of changes) {
    lines.push(
      `- ${c.entity_id}: ${c.from} -> ${c.to} (${humanDuration(c.secondsAgo * 1000)} ago)${c.byAgent ? ' [you did this]' : ' [a human or an automation did this]'}`,
    );
  }

  lines.push('');
  lines.push('=== YOUR RECENT ACTIONS ===');
  if (!recentActions.length) lines.push('(none yet)');
  for (const a of recentActions) {
    lines.push(
      `- ${humanDuration(a.secondsAgo * 1000)} ago: ${a.entity_id} ${a.service}${a.dryRun ? ' (dry run)' : ''} — ${a.reason}`,
    );
  }

  if (held.length) {
    lines.push('');
    lines.push('=== HUMAN-OVERRIDDEN — DO NOT TOUCH THESE ===');
    for (const h of held) lines.push(`- ${h.entity_id} (a human changed it ${humanDuration(h.secondsAgo * 1000)} ago)`);
  }

  const controllable = allEntities.filter((e) => e.controllable).map((e) => e.entity_id);
  lines.push('');
  lines.push('=== CONTROLLABLE ENTITIES (the only ids you may emit) ===');
  lines.push(controllable.length ? controllable.join('\n') : '(none — return an empty actions array)');

  lines.push('');
  lines.push('Apply the procedure to each room above and return the resulting actions.');

  return lines.join('\n');
}
