import { HostMicrophone, speakLocal, stopLocalPlayback } from './host-audio.js';
import {IntegrationBridge} from './integration-bridge.js';
import {enabled, effectiveConfig, toolFeature, routeFeature, paused} from './features.js';
import {visibleModelInput} from './entity-visibility.js';
import {HudInteractions} from './hud-interaction.js';
import { PatternLearner } from './patterns.js';
import { PreferenceLearner } from './preference-learner.js';
import { conversationStore } from './conversation-store.js';
import { PhoneSpeaker } from './phone-speaker.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig as rawConfig, saveConfig, publicConfig, ROOT, SOURCE_ROOT, CONFIG_PATH, MODEL_ROLES } from './config.js';
import { log, recentLogs, subscribe, broadcast } from './log.js';
import { HAClient } from './ha.js';
import { Agent } from './agent.js';
import * as models from './models.js';
import { replyStream, extractRule, buildChatContext } from './chat.js';
import { SERVICES_BY_DOMAIN, requiresLiveOwner, requiresOwnerConfirmation } from './guards.js';
import { AtlasClient, testAtlas } from './atlas.js';
import { MacBridge } from './mac.js';
import { Feed } from './feed.js';
import { Voice } from './voice.js';
import { Transcriber } from './stt.js';
import { open as openDb, costSummary, recentTrace, recordToolCall } from './db.js';
import { bus, normalizeHaChange } from './events.js';
import { WorldState } from './world.js';
import { ToolGateway } from './tools/gateway.js';
import { buildTools } from './tools/index.js';
import { AutomationEngine } from './automations.js';
import { Carvis } from './carvis.js';
import { Hud } from './hud.js';
import { MemoryStore } from './memory.js';
import { GlassesDisplay } from './glasses-display.js';
import { EventClassifier } from './classifier.js';
import { Sessions } from './session.js';
import { randomBytes } from 'node:crypto';
import { PhysicalCarvis } from './physical-carvis.js';
import { VoiceOutput } from './voice-output.js';
import { AppleTvController } from './apple-tv.js';
import { Vision, IMAGE_LIMIT } from './vision.js';
import { internalRequest, isAuthorisedRequest, hasAccount, createAccount, verifyPassword, issueSession, sessionUser, sessionCookie, clearSessionCookie, isSameOriginRequest, LoginAttemptLimiter } from './auth.js';
import { listModels as listGeminiModels } from './search.js';

if (!process.env.CARVIS_RUNTIME_DIR || !process.env.CARVIS_RUNTIME_SECRET || process.env.CARVIS_RUNTIME_SECRET.length < 32 || !process.send) throw new Error('Start the assistant runtime through its parent integration worker.');
function loadConfig() {return effectiveConfig(rawConfig());}
const cfg = loadConfig();
const loginAttempts = new LoginAttemptLimiter();

function loginPeer(req) {
  return String(req?.socket?.remoteAddress || 'unknown');
}

// Home Assistant instances often use a self-signed cert on the LAN address.
// Opt-in only, and loud about it, because it is a process-wide setting.
if (enabled(cfg,'home-assistant') && cfg.ha.allowInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[tls] Certificate verification disabled (ha.allowInsecureTls = true)');
}

const ha = new HAClient();
const vision = new Vision({ha,getConfig:loadConfig,getMemory:()=>enabled(loadConfig(),'learned-memory') ? memory : null});
ha.onRegistriesChanged = () => broadcast({ type: 'ha-registries' });
const agent = new Agent(ha, loadConfig);
const atlas = new AtlasClient(loadConfig);
const mac = new MacBridge(loadConfig);
const physicalCarvis = new PhysicalCarvis({
  getConfig: loadConfig,
  onChange: (state) => broadcast({ type: 'physical-carvis', physicalCarvis: state }),
});
const phoneSpeaker = new PhoneSpeaker();
let hostMicrophone;
const voiceOutput = new VoiceOutput({ getConfig: loadConfig, ha, physicalCarvis, phoneSpeaker,localSpeaker:(text,device)=>speakLocal(text,device,{onStart:()=>{if(hostMicrophone)hostMicrophone.speakingOutput=true;},onEnd:()=>{setTimeout(()=>{if(hostMicrophone)hostMicrophone.speakingOutput=false;},500);}}) });
const feed = new Feed(loadConfig, { onEntry: (entry) => {process.send?.({type:"reply",entry});return enabled(loadConfig(),"speech") ? voiceOutput.speakReply(entry) : undefined;} });
const glassesDisplay = new GlassesDisplay({
  onChange: (state) => broadcast({ type: 'glasses-display', glassesDisplay: state }),
});
const stt = new Transcriber(loadConfig);

openDb();

const worldState = new WorldState(ha, loadConfig);
const gateway = new ToolGateway(loadConfig);
const cancelledRequests = new Set();
gateway.isCancelled = id => Boolean(id && cancelledRequests.has(id));

// Protocols wake Carvis and Carvis authors protocols, so one of them has to be
// bound late. The thunk keeps the dependency one-directional at construction.
let carvis;
let voice;

const hud = new Hud(loadConfig, { ha, worldState, atlas, feed });
if (enabled(cfg,'even-realities')) hud.start();

const sessions = new Sessions({ getConfig: loadConfig, bus, worldState, atlas });

// Before Carvis: the prompt reads from it on every turn, and the tools need it
// at registration below.
const memory = new MemoryStore(loadConfig);
memory.start({rulesOnly: !enabled(cfg,'learned-memory')});

/**
 * House rules used to be one opaque newline-joined string at
 * `agent.houseRules`. They are memories now (`kind: 'rule'`), so an existing
 * config has to hand its lines over once. Done here rather than in
 * `migrate()` because config.js has no access to the memory store, and it
 * only writes the config back after every line is safely in memory — a
 * half-migrated rule set would silently loosen the constraints the owner set.
 */
try {
  const saved = loadConfig().agent?.houseRules;
  if (enabled(cfg,'learned-memory') && typeof saved === 'string') {
    const lines = saved
      .split('\n')
      .map((line) => line.trim().replace(/^[-*]\s*/, ''))
      .filter(Boolean);
    for (const text of lines) memory.remember({ text, kind: 'rule', source: 'owner' });
    const next = structuredClone(rawConfig());
    delete next.agent.houseRules;
    saveConfig(next);
    if (lines.length) log('info', `Moved ${lines.length} house rule(s) into memory`);
  }
} catch (err) {
  log('error', `Could not move house rules into memory: ${err.message}`);
}

