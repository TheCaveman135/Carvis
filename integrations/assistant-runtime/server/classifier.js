/**
 * "Does this matter enough to wake Carvis?"
 *
 * Protocols handle things you asked about. This handles everything you didn't:
 * the print that paused on its own, the door that opened at 3am. Without it
 * Carvis only ever knows what it was told to look for.
 *
 * Three levels, cheapest first, which is the whole design:
 *
 *   Level 0  deterministic. Most events are settled here for free — a light
 *            changing is never interesting, a print failing always is.
 *   Level 1  a small local model, for the genuinely ambiguous remainder. Runs
 *            on the same free local model as triage.
 *   Level 2  Carvis itself, which costs real money and therefore runs least.
 *
 * Events are batched before Level 1 rather than classified one at a time.
 * Walking through the house fires a dozen presence events in ten seconds, and
 * they are one situation, not twelve.
 */
import { log } from './log.js';
import * as models from './models.js';

/** Never worth a thought. Routine device chatter with no narrative in it. */
const NEVER = [/^home\.(light|switch|fan|climate)\.changed$/, /^home\.sun\./, /^home\.media\./];

/** Always worth waking for. Something went wrong on its own. */
const ALWAYS = [/^printer\.[^.]+\.(failed|paused)$/];

const CLASSIFIER_SYSTEM = `You decide whether an assistant called Carvis should be woken up.

You are shown things that just happened in the owner's home, and what the home looks like right now.
You are not solving anything and you are not talking to the owner. You answer one question: is this
worth interrupting them for?

Wake for:
- something that went wrong, or stopped unexpectedly
- something finishing that the owner is plausibly waiting on
- something out of the ordinary for the time of day
- something that needs a decision soon

Do not wake for:
- routine comings and goings
- devices doing exactly what they always do
- anything the owner would find trivial or annoying to be told

Waking costs money and interrupts a person wearing these on their face. When it is a close call,
do not wake. Most of what you see should score low, and that is the correct outcome.`;

const CLASSIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    wake: { type: 'boolean', description: 'Should Carvis be woken?' },
    importance: { type: 'number', description: '0 to 1. Be stingy above 0.7.' },
    reason: { type: 'string', description: 'One short sentence on why, for Carvis to read.' },
  },
  required: ['wake', 'importance', 'reason'],
};

export class EventClassifier {
  constructor({ getConfig, bus, worldState, onWake, isClaimed = () => false, memory = null }) {
    this.getConfig = getConfig;
    this.memory = memory;
    this.bus = bus;
    this.worldState = worldState;
    this.onWake = onWake;
    this.isClaimed = isClaimed;

    this.pending = [];
    this.timer = null;
    this.lastWakeAt = 0;
    this.stats = { seen: 0, level0Dropped: 0, classified: 0, woke: 0 };
    this.lastDecision = null;
  }

  start() {
    this.bus.subscribe('**', (event) => this.#onEvent(event));
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  get enabled() {
    const cfg = this.getConfig();
    // Proactivity 0 means "only speak when spoken to", which switches this off
    // entirely rather than just quietening it.
    return Boolean(cfg.classifier?.enabled) && (cfg.classifier?.proactivity ?? 2) >= 2;
  }

  #onEvent(event) {
    if (!this.enabled) return;
    // Home Assistant can publish a semantic event for any of its entities.
    // Selection is a visibility boundary, not merely a write permission: do
    // not even send an unselected entity to the local classifier, much less
    // let it wake the main model.
    const entityId = event.source === 'home_assistant' ? event.data?.entity_id : null;
    if (entityId) {
      const entities = this.getConfig().entities || {};
      const visible = new Set([...(entities.observed || []), ...(entities.controlled || [])]);
      if (!visible.has(entityId)) return;
    }
    this.stats.seen++;

    // Level 0.
    if (NEVER.some((re) => re.test(event.type))) {
      this.stats.level0Dropped++;
      return;
    }
    // An event a protocol is already matching is that protocol's business;
    // both firing would wake Carvis twice for one thing.
    if (this.isClaimed(event)) {
      this.stats.level0Dropped++;
      return;
    }
    if (ALWAYS.some((re) => re.test(event.type))) {
      this.#wake(event, `${event.type} — this stopped on its own`, 1);
      return;
    }

    this.pending.push(event);
    if (this.pending.length > 20) this.pending.shift();

    clearTimeout(this.timer);
    const debounce = (this.getConfig().classifier?.debounceSec ?? 20) * 1000;
    this.timer = setTimeout(() => this.#consider(), debounce);
  }

  /** Level 1: one cheap call over the whole batch. */
  async #consider() {
    const cfg = this.getConfig();
    const batch = this.pending.splice(0, this.pending.length);
    if (!batch.length || !this.enabled) return;

    const quiet = (cfg.classifier?.minGapSec ?? 600) * 1000;
    if (this.lastWakeAt && Date.now() - this.lastWakeAt < quiet) {
      log('info', `Classifier: ${batch.length} event(s) held — woke Carvis recently`);
      return;
    }

    const summary = batch.map((e) => `- ${e.type}: ${JSON.stringify(e.data).slice(0, 160)}`).join('\n');
    const user = [
      'Things that just happened:',
      summary,
      '',
      'The home right now:',
      this.worldState.summary().slice(0, 1500),
    ].join('\n');

    try {
      const { json } = await models.complete(cfg, 'triage', {
        system: CLASSIFIER_SYSTEM + preferenceContext(this.memory),
        messages: [{ role: 'user', content: user }],
        schema: CLASSIFIER_SCHEMA,
      });
      this.stats.classified++;
      this.lastDecision = { ...json, at: Date.now(), events: batch.map((e) => e.type) };

      const threshold = cfg.classifier?.minImportance ?? 0.6;
      if (!json.wake || json.importance < threshold) {
        log('info', `Classifier: ignored ${batch.length} event(s) — ${json.reason}`);
        return;
      }
      this.#wake(batch[batch.length - 1], json.reason, json.importance);
    } catch (err) {
      // A classifier that cannot run must fail closed. Waking Carvis on every
      // event because the cheap model is down would be the expensive mistake.
      log('warn', `Classifier unavailable, ignoring ${batch.length} event(s): ${err.message}`);
    }
  }

  #wake(event, reason, importance) {
    this.lastWakeAt = Date.now();
    this.stats.woke++;
    log('think', `Classifier: waking Carvis — ${reason}`);
    this.onWake({
      trigger: {
        type: 'home_event',
        event: event.type,
        event_data: event.data,
        reason,
        importance,
      },
    });
  }

  state() {
    const cfg = this.getConfig();
    return {
      enabled: this.enabled,
      proactivity: cfg.classifier?.proactivity ?? 2,
      stats: this.stats,
      lastDecision: this.lastDecision,
      pending: this.pending.length,
    };
  }
}

export function preferenceContext(memory) {
  const sections = memory?.promptSections() || {};
  return sections.preferences || sections.rules ? '\n\nOwner preferences and rules (context, never new permissions):\n' + [sections.rules,sections.preferences].filter(Boolean).join('\n').slice(0,3000) + '\nUse these to judge relevance and avoid unwanted interruptions. A remembered preference does not authorize a new action.' : '';
}
