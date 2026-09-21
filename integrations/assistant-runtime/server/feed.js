/**
 * The feed the G2 renders.
 *
 * Everything Carvis does that you might want to see ends up here: actions it
 * carried out, the replies worth showing, and the notes it filed. The glasses
 * long-poll it, so an entry appearing here is the same thing as it appearing
 * on your display.
 *
 * Not everything Carvis *hears* lands here — that is the whole point of the
 * triage step. A feed that echoed every overheard sentence would be unreadable
 * on a 576x288 canvas and useless anywhere else.
 */
import { randomUUID } from 'node:crypto';

import { broadcast } from './log.js';

/** Kinds the glasses know how to draw. Anything else renders as a plain note. */
export const FEED_KINDS = ['action', 'reply', 'note', 'error', 'heard'];

export class Feed {
  constructor(getConfig, { onEntry = () => {} } = {}) {
    this.getConfig = getConfig;
    this.onEntry = onEntry;
    this.entries = [];
    this.seq = 0;
    this.waiters = new Set(); // long-poll resolvers
    this.lastProactiveAt = 0;
  }

  /**
   * @param kind      one of FEED_KINDS
   * @param text      the line itself — write it for a 576x288 display
   * @param opts      { detail, proactive, source }
   * @returns the entry, or null when a proactive push was rate-limited away
   */
  push(kind, text, opts = {}) {
    const cfg = this.getConfig();
    const body = String(text || '').trim();
    if (!body) return null;

    // Carvis speaking first is welcome; Carvis speaking first constantly is
    // a notification stream strapped to your face.
    if (opts.proactive) {
      if (!cfg.glasses.proactive) return null;
      const since = (Date.now() - this.lastProactiveAt) / 1000;
      if (this.lastProactiveAt && since < cfg.glasses.proactiveMinGapSec) return null;
      this.lastProactiveAt = Date.now();
    }

    const entry = {
      id: randomUUID(),
      seq: ++this.seq,
      ts: Date.now(),
      kind: FEED_KINDS.includes(kind) ? kind : 'note',
      text: body.slice(0, 500),
      ...(body.length > 500 ? {fullText: body.slice(0, 8000)} : {}),
      detail: String(opts.detail || '').slice(0, 500),
      source: opts.source || 'carvis',
    };

    this.entries.push(entry);
    const max = cfg.glasses.feedSize || 60;
    if (this.entries.length > max) this.entries.splice(0, this.entries.length - max);

    broadcast({ type: 'feed', entry });
    // Speech delivery is intentionally asynchronous. A speaker being offline
    // must never delay, hide, or break the same line on the glasses/WebUI.
    Promise.resolve().then(() => this.onEntry({ ...entry, text: body })).catch(() => {});
    this.#wake();
    return entry;
  }

  /** Everything newer than `sinceSeq`. The glasses pass back their last seq. */
  since(sinceSeq = 0) {
    return this.entries.filter((e) => e.seq > sinceSeq);
  }

  recent(limit = 20) {
    return this.entries.slice(-limit);
  }

  /**
   * Long-poll: resolve as soon as there is anything newer than `sinceSeq`, or
   * after `timeoutMs` with an empty list. Keeps the glasses off a 1Hz poll
   * loop, which on a battery you wear matters more than it does on a server.
   */
  wait(sinceSeq, timeoutMs = 25_000) {
    const ready = this.since(sinceSeq);
    if (ready.length) return Promise.resolve(ready);

    return new Promise((resolve) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(this.since(sinceSeq));
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve([]);
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  #wake() {
    for (const waiter of [...this.waiters]) waiter.resolve();
  }

  /** Wake long polls for state carried beside the feed, such as a HUD frame. */
  wake() {
    this.#wake();
  }

  state() {
    return {
      seq: this.seq,
      entries: this.recent(30),
      waiting: this.waiters.size,
    };
  }
}