const patterns = new PatternLearner({getConfig:loadConfig,ha,worldState,feed,path:path.join(ROOT,'patterns.json')});
const preferenceLearner = new PreferenceLearner({getConfig: loadConfig, gateway});
carvis = new Carvis({
  patterns: enabled(cfg,'learned-memory') ? patterns : null,
  onConversation: text => {if (enabled(loadConfig(),'learned-memory') && !paused()) preferenceLearner.observe(text);},
  conversationStore: conversationStore(path.join(ROOT, 'conversation.json')),
  getConfig: loadConfig,
  gateway,
  worldState,
  atlas,
  feed,
  mac,
  hud: enabled(cfg,'even-realities') ? hud : null,
  sessions: enabled(cfg,'proactivity') ? sessions : null,
  memory: enabled(cfg,'learned-memory') ? memory : null,
  onTrace: () => broadcast({ type: 'trace', trace: recentTrace(25) }),
});
const automations = new AutomationEngine({
  bus,
  gateway,
  ha,
  atlas,
  memory,
  hud,
  feed,
  getCarvisState: () => ({ ...carvis.state(), glassesConnected: glassesDisplay.state().connected }),
  getVoiceState: () => voice?.state() || {},
  getConfig: loadConfig,
  isHaReady: () => ha.status === 'connected',
  // Disabled, unreachable, and not-yet-fetched all mean "unknown", never an
  // empty project list. Rules using atlas.* therefore fail closed instead of
  // firing as if the owner had zero projects or tasks.
  isAtlasReady: () => loadConfig().atlas.enabled === true && atlas.status === 'ok' && Number(atlas.snapshot?.fetchedAt) > 0,
  onWake: ({ trigger }) => carvis.invoke({ trigger }),
  onChange: (event) => broadcast(event),
});
carvis.isCancelled = () => Boolean(carvis.integrationRequestId && cancelledRequests.has(carvis.integrationRequestId));
carvis.ownerRules = () => memory.rules().map(item => '- ' + item.text).join('\n');
carvis.automations = enabled(cfg,'protocols') ? automations : null;
ha.appleTv = new AppleTvController({
  ha, getConfig:loadConfig,
  onProgress:(run,ctx)=>{
    recordToolCall({id:`tv_${randomBytes(8).toString('hex')}`,invocationId:ctx.invocationId || null,ts:Date.now(),tool:'ha.apple_tv.progress',arguments:{id:run.id},risk:0,authorization:'allowed',ok:['running','completed'].includes(run.status),ms:0,
      result:{source:'apple_tv_ai',id:run.id,status:run.status,steps:run.steps,model:run.model,cost_usd:run.cost_usd,event_count:run.events?.length || 0}});
    broadcast({type:'trace',trace:recentTrace(25)});
  },
  onFinished:(run,ctx)=>{
    const reply=run.status==='completed' ? (run.completion_check?.confirmed===true ? `Apple TV: ${run.message || 'Task completed.'}` : 'The TV controller finished, but its result has not been independently verified.') : `Apple TV task ${run.status}: ${run.message || 'Ask me for the task status.'}`;
    feed.push('reply',reply,{source:ctx.replySource || 'apple_tv_ai'});
    carvis.rememberConversation('Apple TV task result',reply);
  },
});
gateway.registerAll(buildTools({
  ha, agent, atlas, mac, feed, automations, worldState, hud, glassesDisplay, memory, patterns, voiceOutput, vision, getConfig: loadConfig,
}));

const integrationBridge = new IntegrationBridge({gateway,send:message=>process.send(message),onConfirmation:confirmation=>{feed.push('heard',confirmation.prompt,{source:'confirmation'});broadcast({type:'confirmation',confirmation});}});
carvis.integrationContext = () => integrationBridge.context;

voice = new Voice({
  getConfig: loadConfig,
  carvis,
  atlas,
  feed,
  onTranscript: (transcript) => broadcast({ type: 'transcript', transcript }),
  onConfirmationChange: (confirmation) => broadcast({ type: 'confirmation', confirmation }),
});

/**
 * Home Assistant's raw state changes become semantic events. The executor's
 * own handler is preserved rather than replaced — it still needs every change
 * for its manual-override tracking, while the bus only carries the few that
 * mean something.
 */
const executorOnChange = ha.onStateChanged;
ha.onStateChanged = (entityId, newState, oldState) => {
  executorOnChange?.(entityId, newState, oldState);
  if (enabled(loadConfig(),'protocols') && !paused()) automations.handleHaChange(entityId, newState, oldState);
  try {
    const normalized = normalizeHaChange(entityId, newState, oldState, ha.areaNameFor(entityId));
    if (normalized) bus.publish(normalized.type, 'home_assistant', normalized.data);
  } catch (err) {
    log('warn', `Could not normalize ${entityId}: ${err.message}`);
  }
};

const classifier = new EventClassifier({
  memory,
  getConfig: loadConfig,
  bus,
  worldState,
  onWake: ({ trigger }) => carvis.invoke({ trigger }),
  isClaimed: (event) => automations.claimsEvent(event),
});

// Classifier subscribes first so its "is a protocol already covering this"
// dedup check sees a protocol's claim on an event before it decides whether to
// independently wake Carvis for the same thing.
if (enabled(cfg,'proactivity') && !paused()) classifier.start();
if (enabled(cfg,'protocols') && !paused()) automations.start();
if (enabled(cfg,'proactivity') && !paused()) sessions.start();

// Loading the model takes a few seconds and warming Metal a few more, so start
// it at boot rather than making the first thing you say pay for both.
if (enabled(cfg,'voice') && cfg.stt.enabled) stt.start();

ha.onStatus = () => {
  if (ha.status === 'connected' && enabled(loadConfig(),'protocols') && !paused()) automations.baseline('home_assistant_connected');
  broadcast({ type: 'status' });
};
ha.getConfig = loadConfig;
if (enabled(cfg,'home-assistant')) ha.configure(cfg.ha.url, cfg.ha.token);

// Atlas is optional and frequently asleep behind a dropped tunnel, so nothing
// here is allowed to be fatal — a failed probe just leaves it 'unreachable'.
if (enabled(cfg,'atlas') && cfg.atlas.enabled && !paused()) {
  atlas.health().then(() => atlas.refresh(true)).catch(() => {});
  setInterval(() => {
    if (loadConfig().atlas.enabled) atlas.refresh().catch(() => {});
  }, 60_000).unref();
}

/**
 * Binding to anything but loopback puts a microphone-driven controller for
 * your home on the network, so it must carry a token. This is the one setting
 * where a quiet default would be the wrong call.
 */
