/** Local segmentation of 16 kHz mono PCM. Quiet audio never leaves the device. */
export class UtteranceDetector {
  private chunks: Uint8Array[] = [];
  private preRoll: Uint8Array[] = [];
  private preRollBytes = 0;
  private totalBytes = 0;
  private voicedBytes = 0;
  private quietBytes = 0;
  private speaking = false;
  private threshold: number;
  constructor(threshold = 350) {
    this.threshold = threshold;
  }
  push(bytes: Uint8Array): Uint8Array | null {
    if (!bytes.length || bytes.length % 2) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let energy = 0;
    for (let i = 0; i < bytes.length; i += 2)
      energy += view.getInt16(i, true) ** 2;
    const loud = Math.sqrt(energy / (bytes.length / 2)) >= this.threshold;
    const chunk = bytes.slice();
    if (!this.speaking) {
      this.preRoll.push(chunk);
      this.preRollBytes += chunk.length;
      while (this.preRollBytes > 12800 && this.preRoll.length > 1)
        this.preRollBytes -= this.preRoll.shift()!.length;
      if (!loud) return null;
      this.speaking = true;
      this.chunks = this.preRoll;
      this.totalBytes = this.preRollBytes;
      this.preRoll = [];
      this.preRollBytes = 0;
      this.voicedBytes = chunk.length;
      return null;
    }
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    if (loud) {
      this.quietBytes = 0;
      this.voicedBytes += chunk.length;
    } else this.quietBytes += chunk.length;
    if (this.quietBytes >= 32000 || this.totalBytes >= 928000)
      return this.finish();
    return null;
  }
  finish(): Uint8Array | null {
    const output =
      this.voicedBytes >= 8000
        ? new Uint8Array(Math.min(this.totalBytes, 960000))
        : null;
    if (output) {
      let offset = 0;
      for (const chunk of this.chunks) {
        const part = chunk.subarray(0, output.length - offset);
        output.set(part, offset);
        offset += part.length;
      }
    }
    this.reset();
    return output;
  }
  reset() {
    this.chunks = [];
    this.preRoll = [];
    this.preRollBytes = 0;
    this.totalBytes = 0;
    this.voicedBytes = 0;
    this.quietBytes = 0;
    this.speaking = false;
  }
}
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
