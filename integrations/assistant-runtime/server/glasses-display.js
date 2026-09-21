import { createHash } from 'node:crypto';

const MODES = new Set(['grid', 'overlay', 'log', 'confirmation', 'activity', 'idle']);
const SLOT_KINDS = new Set(['text', 'camera']);
const REPORTER_KINDS = new Set(['g2', 'simulator']);

/**
 * The latest display state positively acknowledged by a running G2 app.
 *
 * This is deliberately separate from Hud. Hud is what Carvis wants drawn;
 * this object is what the glasses say they actually finished drawing. It is
 * runtime-only: after a server restart the honest answer is "not reported
 * yet", rather than replaying an old display snapshot as though it were live.
 */
export class GlassesDisplay {
  constructor({ now = () => Date.now(), staleAfterMs = 35_000, onChange = () => {} } = {}) {
    this.now = now;
    this.staleAfterMs = staleAfterMs;
    this.onChange = onChange;
    this.current = null;
    this.lastSeen = 0;
    this.frames = new Map();
  }

  report(input) {
    const next = normalizeReport(input);
    const receivedAt = this.now();

    const decision = this.#reportDecision(next, receivedAt);
    if (decision.accepted) {
      const previous = this.current?.sessionId === next.sessionId ? this.current : null;
      const slots = next.slots.map((slot, index) => this.#materializeSlot(slot, previous?.slots[index]));
      this.current = { ...next, slots, receivedAt };
      this.lastSeen = receivedAt;
    } else if (decision.refreshesCurrentLiveness) {
      // A retry from the currently visible G2 proves it is still connected,
      // but it must never roll the confirmed screen backward.
      this.lastSeen = receivedAt;
    }

    const state = this.state();
    this.onChange(state);
    return { accepted: decision.accepted, state };
  }

  #reportDecision(next, receivedAt) {
    const current = this.current;
    if (!current) return { accepted: true, refreshesCurrentLiveness: false };

    if (current.clientId === next.clientId) {
      if (current.sessionId === next.sessionId) {
        return next.seq > current.seq
          ? { accepted: true, refreshesCurrentLiveness: false }
          : { accepted: false, refreshesCurrentLiveness: true };
      }
      // A background/foreground migration gets a new session. Its creation
      // time lets us ignore late reports from the WebView it replaced.
      if (next.sessionStartedAt < current.sessionStartedAt) {
        return { accepted: false, refreshesCurrentLiveness: false };
      }
      return { accepted: true, refreshesCurrentLiveness: false };
    }

    const currentLive = current.active && receivedAt - this.lastSeen <= this.staleAfterMs;
    const nextHigherPriority = reporterPriority(next.clientKind) > reporterPriority(current.clientKind);
    // Do not let a concurrent simulator (or a second device) rewrite the
    // physical G2's mirror while it is still reporting. A real G2 may take
    // over a simulator immediately; any reporter may take over a stale page.
    if (currentLive && !nextHigherPriority) return { accepted: false, refreshesCurrentLiveness: false };
    return { accepted: true, refreshesCurrentLiveness: false };
  }

  frame(id) {
    return this.frames.get(String(id || '')) || null;
  }

  state() {
    if (!this.current) {
      return {
        connection: 'never',
        connected: false,
        active: false,
        lastSeen: null,
        ageMs: null,
        staleAfterMs: this.staleAfterMs,
        display: null,
      };
    }

    const ageMs = Math.max(0, this.now() - this.lastSeen);
    const connection = !this.current.active
      ? 'inactive'
      : ageMs > this.staleAfterMs
        ? 'stale'
        : 'live';

    return {
      connection,
      connected: connection === 'live',
      active: this.current.active,
      lastSeen: this.lastSeen,
      ageMs,
      staleAfterMs: this.staleAfterMs,
      display: {
        sessionId: this.current.sessionId,
        clientId: this.current.clientId,
        clientKind: this.current.clientKind,
        sessionStartedAt: this.current.sessionStartedAt,
        seq: this.current.seq,
        renderedAt: this.current.renderedAt,
        receivedAt: this.current.receivedAt,
        mode: this.current.mode,
        indicator: this.current.indicator,
        status: this.current.status,
        body: this.current.body,
        hudRevision: this.current.hudRevision,
        slots: this.current.slots.map((slot) => (slot ? { ...slot } : null)),
      },
    };
  }

