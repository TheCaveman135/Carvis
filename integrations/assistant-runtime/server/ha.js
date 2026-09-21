import { log } from './log.js';
import {appleTvEntities} from './apple-tv.js';

function toWsUrl(httpUrl) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/+$/, '') + '/api/websocket';
  u.search = '';
  return u.toString();
}

/**
 * Home Assistant client.
 *
 * Live state comes over the WebSocket API (states + state_changed events +
 * the area/device/entity registries so we can group by room). Service calls go
 * over REST, which keeps the call/response handling simple.
 */
export class HAClient {
  constructor() {
    this.url = '';
    this.token = '';
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    this.states = new Map(); // entity_id -> state object
    this.areas = new Map(); // area_id -> { area_id, name }
    this.entityAreas = new Map(); // entity_id -> area_id
    this.deviceAreas = new Map(); // device_id -> area_id
    this.entityDevices = new Map(); // entity_id -> device_id
    this.entityPlatforms = new Map(); // entity_id -> integration platform
    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this.error = '';
    this.haVersion = '';
    this.reconnectDelay = 2000;
    this.reconnectTimer = null;
    this.closedByUs = false;
    this.onStateChanged = null; // (entity_id, newState, oldState) => void
    this.onRegistriesChanged = null; // () => void
    this.registryRefreshTimer = null;
    this.pingTimer = null;
    this.onStatus = null; // () => void
  }

  configure(url, token) {
    const nextUrl = (url || '').replace(/\/+$/, '');
    const nextToken = token || '';
    const changed = nextUrl !== this.url || nextToken !== this.token;
    this.url = nextUrl;
    this.token = nextToken;
    if (changed) this.reconnect();
  }

  setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    this.onStatus?.();
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  disconnect() {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.registryRefreshTimer);
    clearTimeout(this.pingTimer);
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
    for (const { reject } of this.pending.values()) reject(new Error('disconnected'));
    this.pending.clear();
    this.setStatus('disconnected');
  }

  connect() {
    if (!this.url || !this.token) {
      this.setStatus('disconnected', 'Home Assistant URL and token not set');
      return;
    }
    this.closedByUs = false;
    clearTimeout(this.reconnectTimer);
    this.setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(toWsUrl(this.url));
    } catch (err) {
      this.setStatus('error', `Bad URL: ${err.message}`);
      return;
    }
    this.ws = ws;

    ws.addEventListener('message', (ev) => this.#onMessage(ev, ws));
    ws.addEventListener('error', () => {
      // The close handler does the reporting; 'error' carries no useful detail.
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      clearTimeout(this.pingTimer);
      this.ws = null;
      for (const { reject } of this.pending.values()) reject(new Error('socket closed'));
      this.pending.clear();
      if (this.closedByUs) return;
      if (this.status !== 'error') this.setStatus('disconnected', 'Connection lost');
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    });
  }

  async #onMessage(ev, ws) {
    // Closing a socket does not cancel already queued messages or bootstrap
    // promises. An old connection must never update its replacement's state.
    if (this.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'auth_required') {
      this.haVersion = msg.ha_version || '';
      ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
      return;
    }
    if (msg.type === 'auth_invalid') {
      this.setStatus('error', 'Auth rejected — check the long-lived access token');
      this.closedByUs = true; // a bad token will not fix itself; wait for new config
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (msg.type === 'auth_ok') {
      try {
        await this.#bootstrap(ws);
        if (this.ws !== ws) return;
        this.reconnectDelay = 2000;
        this.setStatus('connected');
        this.#schedulePing(ws);
        log('info', `Connected to Home Assistant ${this.haVersion} — ${this.states.size} entities`);
      } catch (err) {
        if (this.ws !== ws) return;
        this.setStatus('error', `Bootstrap failed: ${err.message}`);
        // An authenticated but unsynchronized socket is unusable. Closing it
        // lets the existing backoff reconnect and retry the full bootstrap.
        ws.close();
      }
      return;
    }
    if (msg.type === 'result' || msg.type === 'pong') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.success === false) p.reject(new Error(msg.error?.message || 'command failed'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.type === 'event') {
      if (msg.event?.event_type === 'state_changed') {
        const { entity_id, new_state, old_state } = msg.event.data;
        if (new_state) this.states.set(entity_id, new_state);
        else this.states.delete(entity_id);
        this.onStateChanged?.(entity_id, new_state, old_state);
      } else if (/^(area|device|entity)_registry_updated$/.test(msg.event?.event_type || '')) {
        this.#scheduleRegistryRefresh();
      }
    }
  }

  send(payload, ws = this.ws) {
    return new Promise((resolve, reject) => {
      if (!ws || ws !== this.ws || ws.readyState !== 1) return reject(new Error('not connected'));
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout on ${payload.type}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        ws.send(JSON.stringify({ ...payload, id }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  #schedulePing(ws) {
    clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(async () => {
      if (this.ws !== ws) return;
      try {
        await this.send({ type: 'ping' }, ws);
        if (this.ws === ws) this.#schedulePing(ws);
      } catch (err) {
        if (this.ws !== ws) return;
        this.setStatus('error', `Connection check failed: ${err.message}`);
        ws.close();
      }
    }, 30_000);
    this.pingTimer.unref?.();
  }

  async #bootstrap(ws) {
    const states = await this.send({ type: 'get_states' }, ws);
    if (this.ws !== ws) return;
    this.states = new Map(states.map((s) => [s.entity_id, s]));
    await this.#loadRegistries(ws);
    if (this.ws !== ws) return;
    await Promise.all([
      this.send({ type: 'subscribe_events', event_type: 'state_changed' }, ws),
      this.send({ type: 'subscribe_events', event_type: 'area_registry_updated' }, ws),
      this.send({ type: 'subscribe_events', event_type: 'device_registry_updated' }, ws),
      this.send({ type: 'subscribe_events', event_type: 'entity_registry_updated' }, ws),
    ]);
  }

  async #loadRegistries(ws = this.ws) {
    // Registry access needs an admin token. Without it we still work, just
    // without room grouping — so a failure here is a warning, not fatal.
    try {
      const [areas, devices, entities] = await Promise.all([
        this.send({ type: 'config/area_registry/list' }, ws),
        this.send({ type: 'config/device_registry/list' }, ws),
        this.send({ type: 'config/entity_registry/list' }, ws),
      ]);
      if (this.ws !== ws) return;
      this.areas = new Map(areas.map((a) => [a.area_id, { area_id: a.area_id, name: a.name }]));
      this.deviceAreas = new Map(devices.map((d) => [d.id, d.area_id]).filter(([, areaId]) => Boolean(areaId)));
      this.entityAreas = new Map();
      this.entityDevices = new Map();
      this.entityPlatforms = new Map();
      for (const e of entities) {
        if (e.platform) this.entityPlatforms.set(e.entity_id, e.platform);
        if (e.device_id) this.entityDevices.set(e.entity_id, e.device_id);
        const areaId = e.area_id || this.deviceAreas.get(e.device_id) || null;
        if (areaId) this.entityAreas.set(e.entity_id, areaId);
      }
      this.onRegistriesChanged?.();
    } catch (err) {
      if (this.ws !== ws) return;
      log('warn', `Could not read HA registries (${err.message}). Rooms will show as "Unassigned".`);
    }
  }

  areaNameFor(entityId) {
    const areaId = this.entityAreas.get(entityId)
      || this.deviceAreas.get(this.entityDevices.get(entityId));
    return (areaId && this.areas.get(areaId)?.name) || 'Unassigned';
  }

  #scheduleRegistryRefresh() {
    clearTimeout(this.registryRefreshTimer);
    this.registryRefreshTimer = setTimeout(() => {
      this.registryRefreshTimer = null;
      this.#loadRegistries();
    }, 250);
    this.registryRefreshTimer.unref?.();
  }

  friendlyName(entityId) {
    return this.states.get(entityId)?.attributes?.friendly_name || entityId;
  }

  platformFor(entityId) {
    return this.entityPlatforms.get(entityId) || '';
  }

  /** Every entity, shaped for the entity picker in the UI. */
  listEntities() {
    return [...this.states.values()]
      .map((s) => ({
        entity_id: s.entity_id,
        domain: s.entity_id.split('.')[0],
        name: s.attributes?.friendly_name || s.entity_id,
        area: this.areaNameFor(s.entity_id),
        state: s.state,
        device_class: s.attributes?.device_class || null,
        unit: s.attributes?.unit_of_measurement || null,
        last_changed: s.last_changed,
      }))
      .sort((a, b) => a.area.localeCompare(b.area) || a.entity_id.localeCompare(b.entity_id));
  }

  async callService(domain, service, data, { returnResponse = false, timeoutMs = 15_000 } = {}) {
    const targets = Array.isArray(data?.entity_id) ? data.entity_id : [data?.entity_id];
    if (targets.some(id => appleTvEntities(this.getConfig?.()).has(id))) {
      if (targets.length !== 1 || !this.appleTv) throw new Error('Apple TV commands require the Apple TV AI controller. No direct fallback is available.');
      return this.appleTv.command(domain,service,{...data,entity_id:targets[0]});
    }
    const suffix = returnResponse ? '?return_response' : '';
    const res = await fetch(`${this.url}/api/services/${domain}/${service}${suffix}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(120_000, Number(timeoutMs) || 15_000))),
    });
    if (!res.ok) throw new Error(`HA ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json().catch(() => null);
  }

  /**
   * Read one state directly from Home Assistant and refresh the local mirror.
   *
   * Service calls acknowledge receipt, not completion.  This matters most for
   * a lock: a successful HTTP response must never be presented as "locked" or
   * "unlocked" before HA itself says so.  Keeping this narrow helper here also
   * means callers never need the HA credential.
   */
  async refreshState(entityId) {
    const id = String(entityId || '').trim();
    if (!id) throw new Error('entity id is required');
    const res = await fetch(`${this.url}/api/states/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) {
      this.states.delete(id);
      return null;
    }
    if (!res.ok) throw new Error(`HA ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const state = await res.json();
    if (state?.entity_id) this.states.set(state.entity_id, state);
    return state || null;
  }

  /**
   * Wait for HA's authoritative state, rather than treating a service 200 as
   * proof a physical action finished.  The websocket mirror is checked first
   * and direct REST reads close the race where its state_changed event arrives
   * a few seconds after the service response.
   */
  async waitForState(entityId, expected, { timeoutMs = 8_000, pollMs = 250 } = {}) {
    const wanted = new Set((Array.isArray(expected) ? expected : [expected]).map((value) => String(value)));
    const read = () => this.states.get(entityId) || null;
    let current = read();
    if (current && wanted.has(String(current.state))) return current;

    const deadline = Date.now() + Math.max(250, Number(timeoutMs) || 8_000);
    let nextRefreshAt = 0;
    while (Date.now() < deadline) {
      if (Date.now() >= nextRefreshAt) {
        try {
          current = await this.refreshState(entityId);
        } catch (err) {
          // The final response below still reports the last known state. A
          // transient verification read must not turn a completed command into
          // an unhandled request failure.
          log('warn', `Could not verify ${entityId} state: ${err.message}`);
        }
        nextRefreshAt = Date.now() + 750;
      }
      current = read() || current;
      if (current && wanted.has(String(current.state))) return current;
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, Number(pollMs) || 250)));
    }
    return read() || current || null;
  }

  /** Fetch one current camera still without ever exposing the HA token. */
  async cameraImage(entityId, {maxBytes=8*1024*1024} = {}) {
    if (!String(entityId).startsWith('camera.')) throw new Error('camera image requires a camera entity');
    if (!this.states.has(entityId)) throw new Error(`no entity ${entityId}`);
    const res = await fetch(`${this.url}/api/camera_proxy/${encodeURIComponent(entityId)}?time=${Date.now()}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HA camera ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const reader=res.body.getReader(),chunks=[];let size=0;
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.length;
      if(size>maxBytes){await reader.cancel();throw new Error('Camera image exceeds the size limit');}
      chunks.push(value);
    }
    const bytes=Buffer.concat(chunks);
    if (!bytes.length) throw new Error('HA returned an empty camera frame');
    return {
      bytes,
      contentType: res.headers.get('content-type') || 'image/jpeg',
    };
  }

  /** One-shot credential check used by the "Test connection" button. */
  static async test(url, token) {
    const base = (url || '').replace(/\/+$/, '');
    const res = await fetch(`${base}/api/`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) throw new Error('401 Unauthorized — token rejected');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
