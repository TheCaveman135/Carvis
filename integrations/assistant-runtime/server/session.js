/**
 * Work sessions.
 *
 * A stretch of time in one place doing one thing. It exists so that "what was
 * I doing?" has an answer that is not reconstructed from raw sensor history
 * every time it is asked, and so that things Carvis learns during a stretch of
 * work can be attached to that stretch rather than floating free.
 *
 * Sessions are inferred, not declared, so everything here carries a confidence
 * and the project guess is explicitly a guess. Carvis is told which parts are
 * observed and which are inferred, because acting on "you were working on the
 * current project" when that was a coin flip is worse than saying you are not sure.
 */
import { randomUUID } from 'node:crypto';

import { log } from './log.js';

export class Sessions {
  constructor({ getConfig, bus, worldState, atlas }) {
    this.getConfig = getConfig;
    this.bus = bus;
    this.worldState = worldState;
    this.atlas = atlas;

    this.current = null;
    this.past = [];
    this.timer = null;
  }

  start() {
    this.bus.subscribe('presence.*.entered', (event) => this.#onPresence(event));
    // Ending a session is the absence of events, so it needs a clock.
    this.timer = setInterval(() => this.#checkIdle(), 60_000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  get enabled() {
    return this.getConfig().sessions?.enabled !== false;
  }

  #onPresence(event) {
    if (!this.enabled) return;
    const area = event.data?.area;
    if (!area) return;

    if (this.current && this.current.area === area) {
      this.current.lastSeenAt = Date.now();
      this.current.events++;
      return;
    }
    // Moving rooms ends one session and starts another: the location is most
    // of what a session is.
    if (this.current) this.#end('moved to another room');
    this.#begin(area);
  }

  #begin(area) {
    this.current = {
      id: `session_${randomUUID().slice(0, 8)}`,
      area,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
      events: 1,
      notes: [],
      project: null,
    };
    log('info', `Session started in ${area}`);
    this.bus.publish('session.started', 'carvis', { session_id: this.current.id, area });
  }

  #checkIdle() {
    if (!this.current) return;
    const idleFor = Date.now() - this.current.lastSeenAt;
    const limit = (this.getConfig().sessions?.idleMinutes ?? 20) * 60_000;
    if (idleFor > limit) this.#end('room went quiet');
  }

  #end(why) {
    const session = this.current;
    if (!session) return;
    this.current = null;
    session.endedAt = Date.now();
    session.endedBecause = why;
    session.minutes = Math.round((session.endedAt - session.startedAt) / 60_000);

    // A minute in a hallway is not a work session, and recording it as one
    // would make "what was I doing" useless.
    const minimum = this.getConfig().sessions?.minMinutes ?? 5;
    if (session.minutes < minimum) return;

    this.past.push(session);
    if (this.past.length > 20) this.past.shift();
    log('info', `Session ended in ${session.area} after ${session.minutes}m — ${why}`);
    this.bus.publish('session.ended', 'carvis', {
      session_id: session.id,
      area: session.area,
      minutes: session.minutes,
      project: session.project,
    });
  }

  /** Something Carvis learned while this session was running. */
  note(text) {
    if (!this.current) return;
    this.current.notes.push({ text: String(text).slice(0, 300), at: Date.now() });
    if (this.current.notes.length > 20) this.current.notes.shift();
  }

  /**
   * Best guess at what is being worked on: the project whose words best match
   * what has been said this session. Returned with the score so the caller can
   * see how much to trust it.
   */
  guessProject() {
    if (!this.current || !this.current.notes.length) return null;
    const said = this.current.notes.map((n) => n.text).join(' ');
    const hits = this.atlas.retrieve({ query: said, limit: 1 });
    if (!hits.length) return null;
    const best = hits[0];
    this.current.project = { id: best.id, title: best.title, confidence: Math.min(0.95, best.score / 8) };
    return this.current.project;
  }

  contextLines() {
    if (!this.current) return '';
    const minutes = Math.round((Date.now() - this.current.startedAt) / 60_000);
    const lines = ['=== THIS SESSION ==='];
    lines.push(`In ${this.current.area} for ${minutes}m.`);
    const project = this.current.project || this.guessProject();
    if (project) {
      lines.push(
        `Probably working on: ${project.title} (${Math.round(project.confidence * 100)}% — inferred from what was said, not confirmed)`,
      );
    }
    if (this.current.notes.length) {
      lines.push('Said this session:');
      for (const note of this.current.notes.slice(-4)) lines.push(`- ${note.text}`);
    }
    return lines.join('\n');
  }

  state() {
    return {
      enabled: this.enabled,
      current: this.current
        ? {
            ...this.current,
            minutes: Math.round((Date.now() - this.current.startedAt) / 60_000),
          }
        : null,
      past: this.past.slice(-5).reverse(),
    };
  }
}
