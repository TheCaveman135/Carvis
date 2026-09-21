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
 * The tradeoff is real and worth stating: audio now leaves the machine, and
 * every utterance costs money. Both are why mute lives entirely on the
 * glasses and gates capture before anything is sent -- see the comment on
 * `POST /api/voice/audio` in server/index.js. A muted G2 never calls either
 * engine at all.
 */
import { log } from './log.js';

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const ASSEMBLYAI_URL = 'https://sync.assemblyai.com/transcribe';

export class Transcriber {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.lastMs = 0;
    this.lastConfidence = null;
    this.lastAudio = null;
    this.error = '';
  }

  /** No process to boot -- kept so callers written for the old worker still work. */
  start() {}
  stop() {}

  #engine() {
    return this.getConfig().stt.engine === 'assemblyai' ? 'assemblyai' : 'deepgram';
  }

  #key() {
    const cfg = this.getConfig().stt;
    return this.#engine() === 'assemblyai'
      ? (cfg.assemblyaiKey || process.env.ASSEMBLYAI_API_KEY || '').trim()
      : (cfg.deepgramKey || process.env.DEEPGRAM_API_KEY || '').trim();
  }

  #defaultModel() {
    return this.#engine() === 'assemblyai' ? 'universal-3-5-pro' : 'nova-3';
  }

  /**
   * Transcribe one utterance. `pcm` is signed 16-bit little-endian mono at
   * 16kHz -- exactly what `audioEvent.audioPcm` hands over on the G2.
   *
   * Resolves `{text, confidence, stats}`. `confidence` is the engine's own
   * per-utterance score (0-1), not a heuristic reconstructed from decode
   * internals. `stats` describes input levels without retaining microphone audio.
   */
  async transcribe(pcm) {
    this.lastAudio = audioStats(pcm);
    const engine = this.#engine();
    const key = this.#key();
    if (!key) {
      const label = engine === 'assemblyai' ? 'AssemblyAI' : 'Deepgram';
      this.error = `no ${label} API key set`;
      throw new Error(`no ${label} API key set — add one in the Voice & glasses card`);
    }

    const started = Date.now();
    const result =
      engine === 'assemblyai' ? await this.#transcribeAssemblyAI(pcm, key) : await this.#transcribeDeepgram(pcm, key);

    this.error = '';
    this.lastMs = Date.now() - started;
    this.lastConfidence = result.confidence;
    return { ...result, stats: this.lastAudio };
  }

  async #transcribeDeepgram(pcm, key) {
    const cfg = this.getConfig().stt;
    const model = cfg.model || this.#defaultModel();
    const url = deepgramUrl(model, cfg.keyterms);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
        body: wavFromPcm(pcm),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
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
  async #transcribeAssemblyAI(pcm, key) {
    const cfg = this.getConfig().stt;
    const model = cfg.model || this.#defaultModel();

    const form = new FormData();
    form.append('audio', new Blob([wavFromPcm(pcm)], { type: 'audio/wav' }), 'utterance.wav');

    let res;
    try {
      res = await fetch(ASSEMBLYAI_URL, {
        method: 'POST',
        headers: { Authorization: key, 'X-AAI-Model': model },
        body: form,
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
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
    const cfg = this.getConfig().stt;
    return {
      running: true,
      ready: Boolean(this.#key()),
      engine: this.#engine(),
      model: cfg.model || this.#defaultModel(),
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
