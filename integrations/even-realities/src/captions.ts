import { measureTextWrap } from '@evenrealities/pretext';
import { DISPLAY } from './config';

/** Split complete replies into readable bottom-strip pages, without dropping words. */
export function captionPages(text: string): string[] {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const pages: string[] = [];
  let page = '';
  const width = DISPLAY.width - 18 - 2 * DISPLAY.statusPadding;
  for (const word of words) {
    if (measureTextWrap(word, width).lineCount > DISPLAY.statusMaxLines) {
      if (page) { pages.push(page); page = ''; }
      let rest = word;
      while (rest) {
        let lo = 1, hi = rest.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (measureTextWrap(rest.slice(0, mid), width).lineCount <= DISPLAY.statusMaxLines) lo = mid;
          else hi = mid - 1;
        }
        pages.push(rest.slice(0, lo)); rest = rest.slice(lo);
      }
      continue;
    }
    const next = page ? `${page} ${word}` : word;
    if (page && measureTextWrap(next, width).lineCount > DISPLAY.statusMaxLines) {
      pages.push(page); page = word;
    } else page = next;
  }
  if (page) pages.push(page);
  return pages;
}

export class Captions {
  private queue: string[] = [];
  private current: {text: string; until: number} | null = null;
  add(text: string): void { this.queue.push(...captionPages(text)); }
  get(now = Date.now()): string {
    if (this.current && this.current.until > 0 && now >= this.current.until) this.current = null;
    if (!this.current && this.queue.length) {
      const text = this.queue.shift()!;
      this.current = {text, until: 0};
    }
    return this.current?.text || '';
  }
  shown(text: string, now = Date.now()): void {
    if (this.current && !this.current.until && this.current.text === text) {
      this.current.until = now + Math.max(3500, Math.min(12000, text.split(/\s+/).length * 380));
    }
  }
  clear(): void { this.queue = []; this.current = null; }
}