function bindWarning(config) {
  if (config.server.host === '127.0.0.1' || config.server.host === 'localhost') return '';
  if (config.glasses.token) return '';
  return `Carvis is bound to ${config.server.host} with no glasses token set — anyone on the network can control the home. Set a token in Settings, or bind to 127.0.0.1 and reach it through a tunnel.`;
}
if (bindWarning(cfg)) log('warn', bindWarning(cfg));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
    ...headers,
  });
  res.end(payload);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

/** Raw bytes, for audio. Capped at 30s of 16kHz mono 16-bit PCM. */
function readBinary(req, limit = 16000 * 2 * 30) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('audio too long — send one utterance at a time'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function snapshot() {
  const config = loadConfig();
  return {
    config: publicConfig(),
    status: agent.status(),
    entities: ha.status === 'connected' ? ha.listEntities().map(e => ({...e, automaticGuard: requiresLiveOwner(e.entity_id, ha.states.get(e.entity_id)) ? 'protected' : 'standard', effectiveGuard: requiresLiveOwner(e.entity_id, ha.states.get(e.entity_id), config) ? 'protected' : 'standard'})) : [],
    logs: recentLogs(150),
    configPath: CONFIG_PATH,
    roles: models.roleStatus(config),
    roleInfo: MODEL_ROLES,
    voice: voice.state(),
    transcript: voice.transcriptState(),
    atlas: atlas.state(),
    mac: mac.state(),
    feed: feed.state(),
    stt: stt.state(),
    hostMicrophone: hostMicrophone?.state() || {listening:false},
    carvis: carvis.state(),
    hud: hud.state(),
    glassesDisplay: glassesDisplay.state(),
    classifier: classifier.state(),
    physicalCarvis: physicalCarvis.state(),
    speechOutput: voiceOutput.state(),
    phoneSpeaker: phoneSpeaker.state(),
    session: sessions.state(),
    automations: automations.state(),
    events: bus.recentEvents(20),
    cost: costSummary(),
    trace: recentTrace(25),
    tools: gateway.inventory(),
    bindWarning: bindWarning(config),
  };
}

function isPhysicalCarvisDeviceRoute(key) {
  return key === 'POST /api/physical-carvis/report'
    || key === 'GET /api/physical-carvis/commands'
    || key === 'POST /api/physical-carvis/ack';
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(SOURCE_ROOT, 'web', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(path.join(SOURCE_ROOT, 'web'))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}

hostMicrophone = new HostMicrophone({onAudio:async pcm=>{
  const config=loadConfig();
  if(!enabled(config,'voice')||!config.voice.enabled||!config.stt.enabled||config.voice.inputMuted)return;
  const heard=await stt.transcribe(pcm);
  if(heard.text&&!loadConfig().voice.inputMuted)await voice.ingest(heard.text,{source:'server-microphone',confidence:heard.confidence});
}});
const hostAudioConfig=loadConfig();
if(enabled(hostAudioConfig,'voice')&&hostAudioConfig.voice.enabled&&hostAudioConfig.stt.enabled&&!hostAudioConfig.voice.inputMuted&&hostAudioConfig.voice.inputDevice?.startsWith('local:'))void hostMicrophone.start(hostAudioConfig.voice.inputDevice.slice(6));

const hudInteractions = new HudInteractions({hud,ha,getConfig:loadConfig,gateway,voice});

const routes = {
  // ── Browser login ──────────────────────────────────────────────
  'GET /api/auth/status': async (req, res) => {
    const config = loadConfig();
    const configured = hasAccount(config);
    const user = sessionUser(req, config);
    sendJson(res, 200, { ok: true, configured, authenticated: Boolean(user), username: user || '' });
  },

  'POST /api/auth/setup': async (req, res) => {
    if (!isSameOriginRequest(req)) return sendJson(res, 403, { ok: false, message: 'Open Carvis directly to create the first account.' });
    const config = loadConfig();
    if (hasAccount(config)) return sendJson(res, 409, { ok: false, message: 'Carvis already has an account. Sign in instead.' });
    const { username, password } = await readBody(req);
    try {
      const auth = createAccount(username, password);
      const next = structuredClone(rawConfig());
      next.auth = auth;
      saveConfig(next);
      const token = issueSession(next);
      log('info', `Carvis account created for ${auth.username}`);
      sendJson(res, 201, { ok: true, username: auth.username }, { 'Set-Cookie': sessionCookie(token) });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: err.message });
    }
  },

  'POST /api/auth/login': async (req, res) => {
    if (!isSameOriginRequest(req)) return sendJson(res, 403, { ok: false, message: 'Open Carvis directly to sign in.' });
    const peer = loginPeer(req);
    const gate = loginAttempts.check(peer);
    if (!gate.ok) {
      return sendJson(res, 429, {
        ok: false,
        message: 'Too many incorrect sign-in attempts. Wait a few minutes and try again.',
      }, { 'Retry-After': String(gate.retryAfterSeconds) });
    }
    const config = loadConfig();
    if (!hasAccount(config)) return sendJson(res, 409, { ok: false, message: 'Set up the first Carvis account first.' });
    const { username, password } = await readBody(req);
    if (!verifyPassword(config, username, password)) {
      loginAttempts.fail(peer);
      return sendJson(res, 401, { ok: false, message: 'Incorrect username or password.' });
    }
    loginAttempts.succeed(peer);
    sendJson(res, 200, { ok: true, username: config.auth.username }, { 'Set-Cookie': sessionCookie(issueSession(config)) });
  },

  // ── Physical Carvis core / dock ───────────────────────────────
  // Pairing is owner-authenticated by the normal route guard. The portable
  // core uses the generated device token only for its three narrow endpoints
  // below; it never receives browser/session authority.
  'POST /api/physical-carvis/pair': async (req, res) => {
    const { regenerate = false } = await readBody(req);
    const current = rawConfig();
    let token = current.physicalCarvis?.deviceToken || '';
    if (!token || regenerate === true) {
      const next = structuredClone(current);
      token = randomBytes(32).toString('hex');
      next.physicalCarvis = { ...current.physicalCarvis, deviceToken: token };
      saveConfig(next);
      broadcast({ type: 'physical-carvis', physicalCarvis: physicalCarvis.state() });
    }
    sendJson(res, 200, {
      ok: true,
      token,
      protocol: {
        report: 'POST /api/physical-carvis/report',
        commands: 'GET /api/physical-carvis/commands?core_id=<id>&after=<seq>',
        acknowledge: 'POST /api/physical-carvis/ack',
      },
    });
  },

  'POST /api/physical-carvis/report': async (req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, core: physicalCarvis.report(body) });
  },

  'GET /api/physical-carvis/commands': async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const core_id = url.searchParams.get('core_id');
    const after = Number(url.searchParams.get('after') || 0);
    sendJson(res, 200, { ok: true, ...physicalCarvis.pending(core_id, after) });
  },

  'POST /api/physical-carvis/ack': async (req, res) => {
    const { core_id, command_id, ok = true, detail = '' } = await readBody(req);
    sendJson(res, 200, { ok: true, acknowledgement: physicalCarvis.acknowledge(core_id, command_id, { ok, detail }) });
  },

  'POST /api/auth/logout': async (_req, res) => {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  },

  'GET /api/state': async (req, res) => sendJson(res, 200, snapshot()),

  'GET /api/events': async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', ...snapshot() })}\n\n`);
    const unsubscribe = subscribe((msg) => {
      const body = msg.type === 'status' ? { type: 'status', status: agent.status() } : msg;
      res.write(`data: ${JSON.stringify(body)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  },

  'POST /api/config': async (_req,res) => sendJson(res,409,{ok:false,message:'Update integration settings through the parent Carvis UI.'}),

  'POST /api/ha/test': async (req, res) => {
    const body = await readBody(req);
    const url = body.url || loadConfig().ha.url;
    const token = body.token || loadConfig().ha.token;
    try {
      const info = await HAClient.test(url, token);
      sendJson(res, 200, { ok: true, message: info.message || 'API running' });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message });
    }
  },

  'GET /api/models': async (req, res) => {
    const config = loadConfig();
    sendJson(res, 200, {
      providers: config.models.providers.map((p) => ({
        ...p,
        // Whether the key is *there* is useful; the key itself is not.
        keyAvailable: !p.apiKeyEnv || Boolean(process.env[p.apiKeyEnv]),
      })),
      roles: models.roleStatus(config),
      roleInfo: MODEL_ROLES,
    });
  },

  'GET /api/models/list': async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const provider = url.searchParams.get('provider');
    try {
      sendJson(res, 200, { ok: true, models: await models.listModels(loadConfig(), provider) });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message, models: [] });
    }
  },

  'GET /api/search/models': async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, models: await listGeminiModels(loadConfig()) });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message, models: [] });
    }
  },

  /** Kept so an older bookmark or the eval script does not 404. */
  'GET /api/ollama/models': async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, models: await models.listModels(loadConfig(), 'ollama') });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message, models: [] });
    }
  },

  // ── Voice ────────────────────────────────────────────────────────
  /**
   * One finalised utterance from the glasses. Interim ASR text must not come
   * here — Carvis would act on a half-heard sentence.
   */
  'POST /api/voice/transcript': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    const { text } = await readBody(req);
    const result = await voice.ingest(text, { source: 'glasses' });
    sendJson(res, 200, { ok: true, ...result, seq: feed.seq });
  },

  /** Clears the owner-only, memory-resident transcript screen. */
  'POST /api/voice/transcript/clear': async (_req, res) => {
    const cleared = voice.clearTranscript();
    sendJson(res, 200, { ok: true, cleared, transcript: voice.transcriptState() });
  },

  /**
   * One utterance of raw PCM from the glasses — 16kHz, mono, signed 16-bit LE,
   * exactly as `audioEvent.audioPcm` delivers it. Transcribed here and fed
   * straight into the same pipeline as typed text.
   *
   * Mute lives entirely on the glasses: a muted G2 never calls this route at
   * all, so there is nothing to check here.
   */
  'POST /api/voice/audio': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    const config = loadConfig();
    const audioSource=new URL(req.url,'http://localhost').searchParams.get('source')==='browser'?'browser':'even-glasses';
    if(config.voice.inputDevice && (config.voice.inputMuted || config.voice.inputDevice!==audioSource))return sendJson(res,200,{ok:true,outcome:'ignored',reason:config.voice.inputMuted?'microphone muted':'another microphone is selected'});
    if (!config.stt.enabled) return sendJson(res, 200, { ok: false, message: 'speech to text is switched off' });

    let pcm;
    try {
      pcm = await readBinary(req);
    } catch (err) {
      return sendJson(res, 413, { ok: false, message: err.message });
    }

    const durationMs = (pcm.length / 2 / 16000) * 1000;
    if (durationMs < config.stt.minMs) {
      return sendJson(res, 200, { ok: true, outcome: 'ignored', reason: 'too short' });
    }

    let heard;
    try {
      heard = await stt.transcribe(pcm);
    } catch (err) {
      log('error', `Transcription failed: ${err.message}`);
      return sendJson(res, 200, { ok: false, message: err.message });
    }
    const text = heard.text;
    if (!text) return sendJson(res, 200, { ok: true, outcome: 'ignored', reason: 'nothing said', text: '' });

    const source = new URL(req.url, 'http://localhost').searchParams.get('source') === 'browser' ? 'browser' : 'glasses';
    const result = await voice.ingest(text, { source, confidence: heard.confidence });
    sendJson(res, 200, {
      ok: true,
      text,
      sttMs: stt.lastMs,
      confidence: heard.confidence,
      ...result,
      seq: feed.seq,
    });
  },

  'GET /api/voice/microphone': async (_req,res) => sendJson(res,200,hostMicrophone.state()),
  'GET /api/stt': async (req, res) => sendJson(res, 200, stt.state()),

  // ── Carvis ───────────────────────────────────────────────────────
  /** Everything Carvis is waiting for, and everything it has recently done. */
  'GET /api/carvis': async (req, res) =>
    sendJson(res, 200, {
      carvis: carvis.state(),
      events: bus.recentEvents(30),
      trace: recentTrace(20),
      cost: costSummary(),
      tools: gateway.inventory(),
    }),

  /* ── Memory — the owner's own view onto what memory.remember() writes ── */
  'GET /api/memories': async (req, res) =>
    sendJson(res, 200, { ok: true, memories: memory.all(), state: memory.state(), patterns: patterns.list() }),

  'POST /api/patterns/dismiss': async (req, res) => {
    const {id} = await readBody(req);
    const result = patterns.dismiss(id);
    sendJson(res,result.success ? 200 : 400,{ok:result.success,message:result.error});
  },

  'POST /api/memories': async (req, res) => {
    const { text, kind } = await readBody(req);
    try {
      const { memory: saved, status } = memory.remember({ text, kind, source: 'owner' });
      sendJson(res, 200, { ok: true, status, memory: saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: err.message });
    }
  },

  'POST /api/memories/update': async (req, res) => {
    const { id, text, kind, pinned } = await readBody(req);
    const result = memory.update(id, { text, kind, pinned });
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, memory: result.memory, message: result.error });
  },

  'POST /api/memories/delete': async (req, res) => {
    const { id } = await readBody(req);
    // Same rule as the memory.forget tool: an owner-authored memory can only
    // be removed by the owner, and this route IS the owner acting — 'owner',
    // never 'carvis', is the only correct value here.
    const result = memory.forget(id, { by: 'owner' });
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, message: result.error });
  },

  /** Privacy-filtered, read-only operational trace — never prompts or hidden reasoning. */
  'GET /api/carvis/trace': async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    sendJson(res, 200, recentTrace(url.searchParams.get('limit')));
  },

  /** A typed owner request from the Tailnet-only Web UI. */
  'POST /api/carvis/request': async (req, res) => {
    const { text, image_ids=[] } = await readBody(req);
    if(!Array.isArray(image_ids) || image_ids.length>4 || image_ids.some(id=>typeof id!=='string'))return sendJson(res,400,{message:'Attach up to four images.'});
    try{image_ids.forEach(id=>vision.image(id));}catch(error){return sendJson(res,400,{message:error.message});}
    const request=image_ids.length ? `${String(text || 'Describe this image.')}\nAttached image IDs for vision.inspect: ${image_ids.join(', ')}` : text;
    const result = await voice.request(request, { source: 'web' });
    sendJson(res, 200, { ok: true, ...result, seq: feed.seq });
  },

  'POST /api/vision/image': async (req,res)=>{
    if(!isSameOriginRequest(req))return sendJson(res,403,{message:'Open Carvis directly to attach an image.'});
    if(Number(req.headers['content-length'])>IMAGE_LIMIT)return sendJson(res,413,{message:'Images must be no larger than 6 MB.'});
    try{sendJson(res,201,await vision.upload(await readBinary(req,IMAGE_LIMIT)));}
    catch(error){if(!res.destroyed)sendJson(res,400,{message:error.message});}
  },
  'POST /api/vision/remove':async(req,res)=>{
    if(!isSameOriginRequest(req))return sendJson(res,403,{message:'Open Carvis directly.'});
    const {id}=await readBody(req);vision.remove(id);sendJson(res,200,{ok:true});
  },

  'GET /api/tv/status': async (_req,res)=>{
    try {const result=await gateway.call('ha.apple_tv.status',{},{triggerType:'user_text',confirmed:false});sendJson(res,result.success?200:404,result);}
    catch {sendJson(res,503,{success:false,message:'TV controller is unavailable. Try refreshing.'});}
  },
  'GET /api/tv/frame': async (_req,res)=>{
    const cfg=loadConfig();
    if(![...(cfg.entities.observed || []),...(cfg.entities.controlled || [])].includes(cfg.appleTv?.mediaPlayer))return sendJson(res,404,{message:'TV preview is unavailable.'});
    try {const bytes=await ha.appleTv.frame();res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);}
    catch {sendJson(res,503,{message:'TV preview is unavailable. Try refreshing.'});}
  },

  'POST /api/carvis/clear': async (req, res) => {
    carvis.clearHistory();
    sendJson(res, 200, { ok: true });
  },

  // ── Deterministic automations ─────────────────────────────────
  'GET /api/automations': async (_req, res) => sendJson(res, 200, { ok: true, ...automations.state() }),

  'GET /api/automations/catalog': async (_req, res) => sendJson(res, 200, { ok: true, ...automations.catalog() }),

  'POST /api/automations/get': async (req, res) => {
    const { id } = await readBody(req);
    const rule = automations.get(id);
    sendJson(res, rule ? 200 : 404, rule ? { ok: true, rule } : { ok: false, message: `no automation ${id}` });
  },

  'POST /api/automations/save': async (req, res) => {
    const { definition, expectedRevision } = await readBody(req);
    try {
      const rule = automations.save(definition, { expectedRevision, createdBy: 'owner' });
      sendJson(res, 200, { ok: true, rule });
    } catch (err) {
      const status = err.code === 'revision_conflict' ? 409 : 400;
      sendJson(res, status, { ok: false, message: err.message, errors: err.errors || [], currentRevision: err.currentRevision });
    }
  },

  'POST /api/automations/validate': async (req, res) => {
    const { definition } = await readBody(req);
    const result = automations.validate(definition);
    sendJson(res, result.ok ? 200 : 400, result);
  },

  'POST /api/automations/test': async (req, res) => {
    const { definition, values, event, change, at } = await readBody(req);
    const result = automations.test(definition, { values, event, change, at });
    sendJson(res, result.ok ? 200 : 400, result);
  },

  'POST /api/automations/toggle': async (req, res) => {
    const { id, enabled } = await readBody(req);
    if (typeof enabled !== 'boolean') return sendJson(res, 400, { ok: false, message: 'enabled must be boolean' });
    const rule = automations.setEnabled(id, enabled);
    sendJson(res, rule ? 200 : 404, rule ? { ok: true, rule } : { ok: false, message: `no automation ${id}` });
  },

  'POST /api/automations/duplicate': async (req, res) => {
    const { id } = await readBody(req);
    const rule = automations.duplicate(id);
    sendJson(res, rule ? 200 : 404, rule ? { ok: true, rule } : { ok: false, message: `no automation ${id}` });
  },

  'POST /api/automations/archive': async (req, res) => {
    const { id } = await readBody(req);
    const archived = automations.archive(id);
    sendJson(res, archived ? 200 : 404, archived ? { ok: true, archived: id } : { ok: false, message: `no automation ${id}` });
  },

  'POST /api/automations/history': async (req, res) => {
    const { id, limit } = await readBody(req);
    sendJson(res, 200, { ok: true, runs: automations.history(id, limit) });
  },

  'POST /api/automations/run': async (req, res) => {
    const { id } = await readBody(req);
    const result = await automations.runNow(id);
    sendJson(res, result.ok ? 200 : 400, result);
  },

  /**
   * Publish a synthetic event.
   *
   * Protocols are the hardest thing here to test honestly, because verifying
   * one otherwise means waiting for a real print to finish. This fires the same
   * path a Home Assistant change takes — normalize, publish, match, wake — so
   * the wiring can be exercised without the hardware.
   */
  'POST /api/carvis/emit': async (req, res) => {
    const { type, data } = await readBody(req);
    if (!type) return sendJson(res, 400, { ok: false, message: 'an event needs a type' });
    const event = bus.publish(String(type), 'simulated', data || {});
    sendJson(res, 200, { ok: true, event });
  },

  /** Run one tool by hand, to check an adapter without going through a model. */
  'POST /api/carvis/tool': async (req, res) => {
    const { tool, arguments: args } = await readBody(req);
    // This diagnostic endpoint is typed input, not an authentication gesture.
    // In particular, neither a `wakeWord` nor `confirmed` field smuggled into
    // the arguments object can authorize a protected tool call: context is
    // constructed here and the accepted-confirmation bit is deliberately off.
    const result = await gateway.call(tool, args || {}, {
      triggerType: 'user_text',
      reason: 'manual test',
      wakeWord: false,
      confirmed: false,
    });
    sendJson(res, 200, result);
  },

  // ── Glasses ──────────────────────────────────────────────────────
  'POST /api/glasses/display': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    try {
      const result = glassesDisplay.report(await readBody(req, 1_000_000));
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: err.message });
    }
  },

  /** Exact quantized PNG last accepted by the G2 bridge; memory-only, never SQLite. */
  'GET /api/glasses/display/frame': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    const url = new URL(req.url, 'http://localhost');
    const frame = glassesDisplay.frame(url.searchParams.get('id'));
    if (!frame) return sendJson(res, 404, { ok: false, message: 'display frame not found' });
    res.writeHead(200, {
      'Content-Type': frame.contentType,
      'Content-Length': frame.bytes.byteLength,
      'Cache-Control': 'no-store, max-age=0',
      ...CORS_HEADERS,
    });
    res.end(frame.bytes);
  },

  'POST /api/glasses/confirmation': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    const { id, accepted } = await readBody(req);
    if (typeof accepted !== 'boolean') {
      return sendJson(res, 400, { ok: false, message: 'accepted must be true or false' });
    }
    if (req.headers['x-carvis-client'] === 'device' && !['glasses','device','physical'].includes(voice.pendingConfirmation?.source)) return sendJson(res,403,{ok:false,message:'Confirm this request in the owner interface.'});
    const result = await voice.resolveConfirmation(id, accepted);
    sendJson(res, result.ok ? 200 : 409, { ...result, confirmation: voice.confirmation });
  },

  /**
   * Long-poll. `since` is the last seq the glasses drew.
   *
   * The HUD rides along on the same response rather than needing its own poll:
   * a wearable holding two long-lived connections open costs battery for no
   * reason, and the two things change at similar moments anyway.
   */
  'GET /api/glasses/speech': async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ready = url.searchParams.get('ready') === '1';
    const command = await phoneSpeaker.poll(url.searchParams.get('client') || '', ready, url.searchParams.get('wait') !== '0');
    const speech = loadConfig().speech || {};
    sendJson(res, 200, {command, outputMode: speech.outputMode || 'physical_then_ha', mediaPlayer: speech.mediaPlayer || ''});
  },
  'POST /api/glasses/speech/ack': async (req, res) => {
    const {clientId, id, success} = await readBody(req);
    if (typeof success !== 'boolean') return sendJson(res, 400, {ok:false,message:'success must be boolean'});
    sendJson(res, 200, {ok:phoneSpeaker.acknowledge(clientId, id, success)});
  },
  'POST /api/glasses/speech/settings': async (req, res) => {
    const {outputMode} = await readBody(req);
    if (!['phone_only','ha_only','physical_then_ha','physical_only'].includes(outputMode)) return sendJson(res,400,{ok:false,message:'invalid speech output'});
    const cfg = rawConfig();
    saveConfig({...cfg, speech:{...cfg.speech, outputMode}});
    sendJson(res, 200, {ok:true, outputMode});
  },

  'POST /api/glasses/hud/interact': async(req,res)=>{
    if(!isAuthorisedRequest(req,loadConfig()))return sendJson(res,401,{message:'unauthorised'});
    try {sendJson(res,200,await hudInteractions.act(await readBody(req)));}
    catch(error){sendJson(res,400,{success:false,error:error.message});}
  },
  'GET /api/glasses/feed': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    const url = new URL(req.url, 'http://localhost');
    const since = Number(url.searchParams.get('since') || 0);
    const hudRevision = Number(url.searchParams.get('hud') || 0);
    const wait = url.searchParams.get('wait') !== '0';

    // Return straight away when the display is already out of date, otherwise
    // a bound widget ticking over would wait out the full poll before showing.
    const entries =
      wait && hud.revision === hudRevision ? await feed.wait(since, 20_000) : feed.since(since);

    sendJson(res, 200, {
      ok: true,
      entries,
      seq: feed.seq,
      confirmation: voice.confirmation || integrationBridge.confirmation(),
      hud: hud.state(),
      speech: {outputMode: loadConfig().speech?.outputMode || 'physical_then_ha'},
    });
  },

  'GET /api/hud': async (req, res) => sendJson(res, 200, hud.state()),

  'GET /api/glasses/hud/image': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    const url = new URL(req.url, 'http://localhost');
    const slot = Number(url.searchParams.get('slot'));
    const widget = hud.state().slots[slot - 1];
    const entityId = widget?.type === 'camera_image' ? widget.binding?.entity_id : '';
    if (!entityId) return sendJson(res, 404, { ok: false, message: 'that HUD slot is not a camera' });
    try {
      const frame = await ha.cameraImage(entityId);
      res.writeHead(200, {
        'Content-Type': frame.contentType,
        'Content-Length': frame.bytes.byteLength,
        'Cache-Control': 'no-store, max-age=0',
        'X-Carvis-Hud-Revision': String(widget.data?.image?.revision || hud.revision),
        ...CORS_HEADERS,
      });
      res.end(frame.bytes);
    } catch (err) {
      sendJson(res, 502, { ok: false, message: err.message });
    }
  },

  'POST /api/hud/clear': async (req, res) => {
    hud.clearAll();
    hud.dismissNotification();
    sendJson(res, 200, { ok: true });
  },

  // ── The Mac ──────────────────────────────────────────────────────
  /** Your Mac agent polls this and gets everything queued since last time. */
  'GET /api/mac/pending': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    sendJson(res, 200, { ok: true, intents: mac.claimPending() });
  },

  'POST /api/mac/ack': async (req, res) => {
    if (!isAuthorisedRequest(req, loadConfig())) return sendJson(res, 401, { ok: false, message: 'unauthorised' });
    const { id, ok = true, detail = '' } = await readBody(req);
    const intent = mac.acknowledge(id, Boolean(ok), detail);
    if (intent) {
      feed.push(ok ? 'action' : 'error', `Mac: ${intent.command} ${ok ? 'done' : 'failed'}`, { detail });
    }
    sendJson(res, 200, { ok: true, intent });
  },

  'POST /api/mac/dispatch': async (req, res) => {
    const { command, detail } = await readBody(req);
    try {
      sendJson(res, 200, { ok: true, intent: await mac.dispatch({ command, detail, source: 'ui' }) });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message });
    }
  },

  // ── Project Atlas ────────────────────────────────────────────────
  'POST /api/atlas/refresh': async (req, res) => {
    await atlas.health();
    await atlas.refresh(true);
    broadcast({ type: 'status' });
    sendJson(res, 200, { ok: atlas.status === 'ok', state: atlas.state(), error: atlas.error });
  },

  'POST /api/atlas/test': async (req, res) => {
    const body = await readBody(req);
    try {
      const info = await testAtlas(body.baseUrl || loadConfig().atlas.baseUrl);
      const token = await atlas.getToken();
      sendJson(res, 200, {
        ok: true,
        message: `Atlas ${info.version}, database ${info.database}. Writes ${token ? 'enabled' : 'unavailable — run: atlas token set'}.`,
      });
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        message: /fetch failed|ECONNREFUSED/i.test(err.message)
          ? 'No answer on the tunnel. Restart it: launchctl kickstart -k gui/$UID/com.projectatlas.ssh-tunnel'
          : err.message,
      });
    }
  },

  'POST /api/atlas/capture': async (req, res) => {
    const { text, title, projectId } = await readBody(req);
    try {
      const capture = await atlas.capture({ text, title, projectId, channel: 'carvis' });
      sendJson(res, 200, { ok: true, capture });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message });
    }
  },

  'POST /api/control': async (req, res) => {
    const { entity_id, service } = await readBody(req);
    const domain = String(entity_id || '').split('.')[0];
    if (!SERVICES_BY_DOMAIN[domain]?.includes(service)) {
      return sendJson(res, 400, { ok: false, message: `${service} not allowed on ${domain}` });
    }
    // Protected controls stage a confirmation (glasses swipe or the web UI's
    // own accept/decline) instead of acting immediately. This includes not
    // only explicit security/environment domains but also wellbeing-looking
    // ordinary entities and opaque scenes/scripts/buttons whose downstream
    // effects cannot be inspected from this request.
    const entityState = ha.states.get(entity_id);
    if (requiresOwnerConfirmation(entity_id, entityState, service, loadConfig())) {
      const label = ha.friendlyName(entity_id) || entity_id;
      const prompt = `${service.replace(/_/g, ' ')} ${label}?`.replace(/^./, (c) => c.toUpperCase());
      const result = voice.stageDirectConfirmation({
        prompt,
        entityId: entity_id,
        service,
        reason: `owner clicked ${service.replace(/_/g, ' ')} on ${entity_id} via the dashboard`,
      });
      return sendJson(res, 200, { ok: true, ...result });
    }
    try {
      const result = await gateway.call(
        requiresLiveOwner(entity_id, entityState, loadConfig()) ? 'ha.secure.command' : 'ha.entity.command',
        { entity_id, service },
        { triggerType: 'user_text', reason: 'manual dashboard control' },
      );
      if (result.success) agent.manualTouch.set(entity_id, Date.now());
      sendJson(res, result.success ? 200 : 400, { ok: result.success, ...result, message: result.error });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message });
    }
  },

  /**
   * Exactly what the Chat tab's model is handed, so "what can you see?" is
   * answerable from the UI without trusting the model to describe its own
   * context. Replaces the old `GET /api/agent/prompt`, which rendered the
   * autonomous heartbeat's decision prompt — a prompt nothing sends anymore.
   */
  'GET /api/chat/context': async (req, res) => {
    await atlas.refresh().catch(() => {});
    sendJson(res, 200, {
      ok: true,
      context: buildChatContext(agent, loadConfig(), {
        voice: voice.state(),
        atlas: atlas.state(),
        atlasContext: atlas.contextLines(),
        mac: mac.state(),
        rules: memory.rules(),
      }),
    });
  },

  'POST /api/chat': async (req, res) => {
    const { messages } = await readBody(req);
    const cfg = loadConfig();
    const history = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
    const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const emit = (obj) => res.write(`${JSON.stringify(obj)}\n`);

    try {
      models.resolve(cfg, 'chat');
    } catch (err) {
      emit({ type: 'error', message: `${err.message}. Pick one in the Models tab.` });
      return res.end();
    }

    // Rule extraction runs alongside the reply so the suggestion costs no
    // extra wall-clock. A failure here must not break the conversation.
    const rulePromise = lastUser && enabled(cfg,'learned-memory')
      ? extractRule(cfg, lastUser, memory.rules()).catch(() => null)
      : Promise.resolve(null);

    // Atlas is refreshed opportunistically here rather than on a tight timer,
    // so the chat sees current projects without polling a box that may be off.
    atlas.refresh().catch(() => {});
    const extras = {
      voice: voice.state(),
      conversation: carvis.recentConversation(),
      atlas: atlas.state(),
      atlasContext: atlas.contextLines(),
      mac: mac.state(),
      rules: memory.rules(),
    };

    let spokenReply = '';
    try {
      for await (const chunk of replyStream(agent, cfg, history, extras)) {
        emit({ type: 'chunk', text: chunk });
        spokenReply += chunk;
      }
    } catch (err) {
      emit({ type: 'error', message: err.message });
      feed.push('error', 'I could not finish that reply, sir.', { source: 'chat' });
      return res.end();
    }

    if (spokenReply.trim()) {
      feed.push('reply', spokenReply, { source: 'chat' });
      carvis.rememberConversation(lastUser, spokenReply);
    }
    const rule = await rulePromise;
    if (rule) emit({ type: 'rule', rule });
    emit({ type: 'done' });
    res.end();
  },

  /**
   * A house rule is a memory now, not a line in an opaque config string —
   * same store, same editing, same provenance as everything else Carvis
   * knows about the owner. `kind: 'rule'` is what makes it always-injected
   * and never-evicted; see server/memory.js.
   */
  'POST /api/rules/append': async (req, res) => {
    const { rule } = await readBody(req);
    // The chat suggestion arrives as a bullet; the store holds the claim.
    const text = String(rule || '').trim().replace(/^[-*]\s*/, '');
    if (!text) return sendJson(res, 400, { ok: false, message: 'empty rule' });

    try {
      const { memory: saved, status } = memory.remember({ text, kind: 'rule', source: 'owner' });
      log('info', `House rule added: ${text}`);
      broadcast({ type: 'status' });
      sendJson(res, 200, { ok: true, status, memory: saved, rules: memory.rules() });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: err.message });
    }
  },

  'POST /api/ha/reconnect': async (req, res) => {
    ha.reconnect();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/restart': async (req, res) => {
    sendJson(res, 200, { ok: true, supervised: isSupervised() });
    log('warn', 'Restarting the server…');
    broadcast({ type: 'restarting' });
    // Give the response and the SSE frame time to flush before we tear down.
    setTimeout(() => restart(), 250);
  },
};

function isSupervised() { return true; }
function restart() {process.send?.({type:'restart_requested'});shutdown();}

const handleRequest = async (req,res) => {
  // Every byte, including static assets and preflights, requires the parent secret.
  if (!internalRequest(req)) return sendJson(res,401,{ok:false,message:'unauthorised'});
  const url = new URL(req.url,'http://localhost');
  const prefix='/integrations/assistant-engine';
  if (url.pathname===prefix || url.pathname.startsWith(prefix+'/')) url.pathname=url.pathname.slice(prefix.length) || '/';
  req.url=url.pathname+url.search;
  if (req.method==='OPTIONS') return res.writeHead(204).end();
  const key=`${req.method} ${url.pathname}`;
  if (key==='GET /api/auth/status') return sendJson(res,200,{ok:true,configured:true,authenticated:true,username:'Carvis owner'});
  if (url.pathname.startsWith('/api/auth/')) return sendJson(res,409,{ok:false,message:'Manage sign-in through the parent Carvis UI.'});
  const feature=routeFeature(url.pathname);
  if (url.pathname.startsWith('/api/') && feature && !enabled(loadConfig(),feature)) return sendJson(res,403,{ok:false,message:`The ${feature} integration is disabled.`});
  try {
    const handler=routes[key];
    if (handler) await handler(req,res);
    else if(req.method==='GET') await serveStatic(req,res,url.pathname);
    else sendJson(res,404,{ok:false,message:'not found'});
  } catch(error) {if(!res.headersSent)sendJson(res,500,{ok:false,message:error.message});else res.end();}
};
const server=http.createServer(handleRequest);
const localServer=null;
server.on('error',error=>{process.send?.({type:'error',error:error.message});shutdown(1);});
server.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',port:server.address().port}));
let stopping=false;
function shutdown(code=0) {
  if(stopping)return;stopping=true;
  hostMicrophone?.stop();stopLocalPlayback();integrationBridge.close();automations.stop();sessions.stop();ha.disconnect();stt.stop();hud.stop?.();
  for(const timer of ha.appleTv?.monitors?.values() || [])clearTimeout(timer);
  server.close(()=>process.exit(code));setTimeout(()=>process.exit(code),1000).unref();
}
process.on('disconnect',()=>shutdown());
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>shutdown());

async function ipc(method,args={}) {
  const config=loadConfig();
  if(method==='cancel') {
    if(typeof args.requestId==='string' && args.requestId===carvis.integrationRequestId) cancelledRequests.add(args.requestId);
    return {ok:true};
  }
  if(method==='integrations')return integrationBridge.replace(args);
  if(method==='clear_external_confirmation')return integrationBridge.clearConfirmation(args.id);
  if(method==='config')return structuredClone(rawConfig());
  if(method==='state')return snapshot();
  if(method==='tools')return {definitions:gateway.definitions(),inventory:gateway.inventory()};
  if(method==='context')return carvis.context(args.text || '');
  if(method==='reply')return feed.push(args.kind || 'reply',args.text || '',{source:args.source || 'integration'});
  if(method==='confirm') {
    if(args.source === 'device' && !['glasses','device','physical'].includes(voice.pendingConfirmation?.source)) return {ok:false,error:'Confirm this request in the owner interface.'};
    return voice.resolveConfirmation(args.id,args.accepted===true);
  }
  if(method==='call')return gateway.call(args.name,args.arguments || args.args || {},{triggerType:'user_text',...args.context});
  if(method==='command') {
    if(!enabled(config,'home-assistant'))return {success:false,error:'Home Assistant integration is disabled.'};
    const command=args.arguments || args.command || args;
    const secure=requiresLiveOwner(command.entity_id,ha.states.get(command.entity_id),config);
    return gateway.call(secure?'ha.secure.command':'ha.entity.command',command,{triggerType:'user_text',...args.context});
  }
  if(method==='request') {
    if(!enabled(config,'assistant-engine'))throw new Error('Assistant engine integration is disabled.');
    if(carvis.busy || carvis.queuedTurns)throw new Error('Carvis is already responding. Try again in a moment.');
    if(Array.isArray(args.history)) {
      const history=args.history.filter(item=>['user','assistant'].includes(item.role) && typeof item.content==='string').slice(-32);
      if(history.at(-1)?.role==='user' && history.at(-1).content===args.text)history.pop();
      carvis.history=visibleModelInput(history.map(item=>({role:item.role,content:item.content.slice(0,8000),at:Date.now()})),config,ha);
      carvis.summary='';carvis.historyGeneration++;
    }
    carvis.integrationRequestId=typeof args.requestId==='string' ? args.requestId : '';
    carvis.externalContext=Array.isArray(args.memory)?args.memory.map(item=>String(item.text || '').slice(0,1000)).filter(Boolean).slice(0,50).join('\n'):'';
    const evidence=Array.isArray(args.executionRecords)?args.executionRecords.slice(-16):[];
    while(JSON.stringify(evidence).length>16000)evidence.shift();
    carvis.executionContext=evidence.length?JSON.stringify(visibleModelInput(evidence,config,ha)):'';
    try{return await voice.request(String(args.text || ''),{source:args.source === 'device' ? 'glasses' : 'web'});}
    finally{cancelledRequests.delete(carvis.integrationRequestId);carvis.externalContext='';carvis.executionContext='';carvis.integrationRequestId='';}
  }
  throw new Error('Unknown runtime method.');
}
process.on('carvis:config-changed',()=>{voice.invalidateConfirmations();integrationBridge.clearConfirmation();});
process.on('message',async message=>{
  if(integrationBridge.receive(message))return;
  if(message?.method==='cancel' && typeof message.id!=='string') {await ipc('cancel',message.args);return;}
  if(!message || typeof message.id!=='string' || typeof message.method!=='string')return;
  try{const result=await ipc(message.method,message.args);process.send?.({id:message.id,result});}
  catch(error){process.send?.({id:message.id,error:error.message});}
});
