import { DISPLAY, SETTINGS_REVISION, STORAGE_KEYS } from './config';
import type { Confirmation, FeedEntry, HudState } from './client';

export type ConnectionSettings = { baseUrl: string; token: string; revision: string; clientId: string };

export function createRuntimeState() {
  return {
    muted: true,
    seq: 0,
    entries: [] as FeedEntry[],
    hud: { revision: 0, slots: [null, null, null, null], overlay: null, free: 4 } as HudState,
    /** Set while an utterance is in flight, so the status can say so. */
    busy: false,
    lastError: '',
    connected: false,
    /** Phone panel only: when the feed last answered, and when it next retries. */
    lastPollAt: 0,
    nextRetryAt: 0,
    confirmation: null as Confirmation | null,
    confirmationBusy: false,
    indicator: 'muted' as 'muted' | 'unmuted' | 'off',
  };
}

type RuntimeState = ReturnType<typeof createRuntimeState>;

const BACKGROUND_STATE_KEY = STORAGE_KEYS.runtimeState;
type BackgroundSnapshot = {
  muted: boolean;
  seq: number;
  entries: FeedEntry[];
  hud: HudState;
  lastError: string;
  confirmation: Confirmation | null;
  indicator: 'muted' | 'unmuted' | 'off';
  connection: ConnectionSettings | null;
};

declare global {
  interface Window {
    /** Even Hub reads this before moving the plugin into its headless WebView. */
    __getStateSnapshot?: () => string;
    /** Even Hub calls this after loading that WebView or restoring foreground. */
    __restoreState?: (snapshot: unknown) => void;
  }
}

/** Owns host snapshots and storage fallback without reviving pending work. */
export class BackgroundState {
  private readonly state: RuntimeState;
  connection: ConnectionSettings | null = null;
  // A host snapshot takes precedence over the older storage fallback.
  hostRestored = false;
  onHostRestored: (() => void) | null = null;

  constructor(state: RuntimeState) {
    this.state = state;
  }

  snapshot(): BackgroundSnapshot {
    return {
      muted: this.state.muted,
      seq: this.state.seq,
      entries: this.state.entries.slice(-DISPLAY.maxLines * 4),
      hud: this.state.hud,
      lastError: this.state.lastError.slice(0, 300),
      confirmation: this.state.confirmation,
      indicator: this.state.indicator,
      connection: this.connection,
    };
  }

  restoreFromStorage(input: unknown): boolean {
    return this.hostRestored ? false : this.restore(input);
  }

  /** Restore only data this app itself wrote; connection/bridge state is rebuilt. */
  restore(input: unknown): boolean {
    const parsed = parseBackgroundInput(input);
    const root = objectRecord(parsed);
    if (!root) return false;
    const nested = objectRecord(root[BACKGROUND_STATE_KEY]);
    const snapshot = nested || root;
    let restored = false;

    if (typeof snapshot.muted === 'boolean') {
      this.state.muted = snapshot.muted;
      restored = true;
    }
    if (Number.isSafeInteger(snapshot.seq) && Number(snapshot.seq) >= 0) {
      this.state.seq = Number(snapshot.seq);
      restored = true;
    }
    if (Array.isArray(snapshot.entries)) {
      this.state.entries = snapshot.entries.filter(isFeedEntry).slice(-DISPLAY.maxLines * 4);
      restored = true;
    }
    if (isHudState(snapshot.hud)) {
      this.state.hud = snapshot.hud;
      restored = true;
    }
    if (typeof snapshot.lastError === 'string') this.state.lastError = snapshot.lastError.slice(0, 300);
    if (isConfirmation(snapshot.confirmation) && snapshot.confirmation.expiresAt > Date.now()) {
      this.state.confirmation = snapshot.confirmation;
    } else if (snapshot.confirmation === null || snapshot.confirmation !== undefined) {
      // A confirmation is intentionally one-shot and short-lived. Never bring
      // a stale full-screen prompt back from a suspended WebView.
      this.state.confirmation = null;
    }
    if (['muted', 'unmuted', 'off'].includes(String(snapshot.indicator))) this.state.indicator = snapshot.indicator as typeof this.state.indicator;
    const connection = objectRecord(snapshot.connection);
    if (connection && typeof connection.baseUrl === 'string' && typeof connection.token === 'string' && connection.revision === SETTINGS_REVISION && typeof connection.clientId === 'string') {
      this.connection = connection as ConnectionSettings;
    }

    // Never revive an old network request or a half-completed gesture.
    this.state.connected = false;
    this.state.busy = false;
    this.state.confirmationBusy = false;
    this.state.lastPollAt = 0;
    this.state.nextRetryAt = 0;
    return restored;
  }

  /**
   * Even Hub's background host looks for these functions directly. The SDK
   * version on current G2 builds does not export helpers for them, so define the
   * documented host contract ourselves at module load — before any lifecycle
   * event can arrive.
   */
  installHostHooks(host: Window | undefined = typeof window === 'undefined' ? undefined : window): void {
    if (!host) return;
    host.__getStateSnapshot = () => JSON.stringify({ [BACKGROUND_STATE_KEY]: this.snapshot() });
    host.__restoreState = (snapshot) => {
      if (this.restore(snapshot)) {
        this.hostRestored = true;
        console.log('CARVIS_RESUME restored background state');
        this.onHostRestored?.();
      }
    };
  }
}

function parseBackgroundInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function objectRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function isFeedEntry(input: unknown): input is FeedEntry {
  const entry = objectRecord(input);
  return Boolean(
    entry &&
      typeof entry.id === 'string' &&
      Number.isFinite(entry.seq) &&
      Number.isFinite(entry.ts) &&
      typeof entry.kind === 'string' &&
      typeof entry.text === 'string' &&
      typeof entry.detail === 'string',
  );
}

function isHudState(input: unknown): input is HudState {
  const hud = objectRecord(input);
  return Boolean(
    hud &&
      Number.isFinite(hud.revision) &&
      Array.isArray(hud.slots) &&
      hud.slots.length === 4 &&
      Number.isFinite(hud.free),
  );
}

function isConfirmation(input: unknown): input is Confirmation {
  const confirmation = objectRecord(input);
  return Boolean(
    confirmation &&
      typeof confirmation.id === 'string' &&
      typeof confirmation.prompt === 'string' &&
      typeof confirmation.detail === 'string' &&
      Number.isFinite(confirmation.createdAt) &&
      Number.isFinite(confirmation.expiresAt),
  );
}
