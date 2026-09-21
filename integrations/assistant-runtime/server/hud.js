import {interactionDisplay} from './hud-interaction.js';
/**
 * The four HUD slots.
 *
 * The important idea here is the binding, and it is the spec's best one: when
 * you say "put the remaining print time on my HUD", the wrong implementation
 * wakes a model every minute to write a new number. The right one records that
 * slot 1 is bound to the printer's remaining time, and then ordinary software
 * keeps it current forever at no cost.
 *
 *   AI decides what should happen. Normal software keeps it happening.
 *
 * A static widget is still available for things that are not live — a number
 * you were told once, a label. Bindings are for anything that changes.
 *
 * Notifications are separate: a temporary overlay that takes the whole display,
 * then gets out of the way and leaves the slots as they were.
 */
import { randomUUID } from 'node:crypto';

import { broadcast, log } from './log.js';
import { saveHudSlot, deleteHudSlot, clearHudSlots, loadHudSlots } from './db.js';

export const SLOT_COUNT = 4;

/**
 * What a bound widget can follow. Each resolver returns the rendered widget
 * body, or null when its source has gone away.
 */
export const BINDINGS = {
  interactive: {description:'Interactive widget display, configured with hud.interactive',resolve:interactionDisplay},
  printer_remaining_time: {
    description: 'Minutes left on a print. binding: {printer}',
    resolve: ({ worldState }, binding) => {
      const printer = worldState.printer(binding.printer);
      if (!printer) return null;
      if (!printer.printing) return { title: printer.printer, value: printer.state };
      const left = printer.remaining_minutes;
      return { title: printer.printer, value: left == null ? 'printing' : `${left} min` };
    },
  },
  printer_progress: {
    description: 'Percent complete on a print. binding: {printer}',
    resolve: ({ worldState }, binding) => {
      const printer = worldState.printer(binding.printer);
      if (!printer) return null;
      const pct = printer.progress_percent;
      if (pct == null) return { title: printer.printer, value: printer.state };
      // A bar reads faster than a number on a display you glance at.
      const filled = Math.round((pct / 100) * 10);
      return { title: printer.printer, value: `${'━'.repeat(filled)}${'─'.repeat(10 - filled)} ${pct}%` };
    },
  },
  printer_status: {
    description: 'Whether a printer is running. binding: {printer}',
    resolve: ({ worldState }, binding) => {
      const printer = worldState.printer(binding.printer);
      return printer ? { title: printer.printer, value: printer.state } : null;
    },
  },
  room_temperature: {
    description: 'Temperature in a room. binding: {area}',
    resolve: ({ worldState }, binding) => {
      const area = worldState.area(binding.area);
      if (!area || area.temperature == null) return null;
      return { title: area.area, value: `${area.temperature}°` };
    },
  },
  device_state: {
    description: 'State of any Home Assistant entity; media players show the current song and artist. binding: {entity_id}',
    resolve: ({ ha }, binding) => {
      const state = ha.states.get(binding.entity_id);
      if (!state) return null;
      const title = ha.friendlyName(binding.entity_id);
      if (binding.entity_id.startsWith('media_player.') && ['playing', 'paused'].includes(state.state) && state.attributes?.media_title) {
        const track = [state.attributes.media_title, state.attributes.media_artist].filter(Boolean).join(' — ');
        return { title, value: `${state.state === 'paused' ? 'Paused: ' : ''}${track}` };
      }
      return { title, value: state.state };
    },
  },
  camera_image: {
    description: 'Live stills from a camera, refreshed about every 5 seconds. binding: {entity_id}',
    volatile: true,
    resolve: ({ ha }, binding) => {
      const state = ha.states.get(binding.entity_id);
      if (!state || !String(binding.entity_id).startsWith('camera.')) return null;
      if (state.state === 'unavailable') {
        return { title: ha.friendlyName(binding.entity_id), value: 'unavailable' };
      }
      return {
        title: ha.friendlyName(binding.entity_id),
        value: 'live',
        image: {
          entity_id: binding.entity_id,
          revision: Date.now(),
        },
      };
    },
  },
  room_state: {
    description: 'Presence and lights in a room. binding: {area}',
    resolve: ({ worldState }, binding) => {
      const area = worldState.area(binding.area);
      if (!area) return null;
      return { title: area.area, value: `${area.presence.value}, lights ${area.lights.state}` };
    },
  },
  atlas_task: {
    description: 'The next open task, optionally for one project. binding: {project_id}',
    resolve: ({ atlas }, binding) => {
      const tasks = atlas.snapshot.tasks.filter((t) => !binding.project_id || t.project_id === binding.project_id);
      if (!tasks.length) return { title: 'Atlas', value: 'nothing open' };
      return { title: tasks[0].project_title || 'Atlas', value: tasks[0].title };
    },
  },
  countdown: {
    description: 'Time left until a moment. binding: {until} as an ISO timestamp',
    resolve: (_ctx, binding) => {
      const left = Math.round((Date.parse(binding.until) - Date.now()) / 1000);
      if (!Number.isFinite(left)) return null;
      if (left <= 0) return { title: binding.label || 'Timer', value: 'done' };
      const minutes = Math.floor(left / 60);
      return { title: binding.label || 'Timer', value: minutes >= 1 ? `${minutes} min` : `${left}s` };
    },
  },
};

