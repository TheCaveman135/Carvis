import type { CarvisClient } from './client';

/** iPhone Web Speech output. Always start with a user tap to unlock iOS audio. */
export class PhoneAudio {
  enabled = false;
  speaking = false;
  mode = '';
  error = '';
  private active = true;
  private controller: AbortController | null = null;
  private cancelSpeech: (() => void) | null = null;
  private completed = new Map<string, boolean>();
  private setting = false;
  private wake: (() => void) | null = null;
  constructor(private client: CarvisClient, private clientId: string, private changed: () => void) {}

  syncMode(mode: string): void { if (!this.setting && mode) this.mode = mode; }
  enable(): void {
    if (!this.client.configured) { this.error = 'Connect to Carvis before enabling phone audio.'; this.changed(); return; }
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      this.error = 'Phone speech is unavailable in this version of Even Hub.'; this.changed(); return;
    }
    this.error = '';
    void this.say('Phone audio ready.').then(ok => {
      this.enabled = ok;
      if (!ok) this.error = 'Could not start phone audio. Tap Enable phone audio to retry.';
      this.controller?.abort(); this.wake?.(); this.changed();
    });
  }
  async select(mode: string): Promise<void> {
    this.setting = true;
    try { await this.client.setSpeechOutput(mode); this.mode = mode; this.error = ''; }
    catch (err) { this.error = err instanceof Error ? err.message : String(err); }
    finally { this.setting = false; this.controller?.abort(); this.wake?.(); this.changed(); }
  }
  setActive(active: boolean): void {
    this.active = active;
    this.controller?.abort(); this.wake?.();
    if (!active) {
      this.cancelSpeech?.(); this.enabled = false;
      void this.client.phonePoll(this.clientId, false).catch(() => {});
    }
  }
  private say(text: string): Promise<boolean> {
    return new Promise(resolve => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices?.() || [];
      const british = voices.filter(voice => /^en[-_]GB$/i.test(voice.lang));
      const preferred = british.find(voice => /Daniel/i.test(voice.name))
        || british.find(voice => /George|Arthur|Oliver/i.test(voice.name))
        || british[0];
      if (preferred) utterance.voice = preferred;
      utterance.lang = 'en-GB';
      utterance.rate = 0.95;
      utterance.pitch = 0.9;
      this.speaking = true; this.changed();
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return; done = true; clearTimeout(timer);
        this.cancelSpeech = null; this.speaking = false; this.changed(); resolve(ok);
      };
      const timer = window.setTimeout(() => { window.speechSynthesis.cancel(); finish(false); }, 80_000);
      this.cancelSpeech = () => { window.speechSynthesis.cancel(); finish(false); };
      utterance.onend = () => finish(true);
      utterance.onerror = () => finish(false);
      try { window.speechSynthesis.speak(utterance); } catch { finish(false); }
    });
  }
  async run(): Promise<void> {
    for (;;) {
      if (!this.active) { await new Promise<void>(r => {this.wake = r;}); this.wake = null; continue; }
      if (!this.client.configured) { await new Promise(r => setTimeout(r, 1000)); continue; }
      this.controller = new AbortController();
      try {
        const data = await this.client.phonePoll(this.clientId, this.enabled, this.controller.signal);
        this.error = '';
        if (!this.setting) this.mode = data.outputMode;
        this.changed();
        if (data.command && this.enabled && this.active) {
          let ok = this.completed.get(data.command.id);
          if (ok === undefined) {
            ok = await this.say(data.command.text);
            this.completed.set(data.command.id, ok);
            if (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!);
          }
          await this.client.phoneAck(this.clientId, data.command.id, ok);
          if (!ok) { this.enabled = false; this.error = 'Phone playback stopped. Tap Enable phone audio to retry.'; this.changed(); }
        }
      } catch (err) {
        if (!this.controller.signal.aborted) { this.error = err instanceof Error ? err.message : String(err); this.changed(); }
      }
      if (this.error) await new Promise(r => setTimeout(r, 3000));
      else if (!this.enabled) { await new Promise<void>(r => {this.wake = r;}); this.wake = null; }
    }
  }
}
