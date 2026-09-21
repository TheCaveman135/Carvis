/**
 * Talking to your Carvis server.
 *
 * Two directions: utterances go up as raw PCM, and the feed comes down over a
 * long poll. The long poll is deliberate — a 1Hz poll loop on something you
 * wear is a battery decision as much as a networking one.
 */
export type FeedEntry = {
  id: string;
  seq: number;
  ts: number;
  kind: 'action' | 'reply' | 'note' | 'error' | 'heard';
  text: string;
  fullText?: string;
  detail: string;
};

export type HudInteraction={kind:"button"|"slider"|"dropdown";field?:string;min:number;max:number;step:number;options:{label:string}[]};

export type HudWidget = {
  widget_id?:string;
  interaction?:HudInteraction;
  slot: number;
  type: string;
  data: {
    title: string;
    value: string;
    image?: { entity_id: string; revision: number };
    control_value?: number;
    control_index?: number;
  };
  binding: Record<string, unknown> | null;
};

export type HudState = {
  revision: number;
  slots: (HudWidget | null)[];
  overlay: { id: string; text: string; detail: string; until: number } | null;
  free: number;
};

export type Confirmation = {
  id: string;
  prompt: string;
  detail: string;
  createdAt: number;
  expiresAt: number;
};

export type ActualDisplaySlot = {
  slot: number;
  kind: 'text' | 'camera';
  title: string;
  value: string;
  entityId?: string;
  imageRevision?: number;
  /** Exact PNG bytes already accepted by updateImageRawData; server strips this from public state. */
  frameBase64?: string;
};

export type ActualDisplaySnapshot = {
  indicator: boolean;
  mode: 'grid' | 'overlay' | 'log' | 'confirmation' | 'activity' | 'idle';
  status: string;
  body: string;
  hudRevision: number;
  slots: (ActualDisplaySlot | null)[];
};

export type DisplayReport = ActualDisplaySnapshot & {
  /** Stable installation identity; survives foreground/background WebView migration. */
  clientId: string;
  /** A localhost-loaded dev build must not overwrite a live physical G2 mirror. */
  clientKind: 'g2' | 'simulator';
  sessionId: string;
  /** Lets the server reject a late report from an older WebView session. */
  sessionStartedAt: number;
  seq: number;
  active: boolean;
  renderedAt: number;
};

export type IngestResult = {
  ok: boolean;
  text?: string;
  outcome?: 'acted' | 'filed' | 'ignored' | 'error' | 'confirmation' | 'declined' | 'stale';
  reason?: string;
  error?: string;
  message?: string;
  confirmation?: Confirmation | null;
};

/**
 * None of `fetch`'s built-in behavior bounds how long a call can take — a
 * stalled connection (a wifi handoff, the Mac sleeping mid-request, a dropped
 * BLE-to-wifi bridge) leaves it pending forever. That single hang used to be
 * fatal: `pollLoop` is a bare `for (;;)` around one `await`, so one stuck
 * request froze the glasses' entire connection to Carvis — silently, with
 * nothing in `state.lastError` to explain why, because the call never
 * reached its `catch`. Every call here gets a hard ceiling so the loop that
 * owns it always gets control back and can retry.
 */