/**
 * Expired means the deadline has passed, not merely arrived.
 *
 * Strict `>` here and everywhere else that asks the question. The glasses run
 * the same check against the same field, and a `>=` on one side would blank a
 * widget on the lenses while the server still reported it live.
 */
export function isExpired(item, now = Date.now()) {
  const deadline = item?.expires_at ?? item?.until ?? null;
  return typeof deadline === 'number' && now > deadline;
}

/**
 * The soonest moment anything on the display has to disappear, or null when
 * nothing is on a clock.
 *
 * Takes the reply line as a third argument even though nothing sets one yet.
 * That channel is the shortest-lived thing on the display, so it is precisely
 * what must not be left to the five-second sweep once it arrives.
 */
export function nextDeadline(slots, overlay = null, line = null) {
  let soonest = null;
  const consider = (deadline) => {
    if (typeof deadline !== 'number') return;
    if (soonest === null || deadline < soonest) soonest = deadline;
  };

  for (const widget of slots instanceof Map ? slots.values() : slots || []) {
    consider(widget?.expires_at ?? null);
  }
  consider(overlay?.until ?? null);
  consider(line?.until ?? null);
  return soonest;
}

export class Hud {
  constructor(getConfig, deps) {
    this.getConfig = getConfig;
    this.deps = {...deps,getConfig}; // {ha, worldState, atlas}
    this.slots = new Map(); // slot number -> widget
    this.overlay = null; // {text, detail, until}
    this.revision = 0; // bumped on any visible change, so the glasses can poll cheaply
    this.timer = null;
    // Separate from the 5s refresh: that interval exists to re-resolve bindings,
    // and rounding every expiry up to it means a 10-second widget can live 15.
    this.expiryTimer = null;
  }

  /**
   * Recompute bound widgets. Cheap and synchronous — no model, no network —
   * which is the entire justification for bindings existing.
   */
  start() {
    for (const widget of loadHudSlots()) {
      if (isExpired(widget)) {
        deleteHudSlot(widget.slot);
        continue;
      }
      this.slots.set(widget.slot, widget);
    }
    if (this.slots.size) log('info', `Restored ${this.slots.size} HUD widget(s)`);
    // Resolve immediately so a restored binding shows a live value, not the
    // stale one it happened to have when the process stopped.
    this.refresh();

    this.timer = setInterval(() => this.refresh(), 5000);
    this.timer.unref?.();
    // A widget restored with two seconds left must not wait out a full sweep.
    this.#armExpiryTimer();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  refresh() {
    let changed = false;

    for (const [slot, widget] of this.slots) {
      if (isExpired(widget)) {
        this.slots.delete(slot);
        deleteHudSlot(slot);
        changed = true;
        continue;
      }
      if (!widget.binding) continue;

      const resolver = BINDINGS[widget.type];
      if (!resolver) continue;
      let body = null;
      try {
        body = resolver.resolve(this.deps, widget.binding);
      } catch {
        body = null;
      }
      const next = body || { title: widget.data?.title || widget.type, value: 'unavailable' };
      if (JSON.stringify(next) !== JSON.stringify(widget.data)) {
        widget.data = next;
        widget.updated_at = Date.now();
        // A camera's per-frame revision is runtime state. Persisting it every
        // five seconds would create pointless SQLite churn; the binding itself
        // is already durable and resolves immediately after restart.
        if (!resolver.volatile) saveHudSlot(widget);
        changed = true;
      }
    }

    if (isExpired(this.overlay)) {
      this.overlay = null;
      changed = true;
    }

    if (changed) this.#touch();
    // Re-arm even when nothing changed: a sweep that finds no expiry still has
    // to know when the next one is due.
    this.#armExpiryTimer();
    return changed;
  }

