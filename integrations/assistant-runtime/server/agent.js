/**
 * The guarded Home Assistant executor.
 *
 * This used to also own an autonomous "heartbeat": a periodic model call that
 * looked at the whole house and decided what to change. Protocols replaced it
 * — a saved protocol is a validated program evaluated in ordinary JavaScript,
 * so the house no longer needs a model kept awake and guessing on a timer.
 *
 * What remains here is the half that was never about the loop: turning a
 * proposed action into a real service call, with `guards.js` in front of it.
 * Every origin funnels through `#applyActions` — spoken commands, typed
 * requests, and protocol tool calls alike — so the allowlist, the cooldown,
 * the manual-override hold and dry run cannot be routed around by adding a
 * new caller.
 */
import { log, broadcast } from './log.js';
import { vetAction } from './guards.js';
import { computeEnvelope } from './prompt.js';

/** Bounded, so an always-on process cannot accumulate change history forever. */
const MAX_RECENT_CHANGES = 60;

export class Agent {
  constructor(ha, getConfig) {
    this.ha = ha;
    this.getConfig = getConfig;
    this.recentActions = []; // newest last, capped
    this.changes = new Map(); // entity_id -> { from, to, ts, byAgent }
    this.cooldown = new Map(); // entity_id -> ts of last agent action
    this.manualTouch = new Map(); // entity_id -> ts of last human-looking change
    this.selfActed = new Map(); // entity_id -> ts, used to attribute state changes
    this.lastError = '';

    this.ha.onStateChanged = (entityId, newState, oldState) => {
      this.#recordChange(entityId, newState, oldState);
    };
  }

  #recordChange(entityId, newState, oldState) {
    const cfg = this.getConfig();
    const watched =
      cfg.entities.observed.includes(entityId) || cfg.entities.controlled.includes(entityId);
    if (!watched) return;
    if (newState?.state === oldState?.state) return; // attribute-only churn

