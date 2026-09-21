/**
 * The event bus.
 *
 * Everything that happens anywhere becomes one envelope shape, and everything
 * that cares subscribes by pattern. That indirection is what lets a watch say
 * "wake me when `printer.p2s.completed`" without knowing that underneath it is
 * a Home Assistant sensor called `sensor.p2s_printer_print_status` flipping
 * from `printing` to `finish`.
 *
 *   {id, type, source, timestamp, data}
 *
 * The normalizer below is the load-bearing part. Home Assistant emits 888
 * entities of raw state; almost none of it is semantically meaningful. Turning
 * the handful that are into named events is what stops every other layer from
 * having to know entity ids.
 */
import { randomUUID } from 'node:crypto';

import { recordEvent, pruneEvents } from './db.js';
import { log } from './log.js';

const OCCUPANCY_CLASSES = new Set(['motion', 'occupancy', 'presence']);
const OCCUPANCY_HINTS = /(motion|occupancy|presence|pir)/i;

export class EventBus {
  constructor() {
    this.subscribers = []; // {pattern, fn}
    this.recent = []; // in-memory tail, for the UI
    this.published = 0;
  }

  /**
   * `pattern` is a dot path where `*` matches one segment and `**` (or a
   * trailing `*`) matches the rest: `printer.*.completed`, `presence.**`, `*`.
   */
  subscribe(pattern, fn) {
    const entry = { pattern, fn, re: patternToRegExp(pattern) };
    this.subscribers.push(entry);
    return () => {
      const i = this.subscribers.indexOf(entry);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }

  publish(type, source, data = {}) {
    const event = { id: `evt_${randomUUID().slice(0, 12)}`, type, source, timestamp: Date.now(), data };

    this.published++;
    this.recent.push(event);
    if (this.recent.length > 200) this.recent.shift();

    try {
      recordEvent(event);
      // Cheap enough to amortise rather than run on a timer nobody can see.
      if (this.published % 500 === 0) pruneEvents();
    } catch (err) {
      log('warn', `Could not persist event: ${err.message}`);
    }

    for (const sub of this.subscribers) {
      if (!sub.re.test(type)) continue;
      try {
        sub.fn(event);
      } catch (err) {
        // One bad subscriber must not stop the others from seeing the event.
        log('error', `Event subscriber for "${sub.pattern}" threw: ${err.message}`);
      }
    }
    return event;
  }

  recentEvents(limit = 30) {
    return this.recent.slice(-limit).reverse();
  }
}

function patternToRegExp(pattern) {
  if (pattern === '*' || pattern === '**') return /.*/;
  const source = pattern
    .split('.')
    .map((segment) => {
      if (segment === '**') return '.*';
      if (segment === '*') return '[^.]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('\\.');
  return new RegExp(`^${source}$`);
}

/**
 * Turn one Home Assistant state change into a semantic event, or null when it
 * carries no meaning worth a name. Returning null is the common case and the
 * point: an event bus that republishes all 888 entities has not normalized
 * anything.
 */
export function normalizeHaChange(entityId, newState, oldState, areaName) {
  const domain = entityId.split('.')[0];
  const to = newState?.state;
  const from = oldState?.state;
  if (to === undefined || to === from) return null;
  if (to === 'unavailable' || to === 'unknown') return null;

  const area = slug(areaName || 'unassigned');
  const deviceClass = newState?.attributes?.device_class;
  const name = newState?.attributes?.friendly_name || entityId;
  const base = { entity_id: entityId, name, area: areaName, from, to };

  // Presence — the single most useful thing HA knows about you.
  if (domain === 'binary_sensor' && (OCCUPANCY_CLASSES.has(deviceClass) || OCCUPANCY_HINTS.test(entityId))) {
    return to === 'on'
      ? { type: `presence.${area}.entered`, data: base }
      : { type: `presence.${area}.left`, data: base };
  }

  // Printers report through a status sensor whose vocabulary is the printer's,
  // not Home Assistant's, so the mapping has to be explicit.
  if (/print_status|print_state/.test(entityId)) {
    const printer = slug(entityId.replace(/^sensor\./, '').replace(/_?print_?(status|state)$/, '')) || 'printer';
    const phase = printerPhase(to);
    if (!phase) return null;
    return { type: `printer.${printer}.${phase}`, data: { ...base, printer, phase } };
  }

  if (domain === 'lock') {
    // Home Assistant also reports transitional/error states such as
    // `locking`, `unlocking`, and `jammed`. A watch for an unlocked door must
    // never fire on one of those merely because it is not literally `locked`.
    if (to !== 'locked' && to !== 'unlocked') return null;
    return { type: `home.lock.${to}`, data: base };
  }
  if (domain === 'binary_sensor' && deviceClass === 'door') {
    return { type: `home.door.${to === 'on' ? 'opened' : 'closed'}`, data: base };
  }
  if (domain === 'media_player') {
    return { type: `home.media.${to}`, data: base };
  }
  if (domain === 'light' || domain === 'switch' || domain === 'fan') {
    return { type: `home.${domain}.changed`, data: base };
  }
  if (domain === 'person' || domain === 'device_tracker') {
    return { type: `presence.person.${to === 'home' ? 'home' : 'away'}`, data: base };
  }
  if (domain === 'climate') {
    return { type: 'home.climate.changed', data: base };
  }
  if (domain === 'sun') {
    return { type: `home.sun.${to}`, data: base };
  }

  // Numeric sensors change constantly and almost never mean anything on their
  // own. Anything that wants them can read state directly.
  return null;
}

function printerPhase(state) {
  const value = String(state).toLowerCase();
  if (/^(printing|running|busy)$/.test(value)) return 'started';
  if (/^(finish|finished|complete|completed|idle_finished)$/.test(value)) return 'completed';
  if (/^(pause|paused)$/.test(value)) return 'paused';
  if (/^(fail|failed|error)$/.test(value)) return 'failed';
  if (/^(idle|standby|offline)$/.test(value)) return 'idle';
  return null;
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export const bus = new EventBus();
