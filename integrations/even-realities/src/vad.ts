/**
 * Utterance segmentation.
 *
 * The G2 streams PCM continuously. Sending all of it to the Mac would mean
 * transcribing silence around the clock, so this cuts the stream into things
 * that sound like sentences: start on sound, end on the silence after it.
 *
 * The pre-roll matters more than it looks. Speech crosses the loudness
 * threshold a moment *after* it starts, so without a buffer of what came just
 * before, every utterance arrives with its first syllable missing — and the
 * first syllable is usually the wake word.
 */
import { AUDIO } from './config';

export type Utterance = {
  pcm: Uint8Array;
  durationMs: number;
};

function rms(pcm: Uint8Array): number {
  // Interpret the byte pairs as signed 16-bit little-endian.
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function bytesToMs(bytes: number): number {
  return (bytes / 2 / AUDIO.sampleRate) * 1000;
}

export class UtteranceDetector {
  private speaking = false;
  private chunks: Uint8Array[] = [];
  private preRoll: Uint8Array[] = [];
  private preRollBytes = 0;
  private silenceMs = 0;
  private speechMs = 0;

  /** Last measured loudness, for the "am I being heard at all" indicator. */
  lastRms = 0;

  /**
   * Feed one PCM chunk. Returns a finished utterance when one just ended,
   * otherwise null.
   */
  push(chunk: Uint8Array): Utterance | null {
    const level = rms(chunk);
    this.lastRms = level;
    const chunkMs = bytesToMs(chunk.byteLength);
    const loud = level >= AUDIO.speechRms;

    if (!this.speaking) {
      // Keep a rolling window of recent quiet so the start of speech survives.
      this.preRoll.push(chunk);
      this.preRollBytes += chunk.byteLength;
      const preRollLimit = (AUDIO.preRollMs / 1000) * AUDIO.sampleRate * 2;
      while (this.preRollBytes > preRollLimit && this.preRoll.length > 1) {
        this.preRollBytes -= this.preRoll.shift()!.byteLength;
      }

      if (!loud) return null;

      this.speaking = true;
      this.chunks = [...this.preRoll];
      this.speechMs = bytesToMs(this.preRollBytes);
      this.preRoll = [];
      this.preRollBytes = 0;
      this.silenceMs = 0;
      return null;
    }

    this.chunks.push(chunk);
    this.speechMs += chunkMs;
    this.silenceMs = loud ? 0 : this.silenceMs + chunkMs;

    if (this.silenceMs >= AUDIO.trailingSilenceMs || this.speechMs >= AUDIO.maxUtteranceMs) {
      return this.finish();
    }
    return null;
  }

  /** Close the current utterance, if it is long enough to be one. */
  finish(): Utterance | null {
    if (!this.speaking) return null;
    const chunks = this.chunks;
    const durationMs = this.speechMs;
    this.reset();

    if (durationMs < AUDIO.minUtteranceMs) return null;

    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      pcm.set(c, offset);
      offset += c.byteLength;
    }
    return { pcm, durationMs };
  }

  reset(): void {
    this.speaking = false;
    this.chunks = [];
    this.preRoll = [];
    this.preRollBytes = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }
}