function withTimeout(ms: number, external?: AbortSignal): AbortSignal {
  if (!external) return AbortSignal.timeout(ms);
  // AbortSignal.any is broadly supported in modern WebViews, but this is a
  // device with no console to confirm that on — fall back to the plain
  // timeout rather than let a missing API break every network call.
  const anyFn = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof anyFn === 'function' ? anyFn([external, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** A public package never carries a destination or credential. */
export function normalizeConnection(baseUrl: string, token: string): {baseUrl: string; token: string} {
  let url: URL;
  try { url = new URL(baseUrl.trim()); }
  catch { throw new Error('Enter your full Carvis address, including https://.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Use HTTPS for your Carvis address. HTTP is only available for local development.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Use the Carvis server address without a username, password, query, or fragment.');
  }
  if (!token.trim()) throw new Error('Enter the pairing token from Carvis Integrations.');
  return {baseUrl: url.toString().replace(/\/+$/, ''), token: token.trim()};
}

export class CarvisClient {
  private baseUrl: string;
  private token: string;
  constructor(baseUrl: string, token: string) {
    this.baseUrl = '';
    this.token = '';
    if (baseUrl || token) {
      try { this.configure(baseUrl, token); }
      catch { this.baseUrl = ''; this.token = ''; }
    }
  }

  get configured(): boolean { return Boolean(this.baseUrl && this.token); }

  configure(baseUrl: string, token: string): void {
    const connection = normalizeConnection(baseUrl, token);
    this.baseUrl = connection.baseUrl;
    this.token = connection.token;
  }

  private headers(contentType: string): Record<string, string> {
    if (!this.configured) throw new Error('Enter your Carvis address and pairing token first.');
    return {
      'Content-Type': contentType,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /**
   * Send one utterance. A slow reply here is normal — Carvis is transcribing,
   * triaging and possibly calling a cloud model before it answers — so this
   * gets the most generous ceiling of any call.
   */
  async sendAudio(pcm: Uint8Array, signal?: AbortSignal): Promise<IngestResult> {
    const res = await fetch(`${this.baseUrl}/api/voice/audio`, {
      method: 'POST',
      headers: this.headers('application/octet-stream'),
      // Copy into a plain ArrayBuffer: a Uint8Array view over a larger buffer
      // would otherwise send the whole backing store.
      body: pcm.slice().buffer,
      signal: withTimeout(45_000, signal),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Typed text, for the simulator where there is no microphone. */
  async sendText(text: string): Promise<IngestResult> {
    const res = await fetch(`${this.baseUrl}/api/voice/transcript`, {
      method: 'POST',
      headers: this.headers('application/json'),
      body: JSON.stringify({ text }),
      signal: withTimeout(45_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Long poll. Resolves early when something happens, or empty on timeout.
   * `hudRevision` is what the glasses last drew — sending it lets the server
   * return immediately when a bound widget has moved on. The server's own
   * wait caps at 20s, so 25s of client-side headroom means a slow-but-honest
   * server response is never mistaken for a hang.
   */
  async pollFeed(
    since: number,
    hudRevision: number,
    signal?: AbortSignal,
    immediate = false,
  ): Promise<{
    entries: FeedEntry[];
    speech?: {outputMode: string};
    seq: number;
    confirmation: Confirmation | null;
    hud: HudState;
  }> {
    const res = await fetch(`${this.baseUrl}/api/glasses/feed?since=${since}&hud=${hudRevision}${immediate ? "&wait=0" : ""}`, {
      headers: this.headers('application/json'),
      signal: withTimeout(immediate ? 5000 : 25_000, signal),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async resolveConfirmation(
    id: string,
    accepted: boolean,
  ): Promise<IngestResult & { ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/glasses/confirmation`, {
      method: 'POST',
      headers: this.headers('application/json'),
      body: JSON.stringify({ id, accepted }),
      signal: withTimeout(8_000),
    });
    const body = await res.json();
    if (!res.ok && res.status !== 409) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  /** Report only bridge-acknowledged content, never the HUD we merely received. */
  async reportDisplay(report: DisplayReport): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/glasses/display`, {
      method: 'POST',
      headers: this.headers('application/json'),
      body: JSON.stringify(report),
      signal: withTimeout(8_000),
    });
    if (!res.ok) throw new Error(`display report HTTP ${res.status}`);
    await res.arrayBuffer();
  }

  async phonePoll(clientId: string, ready: boolean, signal?: AbortSignal): Promise<{command: {id:string;text:string} | null; outputMode:string; mediaPlayer:string}> {
    const res = await fetch(`${this.baseUrl}/api/glasses/speech?client=${encodeURIComponent(clientId)}&ready=${ready ? 1 : 0}`, {
      headers:this.headers('application/json'), signal:withTimeout(25_000, signal),
    });
    if (!res.ok) throw new Error(`Phone audio HTTP ${res.status}`);
    return res.json();
  }
  async phoneAck(clientId: string, id: string, success: boolean): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/glasses/speech/ack`, {method:'POST',headers:this.headers('application/json'),body:JSON.stringify({clientId,id,success}),signal:withTimeout(5000)});
    if (!res.ok) throw new Error(`Phone audio acknowledgement HTTP ${res.status}`);
  }
  async setSpeechOutput(outputMode: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/glasses/speech/settings`, {method:'POST',headers:this.headers('application/json'),body:JSON.stringify({outputMode}),signal:withTimeout(5000)});
    if (!res.ok) throw new Error(`Speaker setting HTTP ${res.status}`);
  }

  /** Camera bytes stay off the normal JSON poll so a frame never bloats it. */
  async interactWidget(action:{slot:number;widget_id:string;value?:number;index?:number}) {
    const res=await fetch(`${this.baseUrl}/api/glasses/hud/interact`,{method:'POST',headers:this.headers('application/json'),body:JSON.stringify({...action,request_id:typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `gesture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}),signal:withTimeout(15000)});
    const result=await res.json();if(!res.ok)throw Error(result.error || 'Widget action failed');return result as {success:boolean;error?:string;dry_run?:boolean;confirmation?:Confirmation;hud?:HudState};
  }
  async clearHud():Promise<void>{
    const res=await fetch(`${this.baseUrl}/api/hud/clear`,{method:'POST',headers:this.headers('application/json'),body:'{}',signal:withTimeout(5000)});
    if(!res.ok)throw Error('Could not clear HUD');
  }

  async fetchHudImage(slot: number, revision: number): Promise<Blob> {
    const res = await fetch(
      `${this.baseUrl}/api/glasses/hud/image?slot=${slot}&revision=${revision}`,
      { headers: this.headers('application/octet-stream'), cache: 'no-store', signal: withTimeout(15_000) },
    );
    if (!res.ok) throw new Error(`camera HTTP ${res.status}`);
    return res.blob();
  }
}
