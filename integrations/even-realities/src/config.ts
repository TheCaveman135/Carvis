/**
 * Where Carvis lives, and how loud counts as speech.
 *
 * The base URL must also appear in app.json's network whitelist — the Even app
 * blocks anything else, and it fails as a network error rather than as
 * something that says "not whitelisted", so it is worth checking there first
 * when nothing is reaching your server.
 */
export const DEFAULTS = {
  /** Overridden at runtime by whatever is in SDK local storage. */
  baseUrl: '',
  /** Pairing token from the Even Realities integration. Always required. */
  token: '',
};

/**
 * Increment this only when the built-in connection settings change. Older
 * builds may have persisted a LAN or loopback URL, and SDK storage survives an
 * app upgrade. A revision lets the new build migrate those stale defaults once
 * without overwriting a later user override on every launch.
 */
export const SETTINGS_REVISION = 'public-full-v1';

export const STORAGE_KEYS = {
  baseUrl: 'carvis.public.full.baseUrl',
  token: 'carvis.public.full.token',
  settingsRevision: 'carvis.public.full.settingsRevision',
  /** Mute is purely a G2-side preference — Carvis is never told. */
  muted: 'carvis.public.full.muted',
  /**
   * A small resume snapshot. Even Hub's background handoff normally injects
   * this state directly; SDK storage is the fallback for host versions that
   * destroy the WebView before the handoff callback can run.
   */
  runtimeState: 'carvis.public.full.runtimeState.v1',
  /** Stable per-installation reporter identity for the server's actual-G2 mirror. */
  displayClientId: 'carvis.public.full.displayClientId.v1',
};

export const AUDIO = {
  sampleRate: 16000,
  /**
   * RMS above this counts as speech. 16-bit samples run to 32767; a quiet room
   * sits near 200-400, ordinary speech well above 1200. Too low and every
   * fridge hum becomes an utterance Carvis has to think about.
   */
  speechRms: 900,
  /** Silence this long ends an utterance and sends it. */
  trailingSilenceMs: 900,
  /** Ignore blips this short — a cough, a door, a consonant on its own. */
  minUtteranceMs: 400,
  /**
   * Hard cap. Whisper handles 30s but you should not wait that long to find
   * out Carvis heard you, and the server rejects anything longer.
   */
  maxUtteranceMs: 15000,
  /**
   * Audio kept from just before the threshold was crossed. Without it every
   * utterance loses its first syllable, which is exactly where the wake word is.
   */
  preRollMs: 300,
};

export const DISPLAY = {
  width: 576,
  height: 288,
  // 2 lines at the firmware's fixed 27px line height (see
  // @evenrealities/pretext), plus the status strip's own padding on top and
  // bottom. It was 30 before — less than a single line once padding is
  // subtracted — so any reply that wrapped at all had its second line
  // clipped by the container, not just the text.
  statusHeight: 58,
  statusPadding: 2,
  statusMaxLines: 2,
  /** Feed lines that fit under the status bar without overflowing. */
  maxLines: 7,
  /** Characters per line before the firmware wraps for us. */
  wrapAt: 62,
};
