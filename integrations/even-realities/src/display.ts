/** Borderless widgets, bottom captions, and an optional bottom-left mute dot. */
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { measureTextWrap } from '@evenrealities/pretext';

import { DISPLAY } from './config';
import type {
  ActualDisplaySlot,
  ActualDisplaySnapshot,
  HudState,
  HudWidget,
} from './client';

// 'confirmation' is intentionally absent: a pending confirmation is no longer
// a full-screen mode of its own. It rides the bottom status line inside
// whichever of these is already showing (see main.ts's statusLine()), so a
// confirmation never hides widgets that are already up. The wire protocol
// (server/glasses-display.js's normalizeReport) still accepts a reported
// mode of 'confirmation' for an older build — that is a separate, wider
// contract this client's own state machine no longer needs to speak.
export type Mode = 'grid' | 'activity' | 'idle';
export type BridgeRun = <T>(operation: () => Promise<T>) => Promise<T>;

const STATUS = { id: 1, name: 'status' };
const SLOTS = [
  { id: 10, name: 'slot1' },
  { id: 11, name: 'slot2' },
  { id: 12, name: 'slot3' },
  { id: 13, name: 'slot4' },
];
const IMAGES = [
  { id: 30, name: 'image1' },
  { id: 31, name: 'image2' },
  { id: 32, name: 'image3' },
  { id: 33, name: 'image4' },
];
const IDLE_INPUT = { id: 40, name: 'idleInput' };
const IDLE_DOT = { id: 41, name: 'idleDot' };

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Bottom, not top. This strip is now Carvis's voice — replies and
 * confirmations, not just a connection indicator — so it belongs directly
 * under the widgets it's talking about, the way a caption sits under a
 * photo. Moving it costs nothing in screen space: the grid's row height
 * (`DISPLAY.height - DISPLAY.statusHeight`, split two ways) is identical
 * whichever end the missing height comes from, so the widgets keep every
 * line they had before.
 */
function statusContainer(content: string, capture: boolean): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 18,
    yPosition: DISPLAY.height - DISPLAY.statusHeight,
    width: DISPLAY.width - 18,
    height: DISPLAY.statusHeight,
    borderWidth: 0,
    borderColor: 0,
    borderRadius: 0,
    paddingLength: DISPLAY.statusPadding,
    containerID: STATUS.id,
    containerName: STATUS.name,
    content,
    isEventCapture: capture ? 1 : 0,
  });
}

/**
 * Fit `text` into the status strip's fixed `DISPLAY.statusMaxLines` lines,
 * pixel-measured against the firmware's own wrapping (via
 * @evenrealities/pretext) rather than a guessed character count. A reply
 * that would wrap past the container's height used to just get its later
 * lines clipped; this truncates it visibly instead, with an ellipsis on
 * whichever prefix still fits.
 */
function truncateToStatusLines(text: string): string {
  const innerWidth = DISPLAY.width - 18 - 2 * DISPLAY.statusPadding;
  if (measureTextWrap(text, innerWidth).lineCount <= DISPLAY.statusMaxLines) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${text.slice(0, mid).trimEnd()}...`;
    if (measureTextWrap(candidate, innerWidth).lineCount <= DISPLAY.statusMaxLines) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}...`;
}

export class Display {
  private indicator = false;
  private mode: Mode = 'grid';
  /**
   * Set when a write into the current container was rejected. The SDK can
   * invalidate the page container without telling the app — reproduced in
   * the simulator: `shutDownPageContainer(1)` (the exit-confirmation dialog)
   * tears the container down immediately, and nothing fires when the dialog
   * is later declined. `setMode()` normally no-ops when asked to re-enter
   * the mode it already believes it's in; this flag forces past that guard
   * so a genuinely dead container gets rebuilt instead of the app writing
   * into a hole forever.
   */
  private forceNextRebuild = false;
  private selectedSlot:number|null=null;
  private lastStatus = '';
  private lastBody = new Map<number, string>();
  private lastImageRevision = new Map<number, string>();
  private visibleImages = new Set<number>();
  private actualBody = '';
  private actualHudRevision = 0;
  private actualText: (ActualDisplaySlot | null)[] = [null, null, null, null];
  private actualImages: (ActualDisplaySlot | null)[] = [null, null, null, null];
  /**
   * Why the last camera frame did not make it onto the glasses.
   *
   * A failed slot silently reports itself as empty, which is indistinguishable
   * from "no camera bound" from every other vantage point — including the Mac.
   * The G2's own status strings (`imageSizeInvalid`, `imageToGray4Failed`,
   * `sendFailed`) are the only thing that says which half of the pipeline
   * broke, so they have to reach a screen a person can actually read.
   */
  private cameraError = '';

