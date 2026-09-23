/**
 * Speech to text.
 *
 * One HTTP call per utterance, to either Deepgram (nova-3) or AssemblyAI
 * (Universal-3.5 Pro, via its Sync API) depending on `stt.engine` -- kept
 * side by side, not swapped, so the two can be A/B'd on real transcripts
 * before committing to one. This used to be a local Whisper model held
 * resident on this Mac -- kept every word off the network, but base.en with
 * greedy decoding (temperature locked to 0, no fallback ladder) hallucinated
 * full sentences on noisy or ambiguous audio, looping the same line dozens
 * of times, and still missed real commands in a noisy room. Both of these
 * are what it costs to actually hear correctly in that room.
 *
 * Microphone controls gate capture and server-side transcription. Pending
 * work is cancelled when access changes; recordings are never retained here.
 */
import { log } from './log.js';

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const ASSEMBLYAI_URL = 'https://sync.assemblyai.com/transcribe';

export function speechProvider(config, environment = process.env) {
  const cfg = config?.stt || {};
  const engine = cfg.engine === 'assemblyai' ? 'assemblyai' : 'deepgram';
  const key = engine === 'assemblyai'
    ? cfg.assemblyaiKey || environment.ASSEMBLYAI_API_KEY || ''
    : cfg.deepgramKey || environment.DEEPGRAM_API_KEY || '';
  return { engine, key: key.trim(), model: cfg.model || (engine === 'assemblyai' ? 'universal-3-5-pro' : 'nova-3') };
}

export class Transcriber {
  constructor(getConfig, { fetch: fetcher = fetch, signal } = {}) {
    this.fetch = fetcher;
    this.signal = signal;
    this.pending = new AbortController();
    this.getConfig = getConfig;
    this.lastMs = 0;
    this.lastConfidence = null;
    this.lastAudio = null;
    this.error = '';
  }

  /** No process to boot -- kept so callers written for the old worker still work. */
  start() {}
  stop() { this.cancel(); }
  cancel() {
    this.pending.abort(new DOMException('Microphone access changed.', 'AbortError'));
    this.pending = new AbortController();
  }

  /**
   * Transcribe one utterance. `pcm` is signed 16-bit little-endian mono at
   * 16kHz -- exactly what `audioEvent.audioPcm` hands over on the G2.
   *
   * Resolves `{text, confidence, stats}`. `confidence` is the engine's own
   * per-utterance score (0-1), not a heuristic reconstructed from decode
   * internals. `stats` describes input levels without retaining microphone audio.
   */
  async transcribe(pcm, { signal } = {}) {
    const stats = audioStats(pcm);
    this.lastAudio = stats;
    const cfg = this.getConfig();
    const { engine, key, model } = speechProvider(cfg);
    if (!key) {
      const label = engine === 'assemblyai' ? 'AssemblyAI' : 'Deepgram';
      this.error = `no ${label} API key set`;
      throw new Error(`no ${label} API key set — add one in Settings → Global API keys`);
    }

    const started = Date.now();
    const requestSignal = AbortSignal.any([this.pending.signal, this.signal, signal, AbortSignal.timeout(20000)].filter(Boolean));
    requestSignal.throwIfAborted();
    const result =
      engine === 'assemblyai'
        ? await this.#transcribeAssemblyAI(pcm, key, model, requestSignal)
        : await this.#transcribeDeepgram(pcm, key, model, cfg.stt.keyterms, requestSignal);
    requestSignal.throwIfAborted();

    this.error = '';
    this.lastMs = Date.now() - started;
    this.lastConfidence = result.confidence;
    return { ...result, stats };
  }

  async #transcribeDeepgram(pcm, key, model, keyterms, signal) {
    const url = deepgramUrl(model, keyterms);

    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
        body: wavFromPcm(pcm),
        signal,
      });
    } catch (err) {
      signal.throwIfAborted();
      this.error = `could not reach Deepgram (${err.message})`;
      throw new Error(this.error);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.error = `Deepgram ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      log('error', `STT: ${this.error}`);
      throw new Error(this.error);
    }

    const data = await res.json();
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const text = (alt?.transcript || '').trim();
    const confidence = typeof alt?.confidence === 'number' ? Math.round(alt.confidence * 100) / 100 : null;
    return { text, confidence, stats: null };
  }

  /**
   * Universal-3.5 Pro via the Sync API: one multipart POST, one JSON response,
   * no polling -- the model tag goes in a header, not the URL. Capped at 2
   * minutes of audio per request, which every utterance here is nowhere near.
   */
  async #transcribeAssemblyAI(pcm, key, model, signal) {
    const form = new FormData();
    form.append('audio', new Blob([wavFromPcm(pcm)], { type: 'audio/wav' }), 'utterance.wav');

    let res;
    try {
      res = await this.fetch(ASSEMBLYAI_URL, {
        method: 'POST',
        headers: { Authorization: key, 'X-AAI-Model': model },
        body: form,
        signal,
      });
    } catch (err) {
      signal.throwIfAborted();
      this.error = `could not reach AssemblyAI (${err.message})`;
      throw new Error(this.error);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.error = `AssemblyAI ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      log('error', `STT: ${this.error}`);
      throw new Error(this.error);
    }

    const data = await res.json();
    const text = String(data?.text || '').trim();
    const confidence = typeof data?.confidence === 'number' ? Math.round(data.confidence * 100) / 100 : null;
    return { text, confidence, stats: null };
  }

  state() {
    const { engine, key, model } = speechProvider(this.getConfig());
    return {
      running: true,
      ready: Boolean(key),
      engine,
      model,
      device: 'cloud',
      error: this.error,
      lastMs: this.lastMs,
      confidence: this.lastConfidence,
      audio: this.lastAudio,
      queued: 0,
    };
  }
}

/** Minimal 44-byte RIFF header around raw PCM. 16kHz, mono, 16-bit. */
export function wavFromPcm(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  const bytesPerSample = 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  header.writeUInt16LE(bytesPerSample, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/** Vocabulary hints improve recognition; they never rewrite text or grant authority. */
export function deepgramUrl(model, keyterms = []) {
  const url = new URL(DEEPGRAM_URL);
  for (const [key, value] of Object.entries({ model, language: 'en', smart_format: 'true', punctuate: 'true' })) url.searchParams.set(key, value);
  // Nova-2 does not accept Nova-3 keyterms. Keep alternate model selections valid.
  if (/^nova-3(?:$|-)/.test(model) && Array.isArray(keyterms)) {
    for (const term of [...new Set(keyterms.filter(t => typeof t === 'string').map(t => t.trim()).filter(Boolean))].slice(0, 30)) {
      url.searchParams.append('keyterm', term.slice(0, 60));
    }
  }
  return url;
}

/** Level diagnostics only: no recordings or recognized words are retained here. */
export function audioStats(pcm) {
  if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2) throw new Error('Expected nonempty 16-bit PCM audio');
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0, peak = 0, clipped = 0;
  const count = pcm.byteLength / 2;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    const sample = Math.abs(view.getInt16(offset, true));
    sum += sample * sample;
    peak = Math.max(peak, sample);
    if (sample >= 32760) clipped++;
  }
  const rms = Math.sqrt(sum / count);
  return { durationMs: Math.round(count / 16), rms: Math.round(rms), peak,
    rmsDbfs: rms ? Math.round(20 * Math.log10(rms / 32768) * 10) / 10 : null,
    clippedPercent: Math.round(clipped / count * 10000) / 100 };
}