    const now = Date.now();
    const actedAt = this.selfActed.get(entityId) || 0;
    const byAgent = now - actedAt < 20_000; // our own service call landing
    if (!byAgent && cfg.entities.controlled.includes(entityId)) {
      this.manualTouch.set(entityId, now);
    }
    this.changes.set(entityId, {
      from: oldState?.state ?? 'unknown',
      to: newState?.state ?? 'unknown',
      ts: now,
      byAgent,
    });
    // The heartbeat used to drain this map on every tick. Nothing does now, so
    // the bound has to live here or a long-running process leaks one entry per
    // entity that ever changes.
    if (this.changes.size > MAX_RECENT_CHANGES) {
      const oldest = [...this.changes.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [id] of oldest.slice(0, this.changes.size - MAX_RECENT_CHANGES)) this.changes.delete(id);
    }
    broadcast({
      type: 'state',
      entity_id: entityId,
      state: newState?.state ?? 'unknown',
      last_changed: newState?.last_changed,
    });
  }

  /** Recent state changes, newest last — chat context and the world snapshot. */
  recentChanges() {
    return [...this.changes.entries()]
      .map(([entity_id, c]) => ({ entity_id, ...c }))
      .sort((a, b) => a.ts - b.ts);
  }

  /**
   * Run a set of actions that came from a spoken command or a protocol rather
   * than from a person pressing a button. Same guard layer, same execution,
   * different origin — so the occupancy envelope steps aside but the allowlist
   * does not. Dry run still applies: if the home is in dry run, saying it out
   * loud does not send it.
   */
  async executeVoiceActions(actions, toolCtx = {}) {
    const cfg = this.getConfig();
    if (this.ha.status !== 'connected') throw new Error('Home Assistant is not connected');
    const envelope = computeEnvelope(this.buildWorld([]));
    const directOwner = toolCtx.triggerType === 'user_voice' || toolCtx.triggerType === 'user_text';
    return this.#applyActions(actions, cfg, envelope, directOwner ? 'voice' : 'automation', toolCtx);
  }

  async #applyActions(actions, cfg, envelope, origin = 'automation', toolCtx = {}) {
    const executed = [];
    const rejected = [];
    const ctx = {
      cfg,
      ha: this.ha,
      envelope,
      cooldown: this.cooldown,
      manualTouch: this.manualTouch,
      now: Date.now(),
      origin,
      triggerType: toolCtx.triggerType || (origin === 'voice' ? 'user_voice' : origin),
      wakeWord: toolCtx.wakeWord === true,
      confirmed: toolCtx.confirmed === true,
    };

    // Every remaining caller is an explicit action plan — a spoken command or
    // a saved protocol — so a room target may legitimately contain more than a
    // handful of lights. The old per-tick cap existed to bound an autonomous
    // model loop that no longer exists; the hard 25-action slice is what bounds
    // this now.
    const LIMIT = 25;

    for (const raw of actions.slice(0, LIMIT)) {
      if (executed.length >= LIMIT) {
        rejected.push({ entity_id: raw?.entity_id, reason: 'action limit reached' });
        continue;
      }
      const vet = vetAction(raw, ctx);
      if (!vet.ok) {
        rejected.push({ entity_id: vet.entity_id, reason: vet.reason });
        continue;
      }
      const a = { ...vet.action, origin };
      const label = `${this.ha.friendlyName(a.entity_id)} → ${a.service.replace('turn_', '')}`;

      if (cfg.agent.dryRun) {
        // Start the cooldown here too. Dry run is meant to preview live
        // behaviour, and without this a repeating protocol re-fires the same
        // action forever — the entity never changes state, so nothing
        // suppresses it.
        this.cooldown.set(a.entity_id, Date.now());
        executed.push({ ...a, dryRun: true });
        log('action', `[dry run] ${label} — ${a.reason}`);
        continue;
      }

      try {
        const data = { entity_id: a.entity_id, ...(a.service_data || {}) };
        this.selfActed.set(a.entity_id, Date.now());
        const delivery = await this.ha.callService(a.domain, a.service, data);
        if (delivery?.source === 'apple_tv_ai') a.controller = delivery;
        this.cooldown.set(a.entity_id, Date.now());
        executed.push({ ...a, dryRun: false });
        log('action', `${label} — ${a.reason}`);
      } catch (err) {
        this.selfActed.delete(a.entity_id);
        rejected.push({ entity_id: a.entity_id, reason: `call failed: ${err.message}` });
        log('error', `${label} failed: ${err.message}`);
      }
    }

    const stamped = executed.map((a) => ({ ...a, ts: Date.now() }));
    this.recentActions.push(...stamped);
    if (this.recentActions.length > 40) this.recentActions.splice(0, this.recentActions.length - 40);
    return { executed: stamped, rejected };
  }

  /**
   * Live Home Assistant state, shaped into the world `prompt.js` expects.
   *
   * Defaults to the recent-change buffer rather than an empty list: the
   * heartbeat used to hand in the batch it had just drained, and with it gone
   * every caller was passing `[]` — which silently dropped "what just changed"
   * out of the Chat tab's context for no reason.
   */
  buildWorld(changes = this.recentChanges()) {
    const cfg = this.getConfig();
    const now = Date.now();
    const controlled = new Set(cfg.entities.controlled);
    const all = [...new Set([...cfg.entities.observed, ...controlled])];

    const byArea = new Map();
    for (const id of all) {
      const s = this.ha.states.get(id);
      if (!s) continue;
      const area = this.ha.areaNameFor(id);
      if (!byArea.has(area)) byArea.set(area, []);
      byArea.get(area).push({
        entity_id: id,
        domain: id.split('.')[0],
        name: s.attributes?.friendly_name || id,
        state: s.state,
        secondsSince: Math.max(0, Math.round((now - Date.parse(s.last_changed)) / 1000)),
        device_class: s.attributes?.device_class,
        attributes: s.attributes,
        controllable: controlled.has(id),
      });
    }

    return {
      now,
      // The legacy prompt consumes this field, but the sun entity follows the
      // same owner-selection boundary as every other HA entity.
      sunState: all.includes('sun.sun') ? this.ha.states.get('sun.sun')?.state : null,
      vacancyMinutes: cfg.agent.vacancyMinutes,
      areas: [...byArea.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, entities]) => ({ name, note: cfg.areaNotes?.[name], entities })),
      changes: changes
        .slice()
        .filter((change) => !change.entity_id || all.includes(change.entity_id))
        .sort((a, b) => a.ts - b.ts)
        .map((c) => ({ ...c, secondsAgo: Math.round((now - c.ts) / 1000) })),
      recentActions: this.recentActions
        .slice(-12)
        .map((a) => ({ ...a, secondsAgo: Math.round((now - a.ts) / 1000) })),
      held: [...this.manualTouch.entries()]
        .filter(([, ts]) => now - ts < cfg.agent.respectManualOverrideSec * 1000)
        .map(([entity_id, ts]) => ({ entity_id, secondsAgo: Math.round((now - ts) / 1000) })),
    };
  }

  status() {
    const cfg = this.getConfig();
    return {
      dryRun: cfg.agent.dryRun,
      lastError: this.lastError,
      recentActions: this.recentActions.slice(-20),
      ha: {
        status: this.ha.status,
        error: this.ha.error,
        version: this.ha.haVersion,
        entityCount: this.ha.states.size,
      },
    };
  }
}