  constructor(
    private bridge: EvenAppBridge,
    // The G2 exposes one BLE command channel. The app owns the queue in
    // main.ts so persistence, audio, and display commands cannot overlap.
    private runBridge: BridgeRun = (operation) => operation(),
  ) {}

  get lastCameraError(): string {
    return this.cameraError;
  }

  get currentMode(): Mode {
    return this.mode;
  }

  /**
   * Rebuild the current layout from scratch. Call this after a write into the
   * current container was rejected — see `forceNextRebuild`'s doc comment for
   * why that can happen with no event to explain it.
   *
   * Two tiers, because a rejected write turned out to mean two different
   * things when this was reproduced: `rebuildPageContainer` (the setMode()
   * path) assumes a page framework still exists to swap layouts within, and
   * that assumption can itself be false — confirmed by reproduction, where a
   * declined exit-confirmation dialog left `rebuildPageContainer` failing the
   * same way `textContainerUpgrade` was. When that happens there is no
   * framework left to rebuild into, and only a full `createStartUpPageContainer`
   * bootstrap — the same call `start()` uses — can recreate one.
   */
  async forceRebuild(): Promise<void> {
    const target = this.mode;
    try {
      this.forceNextRebuild = true;
      await this.setMode(target, this.lastStatus || ' ');
      return;
    } catch (err) {
      console.warn('layout rebuild failed, falling back to full page recreation', err);
    }
    const result = await this.start();
    if (Number(result) !== 0) throw new Error(`page recreation failed (${result})`);
    this.forceNextRebuild = true;
    await this.setMode(target, this.lastStatus || ' ');
  }

  /** Only content whose bridge call succeeded is allowed into this snapshot. */
  snapshot(): ActualDisplaySnapshot {
    return {
      mode: this.mode,
      indicator: this.indicator,
      // The idle page is blank except for the optional mute dot. `lastStatus` is intentionally
      // cached for the next active page, but it is not physically visible.
      status: this.mode === 'idle' ? '' : this.lastStatus,
      body: this.actualBody,
      hudRevision: this.actualHudRevision,
      slots: this.actualImages.map((image, index) => {
        const slot = image || this.actualText[index];
        return slot ? { ...slot } : null;
      }),
    };
  }

