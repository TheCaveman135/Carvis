import { enabled } from './features.js';
/** Route spoken Carvis replies to the physical core, then to one HA speaker. */
import { planTtsCall } from './automation-utils.js';
import { log } from './log.js';

export class VoiceOutput {
  constructor({ getConfig, ha, physicalCarvis, phoneSpeaker, localSpeaker, onPlaybackChange, sleep = pause }) {
    this.getConfig = getConfig;
    this.ha = ha;
    this.physicalCarvis = physicalCarvis;
    this.phoneSpeaker = phoneSpeaker;
    this.localSpeaker = localSpeaker;
    this.onPlaybackChange = onPlaybackChange;
    this.sleep = sleep;
    this.recent = new Map();
    this.recentSpoken = [];
    this.echoesIgnored = 0;
    this.pendingReplies = new Set();
    this.queued = 0;
    this.lastDelivery = null;
    // A TTS service call means that HA accepted the stream, not that its
    // speaker has finished playing it. Keep every spoken Carvis line in one
    // lane so an acknowledgement cannot collide with the result that follows.
    this.outputTail = Promise.resolve();
  }

  async speakReply(entry) {
    if (entry?.source === 'live') return { skipped: true };
    // Speak Carvis's answers, action results, errors, and confirmation prompts;
    // never read ambient transcripts or unrelated internal notes aloud.
    if (!['reply', 'error', 'action'].includes(entry?.kind) && entry?.source !== 'confirmation') return { skipped: true };
    const body = String(entry.text || '').trim();
    return this.speak(body, { source: entry.source || 'carvis', automatic: true });
  }