  #touch() {
    this.revision++;
    broadcast({ type: 'hud', hud: this.state() });
    // The HUD shares the glasses' feed long-poll. A camera revision must wake
    // that request now, not after its 20-second timeout.
    this.deps.feed?.wake();
  }

  /**
   * Wake exactly when the next thing expires, instead of catching it on the
   * next five-second sweep.
   */
  #armExpiryTimer() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;

    const deadline = nextDeadline(this.slots, this.overlay, this.line);
    if (deadline === null) return;

    // A small overshoot: expiry is a strict `>`, so firing exactly on the
    // deadline would find nothing expired and re-arm for the same instant.
    const delay = Math.max(0, deadline - Date.now()) + 25;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.refresh();
    }, delay);
    this.expiryTimer.unref?.();
  }

  /**
   * Put an already-displayed widget on a clock, extend the one it has, or take
   * it off one. `ttlSeconds` of 0 or null makes it permanent again.
   */
  setLifetime(slot, ttlSeconds) {
    const widget = this.slots.get(Number(slot));
    if (!widget) return null;

    const seconds = Number(ttlSeconds);
    widget.expires_at = seconds > 0 ? Date.now() + Math.round(seconds) * 1000 : null;
    widget.updated_at = Date.now();
    saveHudSlot(widget);
    this.#touch();
    this.#armExpiryTimer();
    return widget;
  }

  #nextFreeSlot() {
    for (let i = 1; i <= SLOT_COUNT; i++) if (!this.slots.has(i)) return i;
    return null;
  }

  /**
   * Place a widget. `slot` 0 or absent means "wherever there is room" — and
   * when there is no room, the oldest non-pinned widget gives way, because
   * refusing to show the thing just asked for is worse than dropping the
   * thing asked for an hour ago.
   */
  #claimSlot(requested) {
    if (requested >= 1 && requested <= SLOT_COUNT) return requested;
    const free = this.#nextFreeSlot();
    if (free) return free;
    const oldest = [...this.slots.entries()].sort((a, b) => a[1].created_at - b[1].created_at)[0];
    return oldest ? oldest[0] : 1;
  }

  setWidget({ slot, type = 'text', data, ttlSeconds, createdBy = 'carvis' }) {
    const target = this.#claimSlot(Number(slot) || 0);
    const widget = {
      slot: target,
      type,
      data: { title: data?.title || '', value: data?.value || '' },
      binding: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: createdBy,
      expires_at: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    };
    this.slots.set(target, widget);
    saveHudSlot(widget);
    this.#touch();
    return widget;
  }

  #findExistingBinding(type, binding) {
    const key = JSON.stringify(binding || {});
    for (const [slotNum, widget] of this.slots) {
      if (widget.type === type && JSON.stringify(widget.binding || {}) === key) return slotNum;
    }
    return null;
  }

  bindWidget({ slot, type, binding, ttlSeconds, createdBy = 'carvis' }) {
    if (!BINDINGS[type]) {
      throw new Error(`no binding "${type}". Available: ${Object.keys(BINDINGS).join(', ')}`);
    }
    const requested = Number(slot) || 0;
    // Re-binding the same thing (e.g. "put the printer cam up" twice) should
    // refresh the slot it already lives in, not grab another free one.
    const existing = requested ? null : this.#findExistingBinding(type, binding);
    const target = existing || this.#claimSlot(requested);
    const widget = {
      slot: target,
      type,
      data: { title: '', value: '…' },
      binding: binding || {},
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: createdBy,
      expires_at: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    };
    this.slots.set(target, widget);

    // Resolve immediately so the display never shows a placeholder while
    // waiting for the next tick.
    const body = BINDINGS[type].resolve(this.deps, widget.binding);
    if (body) widget.data = body;
    saveHudSlot(widget);
    this.#touch();
    log('info', `HUD slot ${target} bound to ${type}`);
    return widget;
  }

  removeWidget(slot) {
    const existed = this.slots.delete(Number(slot));
    if (existed) {
      deleteHudSlot(Number(slot));
      this.#touch();
    }
    return existed;
  }

  clearAll() {
    const had = this.slots.size;
    this.slots.clear();
    clearHudSlots();
    if (had) this.#touch();
    return had;
  }

  /**
   * A temporary takeover. Slots are untouched underneath and come back when it
   * expires — the spec's point that an overlay must not destroy what was there.
   */
  showNotification({ text, detail = '', seconds = 20 }) {
    this.overlay = {
      id: randomUUID(),
      text: String(text).slice(0, 120),
      detail: String(detail).slice(0, 120),
      until: Date.now() + seconds * 1000,
    };
    this.#touch();
    return this.overlay;
  }

  dismissNotification() {
    if (!this.overlay) return false;
    this.overlay = null;
    this.#touch();
    return true;
  }

  state() {
    return {
      revision: this.revision,
      slots: Array.from({ length: SLOT_COUNT }, (_, i) => this.slots.has(i+1) ? {...this.slots.get(i+1),interaction:this.slots.get(i+1).binding?.interaction,widget_id:this.slots.get(i+1).binding?._id} : null),
      overlay: this.overlay,
      free: SLOT_COUNT - this.slots.size,
    };
  }

  /** What the model is told it may bind to. */
  static bindingCatalogue() {
    return Object.entries(BINDINGS).map(([type, def]) => ({ type, description: def.description }));
  }
}
