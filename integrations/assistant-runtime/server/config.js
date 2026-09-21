import { DEFAULTS } from '../defaults.js';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = path.resolve(process.env.CARVIS_RUNTIME_DIR || path.join(tmpdir(), "carvis-runtime-test", String(process.pid)));
mkdirSync(ROOT, {recursive:true, mode:0o700});
const CONFIG_PATH = path.join(ROOT, 'config.json');
// Provider credentials arrive through the parent-controlled environment or private config.

/**
 * Roles are what the model registry routes on. Each is a distinct job with a
 * distinct cost profile, which is the whole reason they are separate: `triage`
 * runs on every utterance the glasses hear and has to be nearly free, while
 * `voice` only runs on the utterances triage kept.
 */
export const MODEL_ROLES = {
  triage: 'Classifies background home events. Must be cheap; uses the existing event importance rules.',
  voice_triage: 'Routes live speech with the same addressed/project/noise criteria. Separate from background event classification so response latency can be tuned independently.',
  carvis: 'The agent itself. Reasons, calls tools, acts across every system. Needs tool calling.',
  vision: 'Inspects camera snapshots and attached images for Carvis. Defaults to GPT Luna; OpenAI image input required.',
  escalation: 'Stronger model for turns the default cannot finish. Only used when escalation is on.',
  chat: 'The Chat tab in this UI.',
  rule: 'Turns a standing instruction into a house rule.',
};

/** Roles that run the agent loop and therefore need a tool-calling model. */
export const TOOL_ROLES = new Set(['carvis', 'escalation']);

/**
 * `kind` is the wire protocol (which client code talks to a provider), not
 * where it's hosted — OpenAI's real, billed API and a local LM Studio server
 * both speak the same OpenAI-shaped chat-completions protocol, so they share
 * `kind: 'openai'`. `local` is the separate, explicit signal for "nothing
 * leaves this Mac" — read it, not `kind`, anywhere that claim is made.
 */
export const DEFAULT_PROVIDERS = DEFAULTS.models.providers;

/**
 * USD per million tokens, editable because vendor pricing moves and a hardcoded
 * rate silently turns the cost dashboard into fiction. Verified 2026-08-08.
 *
 * Watch the aliases: `gpt-5.6` routes to Sol at $5/$30, not Luna at $0.20 —
 * always name the tier explicitly. And `gpt-5.4-nano` costs four times
 * `gpt-5-nano`, so the version numbers do not order by price.
 */
export const DEFAULT_PRICING = DEFAULTS.models.pricing;

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  let onDisk = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`[config] ${CONFIG_PATH} is not valid JSON, using defaults:`, err.message);
    }
  }
  cache = migrate(deepMerge(structuredClone(DEFAULTS), onDisk));
  return cache;
}

/**
 * The local model used to live at `ollama.model` with no notion of roles. Carry
 * that setting forward into every role that still points at Ollama, so an
 * existing config keeps working without anyone opening the Models tab.
 */