  /** Route an explicit timer/protocol/model speech action through the same dock-aware path. */
  async speak(text, { source = 'carvis', automatic = false } = {}) {
    const body = String(text || '').trim();
    if (!this.#available(automatic)) return { skipped: true };
    if (!body || (automatic && (this.pendingReplies.has(body) || this.#duplicate(body)))) return { skipped: true };
    if (automatic) this.pendingReplies.add(body);
    this.queued++;
    let playbackStarted = false;
    let spokenRecord = null;

    const run = () => {
      // A line can wait behind another speaker request. Honor settings as
      // they stand when playback starts, including replies being switched off.
      if (!this.#available(automatic)) return { skipped: true };
      playbackStarted = true;
      this.#reportPlayback(true);
      return this.#deliver(body, source, automatic);
    };
    const result = this.outputTail.then(run, run)
      .then((spoken) => {
        if (automatic && spoken?.success) this.recent.set(body, Date.now());
        if (spoken?.success) {
          spokenRecord = { words: spokenWords(body), at: Date.now() };
          this.recentSpoken.push(spokenRecord);
          this.recentSpoken = this.recentSpoken.slice(-10);
        }
        this.lastDelivery = {
          at: Date.now(), status: spoken?.skipped ? 'skipped' : spoken?.success ? 'accepted' : 'failed',
          target: spoken?.target || null, chunks: spoken?.chunks || 0,
          recovered: spoken?.recovered === true,
        };
        return spoken;
      })
      .finally(() => { this.queued--; if (automatic) this.pendingReplies.delete(body); });
    this.outputTail = result
      .then(async (spoken) => {
        // A physical core owns its own command queue. HA media players do not,
        // so leave enough time for the spoken line to finish before issuing
        // the next one. The returned result remains prompt; only the next
        // queued line waits.
        if (spoken?.success && spoken.target && !spoken.streamFinished &&
            (spoken.target !== 'physical_core' || this.onPlaybackChange)) {
          await this.sleep(this.#estimatedPlaybackMs(spoken.lastChunk || body));
        }
        // The microphone still receives the room for a moment after a TTS
        // service returns. Keep its detector closed through that audio tail.
        if (playbackStarted && this.onPlaybackChange) await this.sleep(750);
      })
      .catch(async () => {
        if (playbackStarted && this.onPlaybackChange) {
          try { await this.sleep(750); } catch { /* still reopen the microphone */ }
        }
      })
      .finally(() => {
        if (spokenRecord) {
          // HA may accept a stream well before its speaker finishes. Start the
          // late-transcript window again when playback actually clears.
          spokenRecord.at = Date.now();
          if (!this.recentSpoken.includes(spokenRecord)) this.recentSpoken.push(spokenRecord);
          this.recentSpoken = this.recentSpoken.slice(-10);
        }
        if (playbackStarted) this.#reportPlayback(false);
      });
    return result;
  }

  #reportPlayback(active) {
    try { this.onPlaybackChange?.(active); } catch { /* microphone status must not break speech */ }
  }

  state() {
    return { queued: this.queued, lastDelivery: this.lastDelivery, echoesIgnored: this.echoesIgnored };
  }

  /** A last-chance guard for audio that was already in flight as TTS began. */
  isRecentEcho(text, now = Date.now()) {
    const heard = spokenWords(text);
    if (!heard.length) return false;
    this.recentSpoken = this.recentSpoken.filter(item => now - item.at < 15_000);
    const echo = this.recentSpoken.some(item =>
      (heard.length === item.words.length && heard.every((word, index) => word === item.words[index])) ||
      (heard.length >= 3 && containsWords(item.words, heard)));
    if (echo) this.echoesIgnored++;
    return echo;
  }

  #available(automatic) {
    const config = this.getConfig();
    return (!config.integrations || enabled(config, 'speech')) && config.speech?.outputMode !== 'disabled' && (!automatic || config.speech?.autoReplies === true);
  }

  async #deliver(body, source, automatic) {
    const chunks = speechChunks(body);
    let spoken;
    let recovered = false;
    for (let i = 0; i < chunks.length; i++) {
      const current = this.getConfig().speech || {};
      if (!this.#available(automatic)) return { skipped: true, chunks: i };
      spoken = await this.#route(chunks[i], current.outputMode || 'physical_then_ha', source, automatic);
      recovered ||= spoken?.recovered === true;
      if (!spoken?.success) return { ...spoken, chunks: i };
      if (i < chunks.length - 1 && spoken.target !== 'physical_core' && !spoken.streamFinished) {
        await this.sleep(this.#estimatedPlaybackMs(chunks[i]));
      }
    }
    return { ...spoken, recovered, chunks: chunks.length, lastChunk: chunks.at(-1) };
  }

  async #route(body, mode, source, automatic) {
    if (mode === 'local_only') return this.localSpeaker?.(body,this.getConfig().speech?.localDevice) || {success:false,error:'Local speaker unavailable'};
    if (mode === 'phone_only') return this.phoneSpeaker?.speak(body) || {success:false,error:'Phone speaker unavailable'};
    if (mode !== 'ha_only') {
      const physical = (!this.getConfig().integrations || enabled(this.getConfig(),'physical-carvis')) ? this.physicalCarvis?.enqueueSpeak(body, { source }) : null;
      if (physical) return { success: true, target: 'physical_core', ...physical };
      if (mode === 'physical_only') return { success: false, error: 'no physical Carvis speaker is connected' };
    }
    return this.#speakHomeAssistant(body, automatic, mode);
  }

  async #speakHomeAssistant(message, automatic, mode) {
    const cfg = this.getConfig();
    const speaker = String(cfg.speech?.mediaPlayer || '').trim();
    const provider = String(cfg.speech?.ttsEntity || '').trim();
    const permitted = () => {
      const current = this.getConfig();
      return this.#available(automatic) && (!current.integrations || enabled(current, 'home-assistant')) &&
        (current.speech?.outputMode || 'physical_then_ha') === mode &&
        current.speech?.mediaPlayer?.trim() === speaker && current.speech?.ttsEntity?.trim() === provider &&
        current.entities?.controlled?.includes(speaker);
    };
    if (!provider) return { success: false, error: 'Choose a Home Assistant voice service in Integrations → Spoken replies.' };
    if (!speaker || !permitted()) {
      return { success: false, error: 'no selected Home Assistant speech speaker is configured' };
    }
    let plan;
    // HA's Apple TV integration awaits the entire RAOP stream. A generic
    // 15-second service deadline can abort speech still playing and start a
    // competing retry. Give speech its own deadline, without slowing actions.
    const ttsOptions = { timeoutMs: 90_000 };
    const streamFinished = this.ha.platformFor?.(speaker) === 'apple_tv';
    try {
      plan = planTtsCall({
        tts_entity_id: provider,
        media_player_entity_id: speaker,
        message,
        cache: true,
        ...(cfg.speech?.language ? { language: cfg.speech.language } : {}),
      }, {
        availableEntities: new Set([provider, speaker]),
        allowedMediaPlayers: new Set([speaker]),
      });
      // Voice is scoped to Carvis calls, leaving the HA provider default intact.
      if (typeof cfg.speech?.voice === 'string' && cfg.speech.voice.trim() && cfg.speech.voice.length <= 200 && !/[\x00-\x1f]/.test(cfg.speech.voice)) {
        plan.data.options = {voice: cfg.speech.voice};
      }
      await this.ha.callService(plan.domain, plan.service, plan.data, ttsOptions);
      return { success: true, target: speaker, streamFinished };
    } catch (err) {
      // Apple TV can retain a stale RAOP stream after two close TTS requests,
      // while still reporting its normal state as idle. HA surfaces that only
      // as a generic HTTP 500. Reset *this dedicated Carvis output* once and
      // retry the exact same speech; unrelated HA failures never get a retry.
      if (streamFinished && /\bHA 500\b/.test(String(err?.message || ''))) {
        try {
          if (!permitted()) return { skipped: true };
          log('warn', `Carvis speaker ${speaker} had a stuck playback stream; resetting it once`);
          await this.ha.callService('media_player', 'media_stop', { entity_id: speaker });
          await this.sleep(350);
          if (!permitted()) return { skipped: true };
          await this.ha.callService(plan.domain, plan.service, plan.data, ttsOptions);
          return { success: true, target: speaker, recovered: true, streamFinished };
        } catch (recoveryErr) {
          log('warn', `Automatic Carvis speech retry failed: ${recoveryErr.message}`);
          return { success: false, error: recoveryErr.message };
        }
      }
      // A brief service/network outage should not permanently discard a
      // reply. Retry once; authentication, validation and selection failures
      // do not retry, and no unrelated media player is touched.
      if (/\bHA (?:502|503|504)\b|fetch failed|ECONNRESET|ECONNREFUSED/i.test(String(err?.message || ''))) {
        try {
          await this.sleep(750);
          if (!permitted()) return { skipped: true };
          await this.ha.callService(plan.domain, plan.service, plan.data, ttsOptions);
          return { success: true, target: speaker, recovered: true, streamFinished };
        } catch (retryErr) {
          log('warn', `Carvis speech retry failed: ${retryErr.message}`);
          return { success: false, error: retryErr.message };
        }
      }
      log('warn', `Automatic Carvis speech failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  #estimatedPlaybackMs(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    // About 2.5 words/second, plus a small hand-off margin. A cap prevents a
    // malformed long reply from silencing later important announcements.
    return Math.max(1_000, Math.min(30_000, Math.round((words / 2.5) * 1_000 + 800)));
  }

  #duplicate(text) {
    const now = Date.now();
    for (const [body, at] of this.recent) if (now - at > 5_000) this.recent.delete(body);
    if (this.recent.has(text)) return true;
    return false;
  }
}

/** Keep every word while respecting the 500-character TTS/core limit. */
export function speechChunks(text, max = 450) {
  let remaining = String(text || '').trim();
  const chunks = [];
  while (remaining.length > max) {
    const prefix = remaining.slice(0, max + 1);
    const sentences = [...prefix.matchAll(/[.!?]\s+/g)];
    const sentence = sentences.at(-1);
    const boundary = sentence && sentence.index > max / 3 ? sentence.index + 1 : prefix.lastIndexOf(' ');
    const split = boundary > 0 ? boundary : max;
    chunks.push(remaining.slice(0, split).trim());
    remaining = remaining.slice(split).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function pause(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    // The wait preserves ordering while Carvis is running, but must never be
    // the only thing that keeps a clean shutdown alive.
    timer.unref?.();
  });
}

function spokenWords(text) {
  return String(text || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function containsWords(haystack, needle) {
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((word, index) => word === haystack[start + index])) return true;
  }
  return false;
}
