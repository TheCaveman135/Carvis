/**
 * Mac command dispatch.
 *
 * Carvis does no agent work on the Mac. It decides that you asked for
 * something on the machine, turns that into one intent — "open Fusion 360" —
 * and hands it over. Your Mac agent owns everything after that: how to do it,
 * whether it needs confirmation, what it opens.
 *
 * That boundary is deliberate. Carvis has a microphone on your face and a
 * bearer token; it should not also have a shell.
 *
 * Two ways to deliver, set by `mac.deliver`:
 *
 *   queue  Your agent polls  GET /api/mac/pending  and reports back with
 *          POST /api/mac/ack {id, ok, detail}. Nothing needs to listen on a
 *          port, which is why it is the default.
 *   push   Carvis POSTs each intent to `mac.pushUrl` with a bearer token.
 *   both   Push, and leave it queued so a missed push is still collected.
 *
 * The wire shape either way:
 *   { id, command, detail, source, ts }
 */
import { randomUUID } from 'node:crypto';

import { log, broadcast } from './log.js';

export class MacBridge {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.queue = []; // pending intents, oldest first
    this.history = []; // dispatched intents with their outcome
    this.lastPollAt = 0;
  }

  get enabled() {
    return Boolean(this.getConfig().mac?.enabled);
  }

  /**
   * Queue (and optionally push) one intent. `command` is the imperative you
   * said — "open Fusion 360", "start the print" — left as prose on purpose,
   * because the Mac agent is the thing that understands the Mac, not Carvis.
   */
  async dispatch({ command, detail = '', source = 'voice' }) {
    const cfg = this.getConfig();
    if (!this.enabled) throw new Error('Mac dispatch is switched off in Settings');

    const text = String(command || '').trim();
    if (!text) throw new Error('empty command');

    const intent = {
      id: randomUUID(),
      command: text.slice(0, 500),
      detail: String(detail || '').slice(0, 1000),
      source,
      ts: Date.now(),
      status: 'pending',
      result: '',
    };

    if (cfg.mac.deliver === 'queue' || cfg.mac.deliver === 'both') {
      this.queue.push(intent);
      // A queue nobody is draining is a memory leak with extra steps.
      if (this.queue.length > cfg.mac.queueMax) this.queue.splice(0, this.queue.length - cfg.mac.queueMax);
    }

    if (cfg.mac.deliver === 'push' || cfg.mac.deliver === 'both') {
      try {
        await this.#push(cfg, intent);
        if (cfg.mac.deliver === 'push') intent.status = 'sent';
      } catch (err) {
        intent.status = cfg.mac.deliver === 'push' ? 'failed' : 'pending';
        intent.result = err.message;
        log('warn', `Mac push failed (${err.message})${cfg.mac.deliver === 'both' ? ' — still queued' : ''}`);
      }
    }

    this.#remember(intent);
    log('action', `Mac: ${intent.command}`);
    broadcast({ type: 'mac', intent });
    return intent;
  }

  async #push(cfg, intent) {
    if (!cfg.mac.pushUrl) throw new Error('no push URL configured');
    const res = await fetch(cfg.mac.pushUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.mac.pushToken ? { Authorization: `Bearer ${cfg.mac.pushToken}` } : {}),
      },
      body: JSON.stringify(intent),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  /** Everything queued, handed to the poller and cleared. */
  claimPending() {
    this.lastPollAt = Date.now();
    const claimed = this.queue.splice(0, this.queue.length);
    for (const intent of claimed) {
      intent.status = 'sent';
      broadcast({ type: 'mac', intent });
    }
    return claimed;
  }

  /** The Mac agent reporting what happened, so the glasses can show it. */
  acknowledge(id, ok, detail = '') {
    const intent = this.history.find((i) => i.id === id);
    if (!intent) return null;
    intent.status = ok ? 'done' : 'failed';
    intent.result = String(detail || '').slice(0, 500);
    intent.completedAt = Date.now();
    log(ok ? 'info' : 'error', `Mac: ${intent.command} — ${ok ? 'done' : 'failed'}${detail ? `: ${detail}` : ''}`);
    broadcast({ type: 'mac', intent });
    return intent;
  }

  #remember(intent) {
    this.history.push(intent);
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
  }

  state() {
    const cfg = this.getConfig();
    return {
      enabled: this.enabled,
      deliver: cfg.mac?.deliver,
      pushConfigured: Boolean(cfg.mac?.pushUrl),
      pending: this.queue.length,
      lastPollAt: this.lastPollAt,
      // "Never polled" and "polled a while ago" are different problems.
      agentSeen: this.lastPollAt > 0,
      recent: this.history.slice(-20).reverse(),
    };
  }
}