function migrate(cfg) {
  // A saved array replaces the default array wholesale rather than merging, so
  // a provider added in a later version is simply absent from an existing
  // config — and every role pointing at it silently reads as unconfigured.
  for (const preset of DEFAULT_PROVIDERS) {
    const existing = cfg.models.providers.find((p) => p.id === preset.id);
    if (!existing) {
      cfg.models.providers.push({ ...preset });
      continue;
    }
    // Saved provider arrays predate `local`. Fill only missing preset fields;
    // never overwrite an owner-edited URL, label, or credential setting.
    for (const [key, value] of Object.entries(preset)) {
      if (existing[key] === undefined) existing[key] = value;
    }
  }
  if (!cfg.models.pricing || !Object.keys(cfg.models.pricing).length) {
    cfg.models.pricing = { ...DEFAULT_PRICING };
  }

  // Keep existing speech routing unless an owner explicitly configures its
  // new independent role. Acknowledgements no longer require a model call.
  if (!cfg.models.roles.voice_triage) cfg.models.roles.voice_triage = { ...cfg.models.roles.triage };
  delete cfg.models.roles.reply;
  delete cfg.models.roles.acknowledgement;

  const ollamaProvider = cfg.models.providers.find((p) => p.id === 'ollama');
  if (ollamaProvider && cfg.ollama?.url) ollamaProvider.baseUrl = cfg.ollama.url;

  // Roles that no longer exist linger after an upgrade, because merging a
  // saved config over the defaults only ever adds keys. Drop them, or the
  // Models tab offers to configure jobs nothing will ever call.
  for (const name of Object.keys(cfg.models.roles)) {
    if (!(name in MODEL_ROLES)) delete cfg.models.roles[name];
  }
  for (const [name, defaults] of Object.entries(DEFAULTS.models.roles)) {
    if (!cfg.models.roles[name]) cfg.models.roles[name] = { ...defaults };
  }

  // promptVersion labels the prompt text, and the prompt text lives in code —
  // so the code owns it. Left mergeable, a config saved before a prompt change
  // keeps stamping the old label onto new traces, which silently ruins the one
  // key the invocations table has for telling prompt revisions apart.
  cfg.carvis.promptVersion = DEFAULTS.carvis.promptVersion;

  // confirmationTimeoutSec dropped from 120s to 10s this build — a swipe
  // confirmation is meant to be answered by a glance, not left pending two
  // minutes. Unlike promptVersion this field has never had a UI to edit it,
  // so a saved 120 almost certainly means "inherited the old default," not
  // "the owner chose two minutes." Bump forward only from that exact old
  // value — a config genuinely customized to something else stays as saved.
  if (cfg.voice.confirmationTimeoutSec === 120) cfg.voice.confirmationTimeoutSec = 10;

  // stt swapped from a local Whisper model to Deepgram this build. Nothing
  // ever let you pick 'base.en' as a Deepgram model, so a saved value of
  // exactly that is the old Whisper default lingering, not a deliberate
  // choice — bump it forward. `device` no longer means anything (there is no
  // local model to place on mps/cuda/cpu) and is dropped outright.
  if (cfg.stt.model === 'base.en') cfg.stt.model = 'nova-3';
  delete cfg.stt.device;

  // Protocols replaced the autonomous heartbeat. These keys only ever
  // configured its scheduling and its prompt, so leaving them in a saved
  // config would present settings that no longer control anything. The
  // safety bounds it shared with voice and protocols — dryRun, cooldownSec,
  // vacancyMinutes, respectManualOverrideSec, enforceOccupancyEnvelope,
  // allowedDomains — are deliberately not in this list.
  for (const dead of [
    'enabled',
    'intervalSec',
    'maxActionsPerTick',
    'thinkOnlyWhenRelevant',
    'forceThinkEveryTicks',
    'systemPromptOverride',
  ]) {
    delete cfg.agent?.[dead];
  }
  delete cfg.tools?.maxRiskByTrigger?.heartbeat;
  // Watches and scheduled wakeups were replaced by protocols; their trigger
  // types can no longer be produced by anything.
  delete cfg.tools?.maxRiskByTrigger?.watch;
  delete cfg.tools?.maxRiskByTrigger?.scheduled_wakeup;

  // Older installs chose whichever eligible media player came first. A missing
  // configured speaker now means no speech, never an accidental broadcast.
  if (!cfg.speech) cfg.speech = { ...DEFAULTS.speech };
  if (!cfg.physicalCarvis) cfg.physicalCarvis = { ...DEFAULTS.physicalCarvis };

  const local = cfg.ollama?.model;
  if (!local) return cfg;
  for (const role of Object.values(cfg.models.roles)) {
    const provider = cfg.models.providers.find((p) => p.id === role.provider);
    if (provider?.kind === 'ollama' && !role.model) role.model = local;
  }
  return cfg;
}

export function saveConfig(next) {
  cache = next;
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  try {
    chmodSync(CONFIG_PATH, 0o600); // the file holds a long-lived HA token
  } catch {
    /* best effort */
  }
  process.emit("carvis:config-changed");
  process.send?.({type:"config_changed", config:structuredClone(cache)});
  return cache;
}

/** Merge a partial patch into the live config and persist it. */
export function patchConfig(patch) {
  return saveConfig(deepMerge(loadConfig(), patch));
}

/** Remove known credential fields recursively, including user-defined provider entries. */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const secret = /^(?:apiKey|api_key|token|accessToken|access_token|refreshToken|refresh_token|password|passwordHash|sessionSecret|secret|authorization|deepgramKey|assemblyaiKey|geminiKey|pushToken|deviceToken)$/i;
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [key, secret.test(key) ? '' : redactSecrets(item)]));
}

/** Config for the browser: no secret this file holds is ever sent to it. */
export function publicConfig() {
  const cfg = loadConfig();
  const out = structuredClone(cfg);
  out.auth = { configured: Boolean(cfg.auth?.username && cfg.auth?.passwordHash && cfg.auth?.sessionSecret) };
  out.atlas = {...cfg.atlas, token:"", tokenSet:Boolean(cfg.atlas?.token)};
  out.appleTv = {...cfg.appleTv, token:"", tokenSet:Boolean(cfg.appleTv?.token)};
  out.ha = {
    url: cfg.ha.url,
    tokenSet: Boolean(cfg.ha.token),
    token: '',
    allowInsecureTls: Boolean(cfg.ha.allowInsecureTls),
  };
  out.mac = { ...cfg.mac, pushToken: '', pushTokenSet: Boolean(cfg.mac.pushToken) };
  out.glasses = { ...cfg.glasses, token: '', tokenSet: Boolean(cfg.glasses.token) };
  out.stt = {
    ...cfg.stt,
    deepgramKey: '',
    deepgramKeySet: Boolean(cfg.stt.deepgramKey),
    assemblyaiKey: '',
    assemblyaiKeySet: Boolean(cfg.stt.assemblyaiKey),
  };
  out.search = { ...cfg.search, geminiKey: '', geminiKeySet: Boolean(cfg.search.geminiKey) };
  out.physicalCarvis = {
    ...cfg.physicalCarvis,
    deviceToken: '',
    deviceTokenSet: Boolean(cfg.physicalCarvis?.deviceToken),
  };
  return redactSecrets(out);
}

export { DEFAULTS, CONFIG_PATH };
