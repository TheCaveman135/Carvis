import {WidgetFocus} from './interaction';
import { installForegroundRecovery } from './foreground-recovery';
import { hostLifecycleAction } from './lifecycle';
/**
 * Carvis on the G2.
 *
 * Listens continuously, cuts what it hears into utterances, sends those to
 * your Carvis server, and shows what came back. It deliberately shows very
 * little: actions Carvis carried out, replies to things you actually asked,
 * and notes it filed. Most of what the microphone hears is never mentioned,
 * because most of it is you talking to someone else.
 *
 * Controls
 *   swipe up/down  select a widget, adjust a value, or answer a confirmation
 *   single press   activate/edit/apply; mute / unmute when no widget is selected
 *   double press   deselect without removing widgets
 *   app menu       clear screen; system Close remains available
 */
import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk';

import { AUDIO, DEFAULTS, DISPLAY, SETTINGS_REVISION, STORAGE_KEYS } from './config';
import {
  CarvisClient,
  type Confirmation,
  type DisplayReport,
  type FeedEntry,
  type HudState,
  type IngestResult,
} from './client';
import { Display } from './display';
import { Panel } from './panel';
import { Captions } from './captions';
import { PhoneAudio } from './phone-audio';
import { UtteranceDetector } from './vad';

const state = {
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
const captions = new Captions();
const widgetFocus = new WidgetFocus();
const bootAt = Date.now();
type ConnectionSettings = {baseUrl: string; token: string; revision: string; clientId: string};
let connectionSettings: ConnectionSettings | null = null;

const BACKGROUND_STATE_KEY = 'carvis.public.full.runtimeState.v1';
// The host snapshot is newer than the storage fallback whenever both arrive.
// It can be delivered before the bridge (or after the UI) exists, so keep a
// tiny hand-off rather than letting one path overwrite the other.
let hostStateRestored = false;
let onHostStateRestored: (() => void) | null = null;

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

function backgroundSnapshot(): BackgroundSnapshot {
  return {
    muted: state.muted,
    seq: state.seq,
    entries: state.entries.slice(-DISPLAY.maxLines * 4),
    hud: state.hud,
    lastError: state.lastError.slice(0, 300),
    confirmation: state.confirmation,
    indicator: state.indicator,
    connection: connectionSettings,
  };
}

/** Restore only data this app itself wrote; connection/bridge state is rebuilt. */
function restoreBackgroundState(input: unknown): boolean {
  const parsed = parseBackgroundInput(input);
  const root = objectRecord(parsed);
  if (!root) return false;
  const nested = objectRecord(root[BACKGROUND_STATE_KEY]);
  const snapshot = nested || root;
  let restored = false;

  if (typeof snapshot.muted === 'boolean') {
    state.muted = snapshot.muted;
    restored = true;
  }
  if (Number.isSafeInteger(snapshot.seq) && Number(snapshot.seq) >= 0) {
    state.seq = Number(snapshot.seq);
    restored = true;
  }
  if (Array.isArray(snapshot.entries)) {
    state.entries = snapshot.entries.filter(isFeedEntry).slice(-DISPLAY.maxLines * 4);
    restored = true;
  }
  if (isHudState(snapshot.hud)) {
    state.hud = snapshot.hud;
    restored = true;
  }
  if (typeof snapshot.lastError === 'string') state.lastError = snapshot.lastError.slice(0, 300);
  if (isConfirmation(snapshot.confirmation) && snapshot.confirmation.expiresAt > Date.now()) {
    state.confirmation = snapshot.confirmation;
  } else if (snapshot.confirmation === null || snapshot.confirmation !== undefined) {
    // A confirmation is intentionally one-shot and short-lived. Never bring
    // a stale full-screen prompt back from a suspended WebView.
    state.confirmation = null;
  }
  if (['muted', 'unmuted', 'off'].includes(String(snapshot.indicator))) state.indicator = snapshot.indicator as typeof state.indicator;
  const connection = objectRecord(snapshot.connection);
  if (connection && typeof connection.baseUrl === 'string' && typeof connection.token === 'string' && connection.revision === SETTINGS_REVISION && typeof connection.clientId === 'string') {
    connectionSettings = connection as ConnectionSettings;
  }

  // Never revive an old network request or a half-completed gesture.
  state.connected = false;
  state.busy = false;
  state.confirmationBusy = false;
  state.lastPollAt = 0;
  state.nextRetryAt = 0;
  return restored;
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

/**
 * Even Hub's background host looks for these functions directly. The SDK
 * version on current G2 builds does not export helpers for them, so define the
 * documented host contract ourselves at module load — before any lifecycle
 * event can arrive.
 */
function installBackgroundStateHooks(): void {
  if (typeof window === 'undefined') return;
  window.__getStateSnapshot = () => JSON.stringify({ [BACKGROUND_STATE_KEY]: backgroundSnapshot() });
  window.__restoreState = (snapshot) => {
    if (restoreBackgroundState(snapshot)) {
      hostStateRestored = true;
      console.log('CARVIS_RESUME restored background state');
      onHostStateRestored?.();
    }
  };
}

installBackgroundStateHooks();

/**
 * A lifecycle transition intentionally drops work that has not reached the
 * glasses yet. Treating that as an ordinary render failure makes the log noisy
 * and, worse, encourages a later callback to wake the display while the app is
 * backgrounded.
 */
class LifecyclePausedError extends Error {
  constructor() {
    super('Carvis is backgrounded');
    this.name = 'LifecyclePausedError';
  }
}

function isLifecyclePausedError(error: unknown): boolean {
  return error instanceof LifecyclePausedError;
}

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  console.log('CARVIS_BOOT bridge ready');

  // Every async bridge operation shares a single BLE command channel. Keeping
  // storage/audio/display calls in one queue prevents a background save from
  // interrupting a page rebuild or an image transfer.
  //
  // BRIDGE_CALL_TIMEOUT_MS exists because a *rejected* bridge call and a
  // *hung* one are very different failures here, and only one of them was
  // handled. A rejection surfaces as a thrown error render() can catch and
  // recover from. A promise that never settles does not — it just sits at
  // the head of bridgeTail forever, and every later call (storage, audio,
  // every future display write) queues up behind it and never runs either,
  // with nothing ever thrown to explain why. That is a stronger match for
  // "the app is frozen" than a rejection would be, and shutDownPageContainer
  // is a plausible place for it: if its promise is designed to resolve only
  // once the dialog is answered, and answering "no" does not signal back to
  // JS at all (only "yes" does, since only "yes" leads to real shutdown),
  // the call would hang for exactly as long as this bug has been reported.
  // Timing the JS-side wait out does not dismiss a still-open native dialog
  // — it only stops that one pending call from blocking everything else the
  // app needs to keep doing.
  const BRIDGE_CALL_TIMEOUT_MS = 10_000;
  let runtimeActive = true;
  /** A native dialog covered the phone panel; it did not end Carvis. */
  let runtimeCovered = false;
  let disposed = false;
  let bridgeTail: Promise<void> = Promise.resolve();
  const runBridge = <T>(
    operation: () => Promise<T>,
    options: { allowWhileInactive?: boolean } = {},
  ): Promise<T> => {
    const guarded = async () => {
      if (disposed || (!runtimeActive && !options.allowWhileInactive)) {
        throw new LifecyclePausedError();
      }
      return withDeadline(operation(), BRIDGE_CALL_TIMEOUT_MS, 'bridge call');
    };
    const next = bridgeTail.then(guarded, guarded);
    bridgeTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // Make the page available immediately. The normal restart then needs one
  // SDK read, rather than six reads plus migration writes before connecting.
  const display = new Display(bridge, runBridge);
  const created = await display.start();
  if (created !== 0) throw new Error(`Could not create glasses page (${created})`);
  const storedRuntimeState = await runBridge(() => bridge.getLocalStorage(STORAGE_KEYS.runtimeState));
  if (!hostStateRestored) restoreBackgroundState(storedRuntimeState);
  let baseUrl: string;
  let token: string;
  let displayClientId: string;
  if (connectionSettings) {
    ({baseUrl, token, clientId: displayClientId} = connectionSettings);
  } else {
    // One-time migration from older builds. Keep user overrides and mute.
    const storedUrl = await runBridge(() => bridge.getLocalStorage(STORAGE_KEYS.baseUrl));
    const storedToken = await runBridge(() => bridge.getLocalStorage(STORAGE_KEYS.token));
    const storedRevision = await runBridge(() => bridge.getLocalStorage(STORAGE_KEYS.settingsRevision));
    const storedMute = await runBridge(() => bridge.getLocalStorage(STORAGE_KEYS.muted));
    const storedId = await runBridge(() => bridge.getLocalStorage(STORAGE_KEYS.displayClientId));
    baseUrl = storedRevision === SETTINGS_REVISION && storedUrl ? storedUrl : DEFAULTS.baseUrl;
    token = storedRevision === SETTINGS_REVISION && storedToken ? storedToken : DEFAULTS.token;
    if (storedMute === '1' || storedMute === '0') state.muted = storedMute === '1';
    displayClientId = /^[A-Za-z0-9_-]{8,100}$/.test(storedId) ? storedId : newSessionId();
    connectionSettings = {baseUrl, token, revision: SETTINGS_REVISION, clientId: displayClientId};
  }
  const displayClientKind = reporterKind();
  const client = new CarvisClient(baseUrl, token);
  const detector = new UtteranceDetector();
  const displaySessionId = newSessionId();
  const displaySessionStartedAt = Date.now();
  let displayReportSeq = 0;
  let displayActive = true;
  let reportRunning: Promise<void> | null = null;
  let reportQueued = false;
  let reportForceQueued = false;
  let runtimeSaveTimer: number | null = null;
  let runtimeSaveRunning: Promise<void> | null = null;
  let runtimeSaveQueued = false;
  let runtimeSaveForceQueued = false;
  let lastSavedRuntime = '';

  /**
   * Persisting the small JSON snapshot is the one bridge operation allowed
   * during a foreground exit. It is what makes the next foreground WebView
   * resume at the exact same HUD/feed state instead of booting from scratch.
   */
  async function persistRuntimeState(force = false): Promise<void> {
    if (!runtimeActive && !force) return;
    // Capture the latest state even if the bridge is still writing an older
    // snapshot. This is the fallback path when the host has not yet asked for
    // its synchronous background snapshot.
    runtimeSaveQueued = true;
    runtimeSaveForceQueued ||= force;
    if (runtimeSaveRunning) return runtimeSaveRunning;
    runtimeSaveRunning = (async () => {
      while (runtimeSaveQueued) {
        const allowWhileInactive = runtimeSaveForceQueued;
        runtimeSaveQueued = false;
        runtimeSaveForceQueued = false;
        if (!runtimeActive && !allowWhileInactive) continue;
        try {
          const snapshot = JSON.stringify(backgroundSnapshot());
          if (snapshot === lastSavedRuntime) continue;
          await runBridge(
            () => bridge.setLocalStorage(STORAGE_KEYS.runtimeState, snapshot),
            { allowWhileInactive },
          );
          lastSavedRuntime = snapshot;
        } catch (err) {
          if (!isLifecyclePausedError(err)) console.warn('runtime snapshot persist failed', err);
        }
      }
    })().finally(() => {
      runtimeSaveRunning = null;
    });
    return runtimeSaveRunning;
  }

  function scheduleRuntimePersist(): void {
    if (!runtimeActive) return;
    if (runtimeSaveTimer !== null) return;
    runtimeSaveTimer = window.setTimeout(() => {
      runtimeSaveTimer = null;
      void persistRuntimeState();
    }, 250);
  }

  /** Coalesce reports so camera frames never race each other over HTTP. */
  function reportActualDisplay(force = false): Promise<void> {
    if (!client.configured || (!runtimeActive && !force)) return Promise.resolve();
    reportQueued = true;
    reportForceQueued ||= force;
    if (reportRunning) return reportRunning;
    reportRunning = (async () => {
      while (reportQueued) {
        const allowWhileInactive = reportForceQueued;
        reportQueued = false;
        reportForceQueued = false;
        if (!runtimeActive && !allowWhileInactive) continue;
        const report: DisplayReport = {
          ...display.snapshot(),
          clientId: displayClientId,
          clientKind: displayClientKind,
          sessionId: displaySessionId,
          sessionStartedAt: displaySessionStartedAt,
          seq: ++displayReportSeq,
          active: displayActive,
          renderedAt: Date.now(),
        };
        try {
          await client.reportDisplay(report);
        } catch (err) {
          // Telemetry cannot be allowed to block or repaint the G2. If the Mac
          // is unreachable its last confirmed view naturally becomes stale.
          console.warn('display report failed', err);
        }
      }
    })().finally(() => {
      reportRunning = null;
    });
    return reportRunning;
  }

  let audioOn = false;
  let audioGeneration = 0;
  let audioStarting = false;
  let lastAudioAttempt = 0;
  const startAudio = async () => {
    if (!client.configured || state.muted || !runtimeActive || disposed || audioOn || audioStarting) return;
    audioStarting = true;
    lastAudioAttempt = Date.now();
    const generation = audioGeneration;
    try {
      await runBridge(() => bridge.audioControl(true));
      if (generation === audioGeneration && runtimeActive && !disposed && !state.muted) audioOn = true;
      else await runBridge(() => bridge.audioControl(false), {allowWhileInactive: true});
    } catch (err) {
      // A missing simulator audio device must not prevent the HUD and gestures
      // from starting. Real hardware can retry on foreground entry.
      if (!isLifecyclePausedError(err)) console.error('microphone start failed', err);
    } finally { audioStarting = false; }
  };
  const stopAudio = async (allowWhileInactive = false) => {
    audioGeneration++;
    if (!audioOn) {
      detector.reset();
      return;
    }
    try {
      await withDeadline(
        runBridge(() => bridge.audioControl(false), { allowWhileInactive }),
        4000,
        'microphone stop',
      );
      audioOn = false;
    } catch (err) {
      if (!isLifecyclePausedError(err)) console.error('microphone stop failed', err);
    }
    audioOn = false; // A failed stop must not suppress the next microphone start.
    detector.reset();
  };

  // ── phone panel ──────────────────────────────────────────────────
  let currentUrl = baseUrl;
  let currentToken = token;
  let backoffMs = 1000;
  /** Resolves the poll loop's backoff sleep early when Reconnect is pressed. */
  let wakePoll: (() => void) | null = null;
  /** Resolves the poll loop when a foreground transition makes work legal again. */
  let wakeForeground: (() => void) | null = null;
  /** Aborts an in-flight poll, so Reconnect also rescues a stalled request. */
  let pollAbort: AbortController | null = null;
  /** An utterance is no longer useful once the app is backgrounded. */
  let utteranceAbort: AbortController | null = null;
  let reconnectRequested = false;
  let lifecycleTail: Promise<void> = Promise.resolve();

  /** Fire-and-forget bridge work must still consume a lifecycle cancellation. */
  function runBridgeQuietly(operation: () => Promise<unknown>, label: string): void {
    void runBridge(operation).catch((err) => {
      if (!isLifecyclePausedError(err)) console.warn(`${label} failed`, err);
    });
  }

  /** Serialise quick host exit/enter pairs so a late exit cannot undo a resume. */
  function queueLifecycle(operation: () => Promise<void>): Promise<void> {
    const next = lifecycleTail.then(operation, operation);
    lifecycleTail = next.catch((err) => {
      if (!isLifecyclePausedError(err)) console.error('lifecycle transition failed', err);
    });
    return next;
  }

  const removeForegroundRecovery = installForegroundRecovery(window, document, () => {
    if (!disposed && runtimeCovered) void queueLifecycle(resumeRuntime);
  });

  const phoneAudio = new PhoneAudio(client, displayClientId, () => paint());
  const panel = new Panel({
    onIndicator: value => { state.indicator = value; void persistRuntimeState(); paint(); void render(); },
    onSpeaker: value => { void phoneAudio.select(value); },
    onEnablePhoneAudio: () => phoneAudio.enable(),
    onToggleMute: () => void toggleMute(),
    onReconnect: () => {
      if (!runtimeActive) { void queueLifecycle(resumeRuntime); return; }
      reconnectRequested = true;
      backoffMs = 1000;
      state.lastError = '';
      pollAbort?.abort();
      wakePoll?.();
      paint();
    },
    onSave: (url, tokenValue) => {
      if (!runtimeActive) return;
      try { client.configure(url, tokenValue); }
      catch (err) { state.lastError = err instanceof Error ? err.message : String(err); paint(); return; }
      currentUrl = url;
      currentToken = tokenValue;
      connectionSettings = {baseUrl: url, token: tokenValue, revision: SETTINGS_REVISION, clientId: displayClientId};
      scheduleRuntimePersist();
      runBridgeQuietly(() => bridge.setLocalStorage(STORAGE_KEYS.baseUrl, url), 'server URL save');
      runBridgeQuietly(() => bridge.setLocalStorage(STORAGE_KEYS.token, tokenValue), 'server token save');
      runBridgeQuietly(
        () => bridge.setLocalStorage(STORAGE_KEYS.settingsRevision, SETTINGS_REVISION),
        'settings revision save',
      );
      reconnectRequested = true;
      backoffMs = 1000;
      state.lastError = '';
      pollAbort?.abort();
      wakePoll?.();
      paint();
    },
  });

  function paint(): void {
    panel.update({
      connection: state.connected
        ? 'live'
        : !state.lastPollAt && !state.lastError
          ? 'connecting'
          : 'offline',
      baseUrl: currentUrl,
      token: currentToken,
      lastError: state.lastError,
      lastPollAt: state.lastPollAt,
      nextRetryAt: state.nextRetryAt,
      muted: state.muted,
      indicator: state.indicator,
      speechMode: phoneAudio.mode,
      phoneAudioReady: phoneAudio.enabled,
      phoneAudioError: phoneAudio.error,
      busy: state.busy,
      speaking: detector.isSpeaking,
      micOn: audioOn,
      displayActive,
      hudWidgets: state.hud.slots.filter(Boolean).length,
      hudRevision: state.hud.revision,
      cameraError: display.lastCameraError,
      entries: state.entries,
    });
  }

  paint();
  let panelPaintTimer: number | null = null;
  let expiryTimer: number | null = null;

  /** Timers do no useful work while the host has backgrounded this WebView. */
  function startRuntimeTimers(): void {
    if (!runtimeActive) return;
    if (panelPaintTimer === null) {
      // Keeps "last contact" and the retry countdown honest without any traffic.
      panelPaintTimer = window.setInterval(paint, 1000);
    }
    if (expiryTimer === null) {
      // An overlay expiring and the log timing out are both moments where
      // nothing arrives from the server, so a slow tick returns to the HUD.
      // 2s, not 1s: a pending confirmation re-renders every tick to count
      // down, and that write shares the same BLE channel camera frames use —
      // halving the tick rate meaningfully cuts contention for one tick a
      // human can't perceive the difference on anyway.
      expiryTimer = window.setInterval(() => {
        if (!runtimeActive) return;
        if (!audioOn && !audioStarting && Date.now() - lastAudioAttempt >= 5000) void startAudio();
        const overlayDone = state.hud.overlay && Date.now() >= state.hud.overlay.until;
        // Advance captions even when no new server event arrives.
        if (overlayDone || display.snapshot().status.trim() !== statusLine().trim() || state.confirmation || display.currentMode === 'activity') void render();
      }, 2000);
    }
  }

  function stopRuntimeTimers(): void {
    if (panelPaintTimer !== null) {
      window.clearInterval(panelPaintTimer);
      panelPaintTimer = null;
    }
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    if (runtimeSaveTimer !== null) {
      window.clearTimeout(runtimeSaveTimer);
      runtimeSaveTimer = null;
    }
  }

  startRuntimeTimers();

  let widgetBusy=false;
  let nativeMenuActive=false;
  let singlePressTimer:ReturnType<typeof setTimeout>|null=null;
  const cancelPress=()=>{if(singlePressTimer){clearTimeout(singlePressTimer);singlePressTimer=null;}};
  async function pressWidget(){
    if(!runtimeActive||disposed||runtimeCovered||widgetBusy||state.confirmation||state.confirmationBusy)return;
    if(widgetFocus.selected===null){await toggleMute();return;}
    const action=widgetFocus.press(state.hud);void render();if(!action)return;
    widgetBusy=true;
    try{const result=await client.interactWidget(action);if(result.hud)state.hud=result.hud;if(result.confirmation)state.confirmation=result.confirmation;
      if(!result.success&&!result.confirmation)captions.add(result.error || 'Widget action failed.');
      else if(result.dry_run)captions.add('Dry run — no change sent.');
    }catch(error){captions.add(error instanceof Error?error.message:'Widget action failed.');}
    finally{widgetBusy=false;paint();void render();}
  }
  async function clearScreen(){
    cancelPress();widgetFocus.clear();captions.clear();
    try{await client.clearHud();state.hud={...state.hud,slots:[null,null,null,null],overlay:null,free:4};}
    catch(error){captions.add(error instanceof Error?error.message:'Could not clear screen.');}
    void render();
  }

  const unsubscribe = bridge.onEvenHubEvent((rawEvent) => {
    const textType=rawEvent.textEvent?.eventType ?? 0;
    const event=rawEvent.textEvent&&!rawEvent.sysEvent&&(textType===0||textType===3)
      ? {...rawEvent,textEvent:undefined,sysEvent:{eventType:textType}}:rawEvent;
    if(event.menuItemClickEvent?.itemID===1){nativeMenuActive=true;void clearScreen();return;}
    if((event.sysEvent || event.textEvent)?.eventType===9){cancelPress();nativeMenuActive=true;return;}
    if (event.audioEvent?.audioPcm) {
      if (runtimeActive) onAudio(event.audioEvent.audioPcm);
      return;
    }

    if (event.textEvent) {
      if (!runtimeActive) return;
      const type = event.textEvent.eventType ?? 0;
      // The accepted command has already been consumed server-side. Swallow
      // further swipes until it finishes so they cannot open the activity log
      // over the result that is about to appear.
      if (state.confirmationBusy) return;
      if (state.confirmation) {
        if (type === OsEventTypeList.SCROLL_TOP_EVENT) void answerConfirmation(true);
        else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) void answerConfirmation(false);
        return;
      }
      cancelPress();if(widgetBusy)return;
      if(type===OsEventTypeList.SCROLL_TOP_EVENT||type===OsEventTypeList.SCROLL_BOTTOM_EVENT){widgetFocus.swipe(widgetFocus.editing?(type===1?1:-1):(type===1?-1:1),state.hud);void render();}
      return;
    }

    if (event.sysEvent) {
      // Protobuf omits zero values, so a single press arrives as undefined.
      const type = event.sysEvent.eventType ?? 0;
      const lifecycle = hostLifecycleAction(type);
      if (lifecycle === 'resume') {
        cancelPress();
        if (!nativeMenuActive) void queueLifecycle(resumeRuntime);
      } else if (lifecycle === 'cover') {
        if (nativeMenuActive) {
          nativeMenuActive=false;
          cancelPress();
          void render();
          return;
        }
        // iOS sends this for notifications and native menus too. Do not abort
        // audio/polling/display work and wait forever for an enter event that
        // those overlays do not reliably send.
        cancelPress();
        runtimeCovered = true;
        audioGeneration++;
        audioOn = false;
        detector.reset();
      } else if (lifecycle === 'cleanup') {
        void queueLifecycle(cleanUp);
      } else if (!runtimeActive || runtimeCovered) {
        // A routed tap proves the user is back in this app. Consume it as
        // recovery, rather than toggling mute or answering a confirmation.
        if (type === OsEventTypeList.CLICK_EVENT) void queueLifecycle(resumeRuntime);
        return;
      } else if (type === OsEventTypeList.CLICK_EVENT) {
        cancelPress();singlePressTimer=setTimeout(()=>{singlePressTimer=null;void pressWidget();},300);
      } else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        cancelPress();widgetFocus.clear();void render();
      }
    }
  });

  let inFlight: Promise<void> | null = null;

  function onAudio(pcm: Uint8Array): void {
    if (!client.configured) return;
    if (!runtimeActive || state.muted || phoneAudio.speaking) { detector.reset(); return; }
    const utterance = detector.push(pcm);
    if (!utterance) return;
    // One at a time. Overlapping sends would arrive out of order and Carvis
    // would answer your second sentence before your first.
    if (inFlight) return;
    inFlight = send(utterance.pcm).finally(() => {
      inFlight = null;
    });
  }

  async function send(pcm: Uint8Array): Promise<void> {
    if (!runtimeActive) return;
    const controller = new AbortController();
    utteranceAbort = controller;
    state.busy = true;
    paint();
    await render();
    try {
      const result = await client.sendAudio(pcm, controller.signal);
      if (!runtimeActive) return;
      state.lastError = '';
      applyIngestResult(result);
      // The feed poll delivers anything worth showing; nothing to draw here
      // for an utterance Carvis decided was not for it.
      if (result.outcome === 'error' && result.error) state.lastError = result.error;
    } catch (err) {
      if (runtimeActive && !controller.signal.aborted) {
        state.lastError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (utteranceAbort === controller) utteranceAbort = null;
      state.busy = false;
      paint();
      if (runtimeActive) await render();
    }
  }

  function applyIngestResult(result: IngestResult): void {
    if (result.confirmation !== undefined) state.confirmation = result.confirmation;
    if (result.outcome === 'error' && result.error) state.lastError = result.error;
  }

  async function answerConfirmation(accepted: boolean): Promise<void> {
    if (!runtimeActive || !state.confirmation || state.confirmationBusy) return;
    const pending = state.confirmation;
    state.confirmation = null;
    state.confirmationBusy = true;
    await render();
    try {
      const result = await client.resolveConfirmation(pending.id, accepted);
      if (!runtimeActive) return;
      state.lastError = '';
      applyIngestResult(result);
    } catch (err) {
      if (runtimeActive) {
        state.confirmation = pending;
        state.lastError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      state.confirmationBusy = false;
      if (runtimeActive) await render();
    }
  }

  let muteBusy = false;
  async function toggleMute(): Promise<void> {
    // A touchpad bounce firing two CLICK_EVENTs in quick succession would
    // otherwise race two storage writes against each other. Same guard
    // `answerConfirmation` already uses.
    if (!runtimeActive || muteBusy) return;
    if (!client.configured) {
      state.lastError = 'Enter your Carvis address and pairing token before unmuting.';
      paint(); return;
    }
    muteBusy = true;
    state.muted = !state.muted;
    paint();
    await render();
    if (state.muted) await stopAudio();
    else await startAudio();
    try {
      await runBridge(() => bridge.setLocalStorage(STORAGE_KEYS.muted, state.muted ? '1' : '0'));
    } catch (err) {
      // Persistence failing is not worth reverting the tap over — worst case
      // the preference does not survive a relaunch.
      if (!isLifecyclePausedError(err)) console.warn('mute persist failed', err);
    } finally {
      muteBusy = false;
    }
  }

  /** Long-poll the feed forever, backing off when the Carvis server is unreachable. */
  async function pollLoop(): Promise<void> {
    while (!disposed) {
      if (!runtimeActive) {
        await new Promise<void>((resolve) => {
          wakeForeground = resolve;
        });
        continue;
      }
      if (!client.configured) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wakePoll = null; resolve(); }, 1000);
          wakePoll = () => { clearTimeout(timer); wakePoll = null; resolve(); };
        });
        continue;
      }
      try {
        const controller = new AbortController();
        pollAbort = controller;
        const data = await client.pollFeed(state.seq, state.hud.revision, controller.signal, !state.connected);
        if (!runtimeActive || disposed || controller.signal.aborted) continue;
        state.connected = true;
        state.lastError = '';
        state.lastPollAt = Date.now();
        state.nextRetryAt = 0;
        backoffMs = 1000;
        // Adopt the server's seq whenever it's present, not only when there
        // happen to be entries attached. After a server restart the server's
        // own counter resets far below whatever the glasses last remembered
        // (persisted across restarts on this side); every poll's stale,
        // too-high `since` then legitimately returns zero entries, and the
        // one signal that could correct `state.seq` — the server's honest,
        // lower `data.seq` — used to only be read inside this `if`, so it
        // was never adopted and every later reply stayed invisible.
        if (typeof data.seq === 'number') state.seq = data.seq;
        if (data.entries.length) {
          state.entries = [...state.entries, ...data.entries].slice(-DISPLAY.maxLines * 4);
          // Surface Carvis's reply on the glasses without a swipe. Reused,
          // not new plumbing: the server already pushes a 'reply' feed entry
          // for every reply, however it was triggered — voice, a confirmed
          // swipe, even a Web UI request — so this is the one place that
          // needs to notice, not a second delivery path.
          for (const entry of data.entries) {
            if (entry.ts >= bootAt && ['reply', 'action', 'error'].includes(entry.kind)) captions.add(entry.fullText || entry.text);
          }
        }
        if (data.hud) state.hud = data.hud;
        if (data.speech) phoneAudio.syncMode(data.speech.outputMode);
        state.confirmation = data.confirmation ?? null;
        paint();
        void render();
      } catch (err) {
        if (!runtimeActive || disposed) continue;
        // A deliberate Reconnect aborts the request; that is not a failure and
        // must not be shown as one or slow the next attempt down.
        if (reconnectRequested) {
          reconnectRequested = false;
          state.lastError = '';
          paint();
          continue;
        }
        state.connected = false;
        state.lastError = err instanceof Error ? err.message : String(err);
        state.nextRetryAt = Date.now() + backoffMs;
        paint();
        await render();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wakePoll = null;
            resolve();
          }, backoffMs);
          wakePoll = () => {
            clearTimeout(timer);
            wakePoll = null;
            resolve();
          };
        });
        state.nextRetryAt = 0;
        backoffMs = Math.min(backoffMs * 2, 30_000);
      } finally {
        pollAbort = null;
      }
    }
  }

  /**
   * One line, several writers, in a fixed precedence: a pending confirmation
   * always wins (it is the one thing that needs an answer), then a reply
   * still within its window, then ordinary status. Folding the confirmation
   * prompt in here — instead of a full-screen takeover — is deliberate: it
   * means a confirmation no longer hides whatever widgets are already up.
   */
  function statusLine(): string {
    if (state.confirmationBusy) return 'Confirming...';
    if (state.confirmation) {
      // confirmationPrompt() on the server already ends the text in "?".
      const secs = Math.max(0, Math.round((state.confirmation.expiresAt - Date.now()) / 1000));
      const prompt = state.confirmation.prompt.slice(0, 60);
      return `${prompt} up=yes down=no (${secs}s)`;
    }
    const reply = captions.get();
    if (reply) return reply;
    if (state.hud.overlay && Date.now() < state.hud.overlay.until) return state.hud.overlay.text;
    if (state.busy) return 'Thinking...';
    return ' ';

  }

  let rendering: Promise<void> | null = null;
  let renderQueued = false;
  /**
   * Consecutive real render failures. Lives outside render()'s own closure so
   * it survives across the retries it triggers — each retry is a fresh call
   * to render(), which would otherwise reset a same-scoped counter to zero
   * every time. Reset to 0 on any render pass that completes cleanly.
   */
  let renderFailureStreak = 0;
  /**
   * Every bridge call shares one BLE link, so these are serialised. Firing a
   * status update and a widget update concurrently can drop the connection.
   *
   * Precedence: an urgent overlay wins, then the log you deliberately swiped
   * to, then the resting widget grid. A pending confirmation is no longer a
   * mode of its own — it rides the bottom line inside whichever of those is
   * showing, via statusLine(), so it never hides widgets that are already up.
   */
  async function render(): Promise<void> {
    if (!runtimeActive || disposed) return;
    renderQueued = true;
    if (rendering) return rendering;
    rendering = (async () => {
      try {
        while (renderQueued && runtimeActive && !disposed) {
          renderQueued = false;
          const overlay = state.hud.overlay;
          // Keep the resting display genuinely invisible. We only show a
          // one-line activity indicator after a request is in flight, never
          // merely because ambient sound reached the microphone. A pending
          // confirmation counts as active too — it needs an answer even if
          // nothing is bound to the grid yet. So does an unexpired reply: a
          // plain Q&A turn that finishes after busy/confirmation both clear,
          // with nothing bound to a widget, would otherwise fall straight to
          // showIdle() below — which never surfaces statusLine() — and the
          // reply would be delivered but never actually shown.
          const hasReply = Boolean(captions.get());
          const active = state.busy || state.confirmationBusy || Boolean(state.confirmation) || hasReply || Boolean(overlay && Date.now() < overlay.until);
          const hasHud = state.hud.slots.some(Boolean);

          widgetFocus.sync(state.hud);display.setSelection(widgetFocus.selected);
          if (hasHud) {
            await display.setStatus(statusLine());
            await display.showGrid({...state.hud,slots:state.hud.slots.map(w=>{const preview=widgetFocus.preview(w);return w&&preview?{...w,data:{...w.data,value:preview}}:w;})}, (slot, revision) => client.fetchHudImage(slot, revision));
          } else if (active) {
            await display.showActivity(statusLine());
          } else {
            await display.showIdle();
          }
          captions.shown(display.snapshot().status.trim());
          await display.setIndicator(state.indicator === 'muted' ? state.muted : state.indicator === 'unmuted' ? !state.muted : false);
          void reportActualDisplay();
          scheduleRuntimePersist();
        }
        renderFailureStreak = 0;
      } catch (err) {
        if (isLifecyclePausedError(err)) {
          void reportActualDisplay();
        } else {
          console.error('render failed', err);
          // A status or early slot may have succeeded before a later bridge
          // call failed. Report the confirmed partial state, never the
          // desired HUD.
          void reportActualDisplay();
          renderFailureStreak++;
          // A write into the current container was rejected — the SDK can
          // invalidate a container with nothing telling the app it happened
          // (reproduced: the ring-hold exit-confirmation dialog does this
          // even when declined). Left alone, every future render fails the
          // same way forever, which is what "declining breaks the app"
          // actually was.
          //
          // Never stop retrying. An earlier version capped this at 3 tries
          // and gave up — on real hardware that still left the display
          // frozen forever, because both display.forceRebuild()'s tiers can
          // apparently keep failing for longer than 3 attempts over a real
          // BLE link (the simulator's second tier recovered immediately,
          // which is exactly the gap that cap didn't survive). A frozen
          // display is a worse failure than an occasional wasted retry, and
          // there is no other signal that will make the app try again on
          // its own. Same backoff shape pollLoop already uses for a dead
          // server connection: short at first, capped so a truly wedged
          // bridge does not spin at full speed forever.
          try {
            await display.forceRebuild();
            renderQueued = true;
          } catch (rebuildErr) {
            console.error('display rebuild failed', rebuildErr);
            const backoffMs = Math.min(1000 * 2 ** Math.min(renderFailureStreak, 5), 15_000);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            renderQueued = true;
          }
        }
      } finally {
        rendering = null;
        if (renderQueued) void render();
      }
    })();
    return rendering;
  }

  // A late host restore must repaint immediately; otherwise the suspended
  // WebView can stay on its startup layout until the next long-poll response.
  onHostStateRestored = () => {
    if (state.confirmation && state.confirmation.expiresAt <= Date.now()) state.confirmation = null;
    paint();
    if (runtimeActive) void render();
    if (!disposed) void queueLifecycle(resumeRuntime);
  };
  if (hostStateRestored) onHostStateRestored();

  /** Stop traffic and queued display work; only a final snapshot/report may cross the bridge. */
  async function pauseRuntime(): Promise<void> {
    if (disposed || !runtimeActive) return;
    cancelPress();
    runtimeActive = false;
    captions.clear();
    phoneAudio.setActive(false);
    displayActive = false;
    renderQueued = false;
    stopRuntimeTimers();
    pollAbort?.abort();
    pollAbort = null;
    utteranceAbort?.abort();
    utteranceAbort = null;
    wakePoll?.();
    await stopAudio(true);
    await persistRuntimeState(true);
    await reportActualDisplay(true);
    paint();
  }

  /** Re-enable work and immediately reconcile with the server after foreground entry. */
  async function resumeRuntime(): Promise<void> {
    const wasInactive = !runtimeActive;
    const wasCovered = runtimeCovered;
    if (disposed || (!wasInactive && !wasCovered)) return;
    runtimeActive = true;
    runtimeCovered = false;
    displayActive = true;
    phoneAudio.setActive(true);
    if (wasInactive) {
      state.connected = false;
      state.lastError = '';
      state.lastPollAt = 0;
      state.nextRetryAt = 0;
      backoffMs = 1000;
      reconnectRequested = true;
      startRuntimeTimers();
      const resumePoll = wakeForeground;
      wakeForeground = null;
      resumePoll?.();
    }
    paint();
    void startAudio();
    // Menus may invalidate the native containers even though JS survived.
    try { await display.forceRebuild(); } catch (err) { console.warn('resume display rebuild failed', err); }
    await render();
  }

  async function cleanUp(): Promise<void> {
    if (disposed) return;
    if (runtimeActive) await pauseRuntime();
    else {
      stopRuntimeTimers();
      pollAbort?.abort();
      utteranceAbort?.abort();
      await persistRuntimeState(true);
      await reportActualDisplay(true);
      await stopAudio(true);
    }
    disposed = true;
    removeForegroundRecovery();
    wakeForeground?.();
    wakeForeground = null;
    unsubscribe();
  }

  window.addEventListener('beforeunload', () => {
    void cleanUp();
  });

  console.log('CARVIS_READY');
  // Draw restored state immediately. A resumed headless WebView must not wait
  // behind a 20-second long poll before it returns to its real HUD or dot.
  void render();
  void pollLoop();
  void phoneAudio.run();
  void startAudio();
  scheduleRuntimePersist();

  // Exposed so the simulator, which has no microphone, can still drive it:
  //   await window.carvis.say('turn off the kitchen lights')
  (window as unknown as { carvis: unknown }).carvis = {
    say: async (text: string) => {
      const result = await client.sendText(text);
      applyIngestResult(result);
      await render();
      return result;
    },
    mute: () => toggleMute(),
    state,
    setServer: async (url: string, tokenValue = '') => {
      client.configure(url, tokenValue);
      currentUrl = url; currentToken = tokenValue;
      connectionSettings = {baseUrl:url, token:tokenValue, revision:SETTINGS_REVISION, clientId:displayClientId};
      scheduleRuntimePersist();
      await runBridge(() => bridge.setLocalStorage(STORAGE_KEYS.baseUrl, url));
      await runBridge(() => bridge.setLocalStorage(STORAGE_KEYS.token, tokenValue));
      await runBridge(() => bridge.setLocalStorage(STORAGE_KEYS.settingsRevision, SETTINGS_REVISION));
      reconnectRequested = true; pollAbort?.abort(); wakePoll?.(); paint();
    },
  };
}

void main().catch((err) => {
  console.error('Carvis failed to start', err);
});

// Referenced so the bundler keeps the constant even if tree-shaking gets clever.
export const SAMPLE_RATE = AUDIO.sampleRate;

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = AbortSignal.timeout(ms);
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timeout.addEventListener('abort', () => reject(new Error(`${label} timed out`)), { once: true });
    }),
  ]);
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `g2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Local Vite is the simulator/dev harness; packaged builds report as a G2. */
function reporterKind(): 'g2' | 'simulator' {
  const host = typeof window === 'undefined' ? '' : window.location.hostname;
  return /^(?:localhost|127\.0\.0\.1|::1)$/.test(host) ? 'simulator' : 'g2';
}
