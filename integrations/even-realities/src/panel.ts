/**
 * The phone-side status console.
 *
 * The glasses render through the SDK, so for a long time this page said only
 * "Carvis" — which meant that when the G2 showed nothing, there was nowhere at
 * all to find out why. Everything here answers one question: is this app
 * actually talking to Carvis, and if not, what is it stuck on.
 *
 * Deliberately read-only about Carvis's own state. Mute is a local preference
 * and lives entirely on this side; the server is never asked.
 */
import { normalizeConnection, type FeedEntry } from './client';

export type PanelSnapshot = {
  /** 'live' once a poll has succeeded, 'connecting' before the first one. */
  connection: 'connecting' | 'live' | 'offline';
  baseUrl: string;
  token: string;
  lastError: string;
  lastPollAt: number;
  nextRetryAt: number;
  muted: boolean;
  indicator: 'muted' | 'unmuted' | 'off';
  speechMode: string;
  phoneAudioReady: boolean;
  phoneAudioError: string;
  busy: boolean;
  speaking: boolean;
  micOn: boolean;
  displayActive: boolean;
  hudWidgets: number;
  hudRevision: number;
  cameraError: string;
  entries: FeedEntry[];
};

export type PanelHandlers = {
  onToggleMute: () => void;
  onReconnect: () => void;
  onIndicator: (value: 'muted' | 'unmuted' | 'off') => void;
  onSpeaker: (value: string) => void;
  onEnablePhoneAudio: () => void;
  onSave: (baseUrl: string, token: string) => void;
};

const KIND_ICON: Record<FeedEntry['kind'], string> = {
  action: '✓',
  reply: '↩',
  note: '·',
  error: '!',
  heard: '“',
};