  async start(): Promise<number> {
    const result = await this.runBridge(() =>
      this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          menuObject:new MenuContainerProperty({menuItems:[new MenuItemProperty({itemName:'Clear screen',itemID:1})]}),
          containerTotalNum: 2,
          textObject: this.idleContainers(),
        }),
      ),
    );
    if (Number(result) === 0) {
      this.mode = 'idle';
      this.lastStatus = '';
      this.actualBody = this.indicator ? '.' : '';
      this.actualHudRevision = 0;
      this.actualText = [null, null, null, null];
      this.actualImages = [null, null, null, null];
      this.lastBody.set(IDLE_INPUT.id, ' ');
      this.lastBody.set(IDLE_DOT.id, this.indicator ? '.' : ' ');
    }
    return result;
  }

  /** Image layers align exactly over the four text slots. Empty placeholders are transparent. */
  private gridImageContainers(): ImageContainerProperty[] {
    // The status strip lives at the bottom now — the grid owns the top of
    // the canvas down to it. Same math, same 129px row height either way.
    const top = 0;
    const half = Math.floor(DISPLAY.width / 2);
    const height = Math.floor((DISPLAY.height - DISPLAY.statusHeight) / 2);

    return IMAGES.map((image, i) => {
      const column = Math.floor(i / 2);
      const row = i % 2;
      return new ImageContainerProperty({
        xPosition: column * half + 2,
        yPosition: top + row * height,
        width: half - 4,
        height: height - 4,
        containerID: image.id,
        containerName: image.name,
      });
    });
  }

  /** Four borderless positions filling the canvas above the status line. */
  private gridContainers(): TextContainerProperty[] {
    const top = 0;
    const half = Math.floor(DISPLAY.width / 2);
    const height = Math.floor((DISPLAY.height - DISPLAY.statusHeight) / 2);

    return SLOTS.map((slot, i) => {
      const column = Math.floor(i / 2);
      const row = i % 2;
      return new TextContainerProperty({
        xPosition: column * half,
        yPosition: top + row * height,
        width: half,
        height,
        borderWidth: this.selectedSlot===i+1?2:0,
        borderColor: this.selectedSlot===i+1?15:0,
        borderRadius: 0,
        paddingLength: 6,
        containerID: slot.id,
        containerName: slot.name,
        content: ' ',
        // The first slot carries input so swipes and presses land somewhere.
        isEventCapture: i === 0 ? 1 : 0,
      });
    });
  }

  private idleContainers(): TextContainerProperty[] {
    return [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: DISPLAY.width,
        height: DISPLAY.height,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 0,
        containerID: IDLE_INPUT.id,
        containerName: IDLE_INPUT.name,
        content: ' ',
        isEventCapture: 1,
      }),
      this.dotContainer(),
    ];
  }

  private dotContainer(): TextContainerProperty {
    return new TextContainerProperty({
      xPosition: 0, yPosition: DISPLAY.height - 28, width: 18, height: 28,
      borderWidth: 0, borderColor: 0, paddingLength: 0,
      containerID: IDLE_DOT.id, containerName: IDLE_DOT.name,
      content: this.indicator ? '.' : ' ', isEventCapture: 0,
    });
  }

  async setIndicator(visible: boolean): Promise<void> {
    await this.write(IDLE_DOT, visible ? '.' : ' ');
    this.indicator = visible;
    if (this.mode === 'idle') this.actualBody = visible ? '.' : '';
  }

  /** Swap layouts. Costs one flicker, so only on a real mode change — or a forced rebuild. */
  private async setMode(mode: Mode, initialContent = ' '): Promise<void> {
    if (this.mode === mode && !this.forceNextRebuild) return;
    this.forceNextRebuild = false;

    const textObject =
      mode === 'grid'
        ? [statusContainer(this.lastStatus || ' ', false), ...this.gridContainers(), this.dotContainer()]
        : mode === 'idle'
          ? this.idleContainers()
          : [statusContainer(initialContent, true), this.dotContainer()];

    const imageObject = mode === 'grid' ? this.gridImageContainers() : undefined;
    const result = await this.runBridge(() =>
      this.bridge.rebuildPageContainer(
        new RebuildPageContainer({
          menuObject:new MenuContainerProperty({menuItems:[new MenuItemProperty({itemName:'Clear screen',itemID:1})]}),
          containerTotalNum: textObject.length + (imageObject?.length || 0),
          textObject,
          imageObject,
        }),
      ),
    );
    if (!result) throw new Error(`G2 rejected ${mode} layout`);

    this.mode = mode;
    this.lastBody.clear();
    this.lastImageRevision.clear();
    this.visibleImages.clear();
    if (mode === 'grid') {
      this.resetGridActual();
    } else if (mode === 'idle') {
      this.actualBody = this.indicator ? '.' : '';
      this.actualHudRevision = 0;
      this.actualText = [null, null, null, null];
      this.actualImages = [null, null, null, null];
      this.lastBody.set(IDLE_INPUT.id, ' ');
      this.lastBody.set(IDLE_DOT.id, this.indicator ? '.' : ' ');
    } else if (mode === 'activity') {
      this.lastStatus = initialContent;
      this.actualBody = '';
      this.actualHudRevision = 0;
      this.actualText = [null, null, null, null];
      this.actualImages = [null, null, null, null];
    }
  }

  private async write(target: { id: number; name: string }, content: string): Promise<void> {
    if (this.lastBody.get(target.id) === content) return;
    const result = await this.runBridge(() =>
      this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: target.id,
          containerName: target.name,
          content: content.slice(0, 2000),
          contentOffset: 0,
          contentLength: 0,
        }),
      ),
    );
    if (!result) throw new Error(`G2 rejected text update for ${target.name}`);
    this.lastBody.set(target.id, content);
  }

  async setStatus(text: string): Promise<void> {
    const clipped = truncateToStatusLines(text) || ' ';
    if (clipped === this.lastStatus) return;
    // Idle has no status container by design. Keep the next active status
    // ready without waking a full UI back onto the lenses.
    if (this.mode === 'idle') {
      this.lastStatus = clipped;
      return;
    }
    const result = await this.runBridge(() =>
      this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: STATUS.id,
          containerName: STATUS.name,
          content: clipped,
          contentOffset: 0,
          contentLength: 0,
        }),
      ),
    );
    if (!result) throw new Error('G2 rejected status update');
    this.lastStatus = clipped;
  }

  /** A single short line while Carvis is actively hearing or working. */
  async showActivity(text: string): Promise<void> {
    await this.setMode('activity', text);
    await this.setStatus(text);
    this.actualBody = '';
  }

  /** The transparent resting state, with only the optional mute indicator. */
  async showIdle(): Promise<void> {
    await this.setMode('idle');
    this.actualBody = this.indicator ? '.' : '';
    this.actualHudRevision = 0;
    this.actualText = [null, null, null, null];
    this.actualImages = [null, null, null, null];
  }

  setSelection(slot:number|null):void{
    if(this.selectedSlot!==slot){this.selectedSlot=slot;this.forceNextRebuild=true;}
  }

  /** The resting display: whatever Carvis has bound to the four slots. */
  async showGrid(
    hud: HudState,
    loadImage: (slot: number, revision: number) => Promise<Blob>,
  ): Promise<void> {
    await this.setMode('grid');
    let complete = true;
    // An image placeholder cannot be reliably erased into a text layer on all
    // firmware versions. Rebuild only on this structural transition; ordinary
    // frame refreshes stay flicker-free.
    if ([...this.visibleImages].some((i) => !hud.slots[i]?.data?.image)) {
      const result = await this.runBridge(() =>
        this.bridge.rebuildPageContainer(
          new RebuildPageContainer({
          menuObject:new MenuContainerProperty({menuItems:[new MenuItemProperty({itemName:'Clear screen',itemID:1})]}),
            containerTotalNum: 10,
            textObject: [statusContainer(this.lastStatus || ' ', false), ...this.gridContainers(), this.dotContainer()],
            imageObject: this.gridImageContainers(),
          }),
        ),
      );
      if (!result) throw new Error('G2 rejected camera-to-text layout');
      this.lastBody.clear();
      this.lastImageRevision.clear();
      this.visibleImages.clear();
      this.resetGridActual();
    }
    for (let i = 0; i < SLOTS.length; i++) {
      const widget = hud.slots[i];
      await this.write(SLOTS[i], renderWidget(widget));
      const image = widget?.data?.image;
      this.actualText[i] = image ? null : renderedTextSlot(widget, i + 1);
      if (image) {
        const imageKey = `${image.entity_id}:${image.revision}`;
        if (this.lastImageRevision.get(i) === imageKey) continue;
        try {
          const blob = await loadImage(i + 1, image.revision);
          if (!blob.size || (blob.type && !blob.type.startsWith('image/'))) {
            throw new Error(`camera returned ${blob.type || 'empty data'}`);
          }
          const frame = await fitCameraFrame(blob, slotImageWidth(), slotImageHeight());
          const result = await withTimeout(
            this.runBridge(() =>
              this.bridge.updateImageRawData(
                new ImageRawDataUpdate({
                  containerID: IMAGES[i].id,
                  containerName: IMAGES[i].name,
                  // The SDK accepts base64, but its primary/host-native path is
                  // number[] (Dart List<int>). Sending the encoded PNG bytes as
                  // a string works in the simulator and has failed silently on
                  // hardware; use the representation the native host expects.
                  imageData: frame.pngBytes,
                }),
              ),
            ),
            7000,
            'camera frame transfer',
          );
          if (String(result).toLowerCase() !== 'success') {
            throw new Error(
              `camera frame rejected: ${String(result)} (${frame.pngBytes.length} PNG bytes)`,
            );
          }
          this.lastImageRevision.set(i, imageKey);
          this.visibleImages.add(i);
          this.actualImages[i] = {
            slot: i + 1,
            kind: 'camera',
            title: String(widget?.data?.title || 'Camera').slice(0, 100),
            value: 'frame displayed',
            entityId: String(image.entity_id || ''),
            imageRevision: image.revision,
            // Keep base64 only for the Mac's exact-frame WebUI mirror. These
            // are the same PNG bytes that the bridge accepted above.
            frameBase64: frame.base64,
          };
          console.log(
            `HUD camera frame displayed: slot ${i + 1}, revision ${image.revision}, ${frame.pngBytes.length} PNG bytes`,
          );
          if (this.cameraError.startsWith(`slot ${i + 1}:`)) this.cameraError = '';
        } catch (err) {
          complete = false;
          this.cameraError = `slot ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`HUD camera slot ${i + 1} failed`, err);
        }
      } else {
        this.actualImages[i] = null;
        if (this.cameraError.startsWith(`slot ${i + 1}:`)) this.cameraError = '';
      }
    }
    this.actualBody = '';
    if (complete) this.actualHudRevision = hud.revision;
  }

  private resetGridActual(): void {
    this.actualBody = '';
    this.actualHudRevision = 0;
    this.actualText = [null, null, null, null];
    this.actualImages = [null, null, null, null];
  }
}

/**
 * One slot. Two lines: a small label and the value, because on a display you
 * glance at, the label is what tells you which number you are looking at.
 */
function renderWidget(widget: HudWidget | null): string {
  if (!widget) return ' ';
  if (widget.data?.image) return ' ';
  const title = String(widget.data?.title || '').slice(0, 22);
  const value = String(widget.data?.value || '').slice(0, 60);
  const lines = title ? [title] : [];
  lines.push(...wrap(value, 26).slice(0, 4));
  return lines.join('\n') || ' ';
}

function renderedTextSlot(widget: HudWidget | null, slot: number): ActualDisplaySlot | null {
  if (!widget || widget.data?.image) return null;
  const title = String(widget.data?.title || '').slice(0, 22);
  const value = wrap(String(widget.data?.value || '').slice(0, 60), 26).slice(0, 4).join('\n');
  if (!title && !value) return null;
  return { slot, kind: 'text', title, value };
}

function slotImageWidth(): number {
  return Math.floor(DISPLAY.width / 2) - 4;
}

function slotImageHeight(): number {
  return Math.floor((DISPLAY.height - DISPLAY.statusHeight) / 2) - 4;
}

/** Crop to the slot, then quantize/contrast-boost for the G2's 16 green shades. */
async function fitCameraFrame(
  blob: Blob,
  width: number,
  height: number,
): Promise<{ base64: string; pngBytes: number[] }> {
  const decoded = await decodeImage(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('canvas is unavailable');

    const scale = Math.max(width / decoded.width, height / decoded.height);
    const drawWidth = decoded.width * scale;
    const drawHeight = decoded.height * scale;
    context.drawImage(decoded.source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);

    const frame = context.getImageData(0, 0, width, height);
    for (let i = 0; i < frame.data.length; i += 4) {
      const luma = frame.data[i] * 0.299 + frame.data[i + 1] * 0.587 + frame.data[i + 2] * 0.114;
      const contrasted = Math.max(0, Math.min(255, (luma - 128) * 1.25 + 128));
      const gray4 = Math.round(contrasted / 17) * 17;
      frame.data[i] = gray4;
      frame.data[i + 1] = gray4;
      frame.data[i + 2] = gray4;
      frame.data[i + 3] = 255;
    }
    context.putImageData(frame, 0, 0);
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    if (!base64) throw new Error('camera PNG encoding failed');
    return { base64, pngBytes: decodeBase64Bytes(base64) };
  } finally {
    decoded.close();
  }
}

/** Convert an encoded PNG from the canvas into the SDK's preferred List<int>. */
function decodeBase64Bytes(base64: string): number[] {
  const binary = atob(base64);
  const bytes = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function decodeImage(blob: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }

  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('camera image decode failed'));
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let slow = false;
  const timer = window.setTimeout(() => {
    slow = true;
    console.warn(`${label} exceeded ${ms}ms; waiting to preserve bridge ordering`);
  }, ms);
  try {
    const result = await promise;
    if (slow) console.warn(`${label} eventually completed`);
    return result;
  } finally {
    window.clearTimeout(timer);
  }
}
