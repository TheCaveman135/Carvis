/**
 * Physical Carvis core / dock protocol.
 *
 * The portable body is deliberately not modelled as a Home Assistant entity.
 * It is a trusted Carvis peripheral that identifies the dock it is sitting in
 * and polls for small commands. Audio stays local to the core: the server
 * sends text to speak, and future firmware chooses its own TTS/playback stack.
 *
 * This gives every dock the same contract today:
 *   core -> report { core_id, dock: { id, name, capabilities } }
 *   core <- commands { type: 'speak', text }
 *
 * Dock-specific capabilities (OBD, GPS, stereo, bench power) are declared
 * now, but no vehicle or hardware control path is created by declaring one.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_TEXT = 500;
const MAX_COMMANDS = 100;
const MAX_CAPABILITIES = 24;

function text(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function publicCore(core, now, staleAfterMs) {
  if (!core) return null;
  return {
    id: core.id,
    connected: now - core.lastSeenAt <= staleAfterMs,
    lastSeenAt: core.lastSeenAt,
    ageMs: Math.max(0, now - core.lastSeenAt),
    dock: core.dock,
  };
}

export class PhysicalCarvis {
  constructor({ getConfig, onChange = () => {}, now = () => Date.now() }) {
    this.getConfig = getConfig;
    this.onChange = onChange;
    this.now = now;
    this.cores = new Map();
    this.commands = new Map();
    this.sequence = 0;
  }

  isAuthorised(req) {
    const configured = this.getConfig().physicalCarvis?.deviceToken || '';
    const header = String(req?.headers?.authorization || '');
    const supplied = header.replace(/^Bearer\s+/i, '').trim() || String(req?.headers?.['x-carvis-core-token'] || '').trim();
    return sameSecret(supplied, configured);
  }

  report({ core_id, dock = {} } = {}) {
    const id = text(core_id, 80);
    if (!id) throw new Error('core_id is required');
    const capabilities = Array.isArray(dock.capabilities)
      ? [...new Set(dock.capabilities.map((item) => text(item, 48)).filter(Boolean))].slice(0, MAX_CAPABILITIES)
      : [];
    const normalizedDock = {
      id: text(dock.id, 80) || 'undocked',
      name: text(dock.name, 120) || 'Undocked',
      capabilities,
    };
    const core = { id, dock: normalizedDock, lastSeenAt: this.now() };
    this.cores.set(id, core);
    if (!this.commands.has(id)) this.commands.set(id, []);
    this.#changed();
    return publicCore(core, this.now(), this.#staleAfterMs());
  }

  activeSpeaker() {
    const now = this.now();
    const staleAfterMs = this.#staleAfterMs();
    return [...this.cores.values()]
      .filter((core) => now - core.lastSeenAt <= staleAfterMs)
      .find((core) => core.dock.capabilities.includes('speaker')) || null;
  }

  enqueueSpeak(textToSpeak, { source = 'carvis' } = {}) {
    const core = this.activeSpeaker();
    const body = text(textToSpeak, MAX_TEXT);
    if (!core || !body) return null;
    const command = {
      id: `corecmd_${randomUUID().slice(0, 12)}`,
      seq: ++this.sequence,
      type: 'speak',
      text: body,
      source: text(source, 80) || 'carvis',
      createdAt: this.now(),
    };
    const queue = this.commands.get(core.id) || [];
    queue.push(command);
    if (queue.length > MAX_COMMANDS) queue.splice(0, queue.length - MAX_COMMANDS);
    this.commands.set(core.id, queue);
    this.#changed();
    return { core: publicCore(core, this.now(), this.#staleAfterMs()), command };
  }

  pending(coreId, after = 0) {
    const id = text(coreId, 80);
    const core = this.cores.get(id);
    if (!core) throw new Error('core has not reported yet');
    core.lastSeenAt = this.now();
    const commands = (this.commands.get(id) || []).filter((command) => command.seq > Number(after || 0));
    this.#changed();
    return { commands, seq: this.sequence };
  }

  acknowledge(coreId, commandId, { ok = true, detail = '' } = {}) {
    const id = text(coreId, 80);
    const command = text(commandId, 80);
    const queue = this.commands.get(id);
    if (!queue) throw new Error('core has not reported yet');
    const index = queue.findIndex((item) => item.id === command);
    if (index < 0) return null;
    const [acknowledged] = queue.splice(index, 1);
    this.commands.set(id, queue);
    this.#changed();
    return { id: acknowledged.id, seq: acknowledged.seq, ok: Boolean(ok), detail: text(detail, 240) };
  }

  state() {
    const now = this.now();
    const staleAfterMs = this.#staleAfterMs();
    const cores = [...this.cores.values()].map((core) => publicCore(core, now, staleAfterMs));
    const active = this.activeSpeaker();
    return {
      paired: Boolean(this.getConfig().physicalCarvis?.deviceToken),
      activeSpeaker: active ? publicCore(active, now, staleAfterMs) : null,
      cores,
    };
  }

  #staleAfterMs() {
    const seconds = Number(this.getConfig().physicalCarvis?.staleAfterSec || 20);
    return Math.max(5, Math.min(300, Number.isFinite(seconds) ? seconds : 20)) * 1_000;
  }

  #changed() {
    this.onChange(this.state());
  }
}