function ago(ts: number): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export class Panel {
  private el: Record<string, HTMLElement | null>;
  private editing = false;

  constructor(private handlers: PanelHandlers) {
    const id = (name: string) => document.getElementById(name);
    this.el = {
      beacon: id('beacon'),
      heroTitle: id('heroTitle'),
      heroDetail: id('heroDetail'),
      heroError: id('heroError'),
      muteBtn: id('muteBtn'),
      reconnectBtn: id('reconnectBtn'),
      rowMic: id('rowMic'),
      rowDisplay: id('rowDisplay'),
      rowHud: id('rowHud'),
      rowCamera: id('rowCamera'),
      rowCameraLine: id('rowCameraLine'),
      rowServer: id('rowServer'),
      rowSeen: id('rowSeen'),
      feed: id('feed'),
      urlInput: id('urlInput'),
      tokenInput: id('tokenInput'),
      saveBtn: id('saveBtn'),
      indicatorSelect: id('indicatorSelect'),
      speakerSelect: id('speakerSelect'),
      enablePhoneAudio: id('enablePhoneAudio'),
      phoneAudioStatus: id('phoneAudioStatus'),
    };

    this.el.indicatorSelect?.addEventListener('change', event => this.handlers.onIndicator((event.target as HTMLSelectElement).value as 'muted' | 'unmuted' | 'off'));
    this.el.speakerSelect?.addEventListener('change', event => this.handlers.onSpeaker((event.target as HTMLSelectElement).value));
    this.el.enablePhoneAudio?.addEventListener('click', () => this.handlers.onEnablePhoneAudio());
    this.el.muteBtn?.addEventListener('click', () => this.handlers.onToggleMute());
    this.el.reconnectBtn?.addEventListener('click', () => this.handlers.onReconnect());
    this.el.saveBtn?.addEventListener('click', () => {
      const url = (this.el.urlInput as HTMLInputElement | null)?.value.trim() || '';
      const token = (this.el.tokenInput as HTMLInputElement | null)?.value.trim() || '';
      if (!url || !token) {
        const field = this.el[!url ? 'urlInput' : 'tokenInput'] as HTMLInputElement;
        field.required = true; field.reportValidity(); return;
      }
      try { normalizeConnection(url, token); }
      catch (err) {
        const field = this.el.urlInput as HTMLInputElement;
        field.setCustomValidity(err instanceof Error ? err.message : String(err));
        field.reportValidity(); return;
      }
      this.editing = false;
      this.handlers.onSave(url.replace(/\/+$/, ''), token);
    });

    // A repaint mid-edit would wipe what is being typed, and the settings
    // fields are exactly what someone reaches for when nothing is connecting.
    for (const field of ['urlInput', 'tokenInput']) {
      this.el[field]?.addEventListener('input', () => {
        (this.el.urlInput as HTMLInputElement)?.setCustomValidity('');
      });
      this.el[field]?.addEventListener('focus', () => {
        this.editing = true;
      });
    }
  }

  update(snap: PanelSnapshot): void {
    const { beacon, heroTitle, heroDetail, heroError } = this.el;

    let tone: string;
    let title: string;
    let detail: string;
    if (!snap.baseUrl || !snap.token) {
      tone = 'warn'; title = 'Setup required';
      detail = 'Enter your Carvis address and pairing token below. The microphone stays off until you unmute.';
    } else if (snap.connection === 'live') {
      tone = 'ok';
      title = snap.muted ? 'Connected · muted' : 'Connected';
      detail = snap.muted
        ? 'Carvis is reachable. The microphone is off on this device.'
        : snap.busy
          ? 'Sending what you just said…'
          : snap.speaking
            ? 'Hearing you…'
            : 'Listening. Carvis is reachable.';
    } else if (snap.connection === 'connecting') {
      tone = 'warn';
      title = 'Connecting…';
      detail = `Reaching ${snap.baseUrl.replace(/^https?:\/\//, '')}`;
    } else {
      tone = 'bad';
      title = 'Cannot reach Carvis';
      const retryIn = Math.max(0, Math.round((snap.nextRetryAt - Date.now()) / 1000));
      detail = snap.nextRetryAt
        ? `Retrying in ${retryIn}s · last contact ${ago(snap.lastPollAt)}`
        : `Last contact ${ago(snap.lastPollAt)}`;
    }

    if (beacon) {
      beacon.className = `beacon ${tone}${snap.baseUrl && snap.token && snap.connection === 'connecting' ? ' pulse' : ''}`;
    }
    if (heroTitle) heroTitle.textContent = title;
    if (heroDetail) heroDetail.textContent = detail;
    if (heroError) {
      const show = snap.connection !== 'live' && Boolean(snap.lastError);
      heroError.hidden = !show;
      heroError.textContent = show ? snap.lastError : '';
    }

    const muteBtn = this.el.muteBtn as HTMLButtonElement | null;
    if (muteBtn) {
      muteBtn.textContent = snap.muted ? 'Unmute' : 'Mute';
      muteBtn.className = snap.muted ? 'on' : '';
    }

    this.setRow('rowMic', snap.muted ? 'Muted' : snap.micOn ? 'Live' : 'Off', snap.muted ? 'warn' : snap.micOn ? 'ok' : 'bad');
    this.setRow(
      'rowDisplay',
      snap.displayActive ? 'Foreground' : 'Background',
      snap.displayActive ? 'ok' : 'warn',
    );
    this.setRow('rowHud', snap.hudWidgets ? `${snap.hudWidgets} widget${snap.hudWidgets === 1 ? '' : 's'} · r${snap.hudRevision}` : 'Empty', '');

    // Only worth a row when it has something to say — a camera that is working
    // needs no commentary, and an app with no camera bound has none either.
    const cameraLine = this.el.rowCameraLine;
    if (cameraLine) cameraLine.hidden = !snap.cameraError;
    if (snap.cameraError) this.setRow('rowCamera', snap.cameraError, 'bad');

    this.setRow('rowServer', snap.baseUrl.replace(/^https?:\/\//, '') || 'Not configured', '');
    this.setRow('rowSeen', ago(snap.lastPollAt), snap.connection === 'live' ? 'ok' : 'warn');

    const indicator = this.el.indicatorSelect as HTMLSelectElement | null;
    const speaker = this.el.speakerSelect as HTMLSelectElement | null;
    if (indicator) indicator.value = snap.indicator;
    if (speaker && snap.speechMode) speaker.value = snap.speechMode;
    if (this.el.phoneAudioStatus) this.el.phoneAudioStatus.textContent = snap.phoneAudioError || (snap.phoneAudioReady ? 'Phone audio ready.' : 'Tap to enable the British iPhone speech voice. Re-enable after returning to this screen.');
    const enableAudio = this.el.enablePhoneAudio as HTMLButtonElement | null;
    if (enableAudio) { enableAudio.disabled = snap.phoneAudioReady; enableAudio.textContent = snap.phoneAudioReady ? 'Phone audio enabled' : 'Enable phone audio'; }
    this.renderFeed(snap.entries);

    if (!this.editing) {
      const url = this.el.urlInput as HTMLInputElement | null;
      const token = this.el.tokenInput as HTMLInputElement | null;
      if (url && url.value !== snap.baseUrl) url.value = snap.baseUrl;
      if (token && token.value !== snap.token) token.value = snap.token;
    }
  }

  private setRow(key: string, value: string, tone: string): void {
    const el = this.el[key];
    if (!el) return;
    el.textContent = value;
    el.className = `v${tone ? ` ${tone}` : ''}`;
  }

  private renderFeed(entries: FeedEntry[]): void {
    const host = this.el.feed;
    if (!host) return;
    if (!entries.length) {
      host.innerHTML = '<p class="empty">Nothing yet.</p>';
      return;
    }
    host.replaceChildren(
      ...entries
        .slice(-50)
        .reverse()
        .map((entry) => {
          const row = document.createElement('div');
          row.className = `entry${entry.kind === 'error' ? ' error' : ''}`;

          const time = document.createElement('time');
          time.textContent = clockTime(entry.ts);

          const body = document.createElement('div');
          body.className = 'body';
          // textContent throughout: feed text is model output and must never
          // be parsed as markup.
          body.append(`${KIND_ICON[entry.kind] || '·'} ${entry.fullText || entry.text}`);
          if (entry.detail) {
            const small = document.createElement('small');
            small.textContent = entry.detail;
            body.append(small);
          }

          row.append(time, body);
          return row;
        }),
    );
  }
}