  #materializeSlot(slot, previous) {
    if (!slot || slot.kind !== 'camera') return slot;

    let frameId = '';
    if (slot.frameBase64) {
      const bytes = decodePng(slot.frameBase64);
      frameId = createHash('sha256')
        .update(slot.entityId)
        .update(String(slot.imageRevision))
        .update(bytes)
        .digest('hex')
        .slice(0, 32);
      this.frames.set(frameId, { bytes, contentType: 'image/png', createdAt: this.now() });
      while (this.frames.size > 32) this.frames.delete(this.frames.keys().next().value);
    } else if (
      previous?.kind === 'camera' &&
      previous.entityId === slot.entityId &&
      previous.imageRevision === slot.imageRevision
    ) {
      frameId = previous.frameId || '';
    }

    const { frameBase64: _privateFrame, ...publicSlot } = slot;
    return { ...publicSlot, frameId };
  }
}

export function normalizeReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('display report must be an object');
  }

  const sessionId = clipped(input.sessionId, 100).trim();
  if (!sessionId) throw new Error('display report needs a sessionId');

  const clientId = clipped(input.clientId, 100).trim() || `legacy:${sessionId}`;
  const clientKind = REPORTER_KINDS.has(input.clientKind) ? input.clientKind : 'g2';

  const seq = integer(input.seq, 'seq');
  if (seq < 1) throw new Error('display report seq must be positive');

  const mode = clipped(input.mode, 24);
  if (!MODES.has(mode)) throw new Error(`unsupported display mode: ${mode || '(empty)'}`);

  if (!Array.isArray(input.slots) || input.slots.length !== 4) {
    throw new Error('display report must contain exactly four slots');
  }
  const rawSlots = input.slots;
  const slots = Array.from({ length: 4 }, (_, index) => normalizeSlot(rawSlots[index], index + 1));

  return {
    clientId,
    clientKind,
    sessionId,
    sessionStartedAt: finiteTimestamp(input.sessionStartedAt),
    seq,
    active: input.active !== false,
    renderedAt: finiteTimestamp(input.renderedAt),
    mode,
    indicator: typeof input.indicator === 'boolean' ? input.indicator : mode === 'idle' && input.body === '.',
    status: clipped(input.status, 120),
    body: clipped(input.body, 2000),
    hudRevision: Math.max(0, integer(input.hudRevision ?? 0, 'hudRevision')),
    slots,
  };
}

function normalizeSlot(input, fallbackSlot) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('display slot must be an object or null');

  const kind = clipped(input.kind, 16);
  if (!SLOT_KINDS.has(kind)) throw new Error(`unsupported display slot kind: ${kind || '(empty)'}`);

  const slot = integer(input.slot ?? fallbackSlot, 'slot');
  if (slot !== fallbackSlot) throw new Error(`display slot ${fallbackSlot} is out of order`);

  const normalized = {
    slot,
    kind,
    title: clipped(input.title, 100),
    value: clipped(input.value, 500),
  };

  if (kind === 'camera') {
    normalized.entityId = clipped(input.entityId, 160);
    normalized.imageRevision = Math.max(0, integer(input.imageRevision ?? 0, 'imageRevision'));
    normalized.frameBase64 = clipped(input.frameBase64, 200_000);
  }
  return normalized;
}

function clipped(value, max) {
  return String(value ?? '').slice(0, max);
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`display report ${label} must be an integer`);
  return number;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function reporterPriority(kind) {
  // A physical pair is the authoritative screen when it is actively
  // reporting. The simulator remains useful for development, but must never
  // overwrite the user's real glasses simply because it happens to be open.
  return kind === 'g2' ? 2 : 1;
}

function decodePng(base64) {
  if (!base64 || base64.length > 200_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('display camera frame is not valid base64');
  }
  const bytes = Buffer.from(base64, 'base64');
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < png.length || png.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('display camera frame must be a PNG');
  }
  return bytes;
}
