import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { projectRuntimeConfig, runtimeEnvironment, integrationConfigFromLegacy, SECTION_OWNERS, merge } from './assistant-config.js';

const workerFile = fileURLToPath(new URL('../integrations/assistant-runtime/server/index.js', import.meta.url));
const instances = new WeakMap();
const prefix = '/integrations/assistant-engine';
const glassesRoutes = new Set([
  'POST /api/voice/audio', 'POST /api/voice/transcript', 'GET /api/glasses/feed',
  'POST /api/glasses/confirmation', 'POST /api/glasses/display', 'GET /api/glasses/display/frame',
  'GET /api/glasses/speech', 'POST /api/glasses/speech/ack', 'POST /api/glasses/speech/settings',
  'POST /api/glasses/hud/interact', 'GET /api/glasses/hud/image', 'POST /api/hud/clear',
]);
const physicalRoutes = new Set(['POST /api/physical-carvis/report', 'GET /api/physical-carvis/commands', 'POST /api/physical-carvis/ack']);
function same(a, b) {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length > 0 && aa.length === bb.length && timingSafeEqual(aa, bb);
}
async function readJson(req, limit = 128000) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Error('Send JSON content.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Error('Request is too large.'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Send a JSON object.');
  return value;
}
function sendJson(res, value) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
export function runtimeFor(registry) {
  if (!instances.has(registry)) instances.set(registry, new AssistantRuntime(registry));
  return instances.get(registry);
}
export class AssistantRuntime {
  constructor(registry) {
    this.registry = registry; this.store = registry.store; this.pending = new Map();
    this.child = null; this.port = 0; this.tail = Promise.resolve(); this.closed = false;
    this.confirmations = new Map();
    this.cancelled = new Set();
  }
  enabled() { return this.store.config.integrations['assistant-engine']?.enabled === true; }
  ready() { return !!this.child && !!this.port; }
  status() { return { success: this.ready(), connected: this.ready(), paused: process.env.CARVIS_RUNTIME_PAUSED === '1', message: this.ready() ? 'Assistant services are running.' : 'Assistant services are stopped.' }; }
  refresh() {
    const run = async () => {
      await this.stopWorker();
      if (this.enabled() && !this.closed) await this.startWorker();
    };
    this.tail = this.tail.then(run, run);
    return this.tail;
  }
  async startWorker() {
    const directory = join(this.store.directory, 'assistant-runtime');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cfg = projectRuntimeConfig(this.store);
    const configPath = join(directory, 'config.json');
    writeFileSync(`${configPath}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(`${configPath}.tmp`, configPath);
    this.secret = randomBytes(32).toString('base64url');
    const logFd = openSync(join(directory, 'runtime.log'), 'a', 0o600);
    try {
      this.child = fork(workerFile, [], {
        cwd: dirname(workerFile),
        env: { ...process.env, ...runtimeEnvironment(this.store), CARVIS_RUNTIME_DIR: directory, CARVIS_RUNTIME_SECRET: this.secret },
        stdio: ['ignore', logFd, logFd, 'ipc'],
      });
    } finally { closeSync(logFd); }
    const child = this.child;
    await new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Assistant services did not start. Check the private runtime log.')); }, 20000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', () => {
        clearTimeout(timeout);
        if (this.child === child) { this.child = null; this.port = 0; }
        for (const [id, task] of this.pending) { clearTimeout(task.timeout); task.reject(Error('Assistant services restarted. Check the execution trace before retrying an action.')); this.pending.delete(id); }
        if (!ready) reject(Error('Assistant services could not start. Check the private runtime log.'));
        else if (this.enabled() && !this.closed && !this.stopping) {
          this.registry.health.set('assistant-engine', 'error');
          // Restart the process without replaying interrupted requests or actions.
          clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => this.refresh().catch(() => {}), 2000);
          this.restartTimer.unref();
        }
      });
      child.on('message', message => {
        if (message?.type === 'ready') {
          ready = true; clearTimeout(timeout); this.port = message.port;
          this.registry.health.set('assistant-engine', 'connected'); resolve();
        } else if (message?.type === 'config_changed' && message.config) {
          this.persistRuntimeConfig(message.config);
        } else if (message?.type === 'integration_call') {
          this.integrationCall(message).then(result => { if (child.connected) child.send({ type: 'integration_result', id: message.id, result }); }, error => { if (child.connected) child.send({ type: 'integration_result', id: message.id, error: error.message }); });
        } else if (message?.id && this.pending.has(message.id)) {
          const task = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(task.timeout);
          message.error ? task.reject(Error(message.error)) : task.resolve(message.result);
        }
      });
    });
    await this.exchange('integrations', await this.integrationSnapshot());
  }
  async integrationSnapshot() {
    const tools = [], contexts = [];
    for (const [id, module] of this.registry.modules) {
      if (id in SECTION_OWNERS || !this.registry.available(id)) continue;
      const ctx = this.registry.contextFor(id);
      try {
        for (const tool of await module.tools?.(ctx) || []) tools.push({ name: tool.name, description: tool.description, schema: tool.parameters, readOnly: tool.readOnly === true });
      } catch { this.registry.health.set(id, 'tool catalog unavailable'); }
      try {
        const context = await module.context?.(ctx);
        if (context) contexts.push(`${module.name}: ${context}`);
      } catch { contexts.push(`${module.name}: current context unavailable.`); this.registry.health.set(id, 'context unavailable'); }
    }
    return this.registry.sanitize({ tools, context: contexts.join('\n\n') });
  }
  async integrationCall(message) {
    if (this.cancelled.has(message.context?.integrationRequestId)) throw Error('Request cancelled.');
    const tool = await this.registry.describe(message.name);
    if (this.cancelled.has(message.context?.integrationRequestId)) throw Error('Request cancelled.');
    if (!tool || tool.integrationId in SECTION_OWNERS) throw Error('That extension tool is not available through this bridge.');
    const trigger = message.context?.triggerType;
    const foreground = ['user_voice', 'user_text'].includes(trigger);
    const turn = foreground && this.turn?.id === message.context?.integrationRequestId ? this.turn : null;
    const source = !foreground ? 'background' : turn?.source || (trigger === 'user_voice' || message.context?.source === 'glasses' ? 'device' : 'chat');
    turn?.signal?.throwIfAborted();
    const result = await this.registry.invoke(message.name, message.args, { source, confirmed: false, signal: turn?.signal, reason: turn?.text || message.context?.reason || '', userText: turn?.text || message.context?.reason || '', conversationId: turn?.conversationId });
    if (result?.confirmation) turn?.emit('confirmation', result.confirmation);
    turn?.emit('tool', { name: message.name, status: result?.success === false ? 'error' : 'done', detail: result?.error || result?.message || (result?.requiresConfirmation ? 'Waiting for confirmation.' : 'Integration returned a result.') });
    return this.registry.sanitize(result);
  }
  async confirmationResolved(pending, decision, result) {
    if (!this.ready()) return;
    await this.exchange('clear_external_confirmation', { id: pending.id });
    if (pending.tool !== 'assistant_request') {
      const text = result.message || result.error || (decision === 'declined' ? 'Declined.' : '');
      if (text) await this.exchange('reply', { text, source: 'integration' });
    }
  }
  persistRuntimeConfig(cfg) {
    // The child is trusted implementation code. Its model-facing tools cannot
    // configure plugins. Only its owner settings routes may change these values.
    const projected = integrationConfigFromLegacy(cfg, runtimeEnvironment(this.store));
    for (const [id, entry] of Object.entries(projected)) {
      const current = this.store.config.integrations[id];
      if (!current) continue;
      const fields = new Set((this.registry.modules.get(id)?.fields || []).map(f => f.key));
      for (const [key, value] of Object.entries(entry.config)) {
        if (id === 'even-realities' && ['publicBaseUrl', 'microphoneEnabled', 'speechBaseUrl', 'speechApiKey', 'speechModel', 'speechLanguage'].includes(key)) continue;
        if (fields.has(key)) current.config[key] = value;
      }
    }
    this.store.plugin('assistant-engine').set('legacyConfig', cfg);
    this.store.saveConfig();
    this.confirmations.clear();
  }
  async stopWorker() {
    clearTimeout(this.restartTimer); this.confirmations.clear();
    const child = this.child; this.port = 0;
    if (!child) return;
    this.stopping = true;
    await new Promise(resolve => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    });
    if (this.child === child) this.child = null;
    this.stopping = false;
  }
  async close() { this.closed = true; await this.tail.catch(() => {}); await this.stopWorker(); }
  async call(method, args = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (!this.enabled()) throw Error('Enable the Advanced assistant Integration.');
    await this.tail;
    if (!this.ready()) await this.refresh();
    signal?.throwIfAborted();
    return this.exchange(method, args, { signal });
  }
  exchange(method, args = {}, { signal } = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false, timeout;
      const cancelWorkerRequest = () => {
        if (method === 'request' && args.requestId) {
          this.cancelled.add(args.requestId);
          while (this.cancelled.size > 1000) this.cancelled.delete(this.cancelled.values().next().value);
          try {
            if (this.child?.connected) this.child.send({ method: 'cancel', args: { requestId: args.requestId } }, () => {});
          } catch { /* A disconnected child can no longer receive new work. */ }
        }
      };
      const finish = (callback, value, cancel = false) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
        if (cancel) cancelWorkerRequest();
        callback(value);
      };
      const abort = () => finish(reject, signal.reason || Error('Request cancelled.'), true);
      timeout = setTimeout(() => finish(reject, Error('Assistant request timed out. Check its trace before retrying.'), true), 180000);
      this.pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error), timeout });
      signal?.addEventListener('abort', abort, { once: true });
      // Covers an already-aborted signal and an abort while attaching the hook.
      if (signal?.aborted) { abort(); return; }
      try {
        this.child.send({ id, method, args }, error => { if (error) finish(reject, error); });
      } catch (error) { finish(reject, error); }
    });
  }
  async respond(request) {
    if (this.turn) throw Error('Carvis is already responding.');
    this.turn = { ...request, id: randomUUID() };
    let result;
    try { result = await this.call('request', { requestId: this.turn.id, text: request.text, source: request.source, conversationId: request.conversationId, history: request.history, memory: request.memory, executionRecords:request.executionRecords }, request); }
    finally { this.turn = null; }
    if (result?.outcome === 'error') throw Error(result.error || 'Assistant request failed.');
    if (result?.confirmation) {
      const c = result.confirmation;
      this.confirmations.set(c.id, { id: c.id, tool: 'assistant_request', summary: c.prompt, source: request.source, conversationId: request.conversationId, hash: this.registry.configHash(), expiresAt: c.expiresAt });
      request.emit('confirmation', { ...c, summary: c.prompt, integrationId: 'assistant-engine' });
    }
    for (const call of result?.actions || result?.calls || []) request.emit('tool', {
      name: call.name || call.tool || 'assistant', status: call.ok === false ? 'error' : 'done', detail: call.error || (call.ok === false ? 'Action failed; see execution trace.' : 'See the Integration execution trace for details.'),
    });
    const quiet = result?.quiet === true;
    const reply = quiet ? '' : result?.reply || result?.confirmation?.prompt || result?.reason || '';
    return { ...result, reply, silent: quiet, handled: true };
  }
  async confirm(id, accepted, options = {}) {
    const pending = this.confirmations.get(id);
    if (!pending || pending.expiresAt < Date.now()) throw Error('This confirmation expired. Ask again.');
    if (options.source === 'device' && pending.source !== 'device') throw Error('This confirmation belongs to the owner chat.');
    this.confirmations.delete(id);
    if (pending.hash !== this.registry.configHash()) throw Error('Integration settings changed. Ask again before confirming.');
    const result = await this.call('confirm', { id, accepted });
    result.success = result.ok !== false && result.outcome !== 'error';
    result.declined = !accepted;
    result.message = result.reply || result.message || result.error || (accepted ? 'Request processed. Inspect its execution trace for action details.' : 'Declined.');
    await this.registry.recordConfirmation(pending, accepted ? 'approved' : 'declined', result);
    return result;
  }
  matchRoute(method, path) {
    return path === prefix || path.startsWith(`${prefix}/`) || glassesRoutes.has(`${method} ${path}`) || physicalRoutes.has(`${method} ${path}`);
  }
  deviceRoute(method, path) { return glassesRoutes.has(`${method} ${path}`) || physicalRoutes.has(`${method} ${path}`); }
  authorizeDevice(req, path) {
    if (!this.enabled()) return false;
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const entry = this.store.config.integrations;
    if (entry['even-realities']?.enabled && glassesRoutes.has(`${req.method} ${path}`)) return same(token, entry['even-realities'].config?.pairingToken);
    if (entry['physical-carvis']?.enabled && physicalRoutes.has(`${req.method} ${path}`)) {
      return same(token || req.headers['x-carvis-core-token'], projectRuntimeConfig(this.store).physicalCarvis.deviceToken);
    }
    return false;
  }
  async proxy(req, res, parsed) {
    if (!this.enabled()) throw Object.assign(Error('Assistant services are disabled.'), { status: 404 });
    await this.tail;
    if (!this.ready()) await this.refresh();
    const path = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) || '/' : parsed.pathname;
    if (req.method === 'GET' && ['/', '/index.html', '/live.html'].includes(path)) {
      res.writeHead(302, { Location: path === '/live.html' ? '/#integrations/voice/controls' : '/#integrations/assistant-engine/controls', 'Cache-Control': 'no-store' });
      res.end(); return;
    }
    if (path === '/api/config' && req.method === 'POST') {
      if (req.carvisAuthenticatedAs !== 'owner') throw Error('Only the owner can configure Integrations.');
      const patch = await readJson(req);
      const allowed = new Set([...Object.values(SECTION_OWNERS).flat(), 'ha', 'entities', 'areaNotes', 'appleTv']);
      for (const key of Object.keys(patch)) if (!allowed.has(key)) throw Error(`Configure ${key} through the main Carvis settings.`);
      const raw = await this.call('config');
      const preserveBlankSecrets = (previous, value) => Object.fromEntries(Object.entries(value).filter(([key]) => !['__proto__', 'prototype', 'constructor'].includes(key)).map(([key, item]) => [key,
        item === '' && /(?:key|token|secret)$/i.test(key) ? previous?.[key] || '' : item && typeof item === 'object' && !Array.isArray(item) ? preserveBlankSecrets(previous?.[key], item) : item]));
      const next = merge(raw, preserveBlankSecrets(raw, patch));
      const projected = integrationConfigFromLegacy(next, runtimeEnvironment(this.store));
      for (const [id, entry] of Object.entries(projected)) {
        const module = this.registry.modules.get(id);
        if (module && this.store.config.integrations[id]?.enabled) await module.validateConfig({ ...this.store.config.integrations[id].config, ...entry.config });
      }
      if (patch.carvis?.personality !== undefined) this.store.config.profile.personality = String(patch.carvis.personality).slice(0, 2000);
      if (patch.models) {
        const role = next.models.roles.carvis, provider = next.models.providers.find(p => p.id === role.provider);
        if (provider && ['openai', 'ollama'].includes(provider.kind)) {
          this.store.config.model = { ...this.store.config.model, provider: provider.kind === 'ollama' ? 'ollama' : 'openai', baseUrl: provider.kind === 'ollama' ? provider.baseUrl.replace(/\/v1\/?$/, '') + '/v1' : provider.baseUrl, model: role.model, apiKey: runtimeEnvironment(this.store)[provider.apiKeyEnv] || '' };
        }
      }
      this.persistRuntimeConfig(next);
      await this.refresh();
      const state = await this.call('state');
      return sendJson(res, { ok: true, config: state.config });
    }
    let suppliedBody;
    if (path === '/api/glasses/confirmation' && req.method === 'POST') {
      const value = await readJson(req);
      if (this.registry.pending.has(value.id)) {
        if (typeof value.accepted !== 'boolean') throw Error('Choose accept or decline.');
        const result = await this.registry.confirm(value.id, value.accepted, { source: req.carvisAuthenticatedAs === 'device' ? 'device' : 'chat' });
        return sendJson(res, { ok: result.success !== false, ...result, confirmation: null });
      }
      suppliedBody = Buffer.from(JSON.stringify(value));
    }
    if (path === '/api/restart') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, supervised: true }));
      setImmediate(() => this.refresh().catch(() => {})); return;
    }
    await new Promise((resolve, reject) => {
      const upstream = http.request({ hostname: '127.0.0.1', port: this.port, path: path + parsed.search, method: req.method,
        headers: { ...req.headers, ...(suppliedBody ? { 'content-length': suppliedBody.length } : {}), host: `127.0.0.1:${this.port}`, origin: `http://127.0.0.1:${this.port}`, 'x-carvis-internal': this.secret, 'x-carvis-client': req.carvisAuthenticatedAs || 'owner', authorization: '' } }, response => {
        for (const [key, value] of Object.entries(response.headers)) {
          if (!['connection', 'transfer-encoding', 'access-control-allow-origin', 'access-control-allow-headers', 'set-cookie'].includes(key)) res.setHeader(key, value);
        }
        res.statusCode = response.statusCode;
        response.pipe(res); response.on('end', resolve); response.on('error', reject);
      });
      upstream.on('error', reject);
      res.on('close', () => upstream.destroy());
      let bytes = 0;
      req.on('data', part => { bytes += part.length; if (bytes > 7_000_000) { upstream.destroy(); res.destroy(); } });
      if (suppliedBody) upstream.end(suppliedBody); else req.pipe(upstream);
    });
  }
}
