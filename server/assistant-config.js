import { DEFAULTS } from '../integrations/assistant-runtime/defaults.js';

export const SECTION_OWNERS = {
  'assistant-engine': ['carvis', 'tools', 'ollama', 'models'],
  voice: ['voice', 'stt', 'liveVoice'], speech: ['speech'], protocols: [],
  proactivity: ['classifier', 'sessions'], 'learned-memory': ['memory'],
  cameras: [], 'web-search': ['search'], atlas: ['atlas'], desktop: ['mac'],
  'physical-carvis': ['physicalCarvis'], 'home-assistant': ['agent'],
  'apple-tv': [], 'even-realities': ['glasses'],
};
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
const ROLE_OWNERS = { triage: 'proactivity', voice_triage: 'voice', vision: 'cameras', carvis: 'assistant-engine', escalation: 'assistant-engine', chat: 'assistant-engine', rule: 'learned-memory' };
export function merge(base, patch) {
  const out = structuredClone(base || {});
  for (const [key, value] of Object.entries(patch || {})) {
    if (blocked.has(key)) throw Error('Invalid configuration key.');
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(out[key], value) : structuredClone(value);
  }
  return out;
}
export function flatten(value, prefix = '', result = {}) {
  for (const [key, item] of Object.entries(value || {})) {
    const name = prefix ? `${prefix}__${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length)
      flatten(item, name, result);
    else result[name] = structuredClone(item);
  }
  return result;
}
function applyFlat(target, key, value) {
  const parts = key.split('__');
  if (parts.some(p => !p || blocked.has(p))) throw Error('Invalid configuration key.');
  let next = target;
  for (const part of parts.slice(0, -1)) next = next[part] ??= {};
  next[parts.at(-1)] = structuredClone(value);
}
export function sectionFields(id) {
  const defaults = Object.fromEntries((SECTION_OWNERS[id] || []).map(k => [k, DEFAULTS[k] || {}]));
  for (const [role, owner] of Object.entries(ROLE_OWNERS)) if (owner === id) {
    defaults.models = merge(defaults.models, { roles: { [role]: DEFAULTS.models.roles[role] || DEFAULTS.models.roles.triage } });
  }
  if (id === 'speech') defaults.speech = { ...defaults.speech, voice: '' };
  const flat = Object.fromEntries(Object.entries(flatten(defaults)).filter(([key]) => !key.startsWith('models__roles__') || ROLE_OWNERS[key.split('__')[2]] === id));
  return Object.entries(flat).filter(([key]) => !['agent__dryRun', 'carvis__personality', 'models__roles__carvis__provider', 'models__roles__carvis__model'].includes(key) && !key.endsWith('__token') && !key.endsWith('__promptVersion')).map(([key, value]) => {
    const label = key.split('__').slice(1).join(' / ').replace(/([a-z])([A-Z])/g, '$1 $2');
    const secret = /(?:key|token|secret)$/i.test(key) && !/apiKeyEnv$/.test(key);
    return { key, label: label[0]?.toUpperCase() + label.slice(1), group: key.split('__')[0],
      type: secret ? 'password' : typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : typeof value === 'object' ? 'json' : value?.length > 150 ? 'textarea' : 'text',
      default: value, description: secret ? 'Stored privately; leave blank to retain the current value.' : undefined };
  });
}
export function integrationConfigFromLegacy(cfg, environment = {}) {
  const entries = {};
  for (const [id, sections] of Object.entries(SECTION_OWNERS)) {
    entries[id] = { enabled: true, config: {} };
    for (const field of sectionFields(id)) {
      const value = field.key.split('__').reduce((object, key) => object?.[key], cfg);
      if (value !== undefined) entries[id].config[field.key] = structuredClone(value);
    }
  }
  const flag = (id, enabled) => { entries[id].enabled = !!enabled; };
  flag('voice', cfg.voice?.enabled !== false || cfg.stt?.enabled === true);
  flag('speech', cfg.speech?.autoReplies === true || !!cfg.speech?.mediaPlayer);
  flag('proactivity', cfg.classifier?.enabled === true || cfg.sessions?.enabled === true);
  flag('home-assistant', cfg.ha?.url && cfg.ha?.token);
  flag('atlas', cfg.atlas?.enabled === true);
  flag('desktop', cfg.mac?.enabled === true);
  flag('even-realities', cfg.glasses?.enabled === true);
  flag('web-search', cfg.search?.enabled === true);
  flag('physical-carvis', !!cfg.physicalCarvis?.deviceToken);
  entries['assistant-engine'].config.openaiKey = environment.OPENAI_API_KEY || '';
  entries['assistant-engine'].config.anthropicKey = environment.ANTHROPIC_API_KEY || '';
  entries.atlas.config.atlasToken = environment.ATLAS_TOKEN || '';
  Object.assign(entries.voice.config, {
    stt__deepgramKey: cfg.stt?.deepgramKey || environment.DEEPGRAM_API_KEY || '',
    stt__assemblyaiKey: cfg.stt?.assemblyaiKey || environment.ASSEMBLYAI_API_KEY || '',
  });
  entries['web-search'].config.search__geminiKey = cfg.search?.geminiKey || environment.GEMINI_API_KEY || '';
  Object.assign(entries['home-assistant'].config, {
    baseUrl: cfg.ha?.url || '', token: cfg.ha?.token || '', observed: cfg.entities?.observed || [],
    controlled: cfg.entities?.controlled || [], guards: Object.fromEntries(Object.entries(cfg.entities?.guards || {}).filter(([id, mode]) => cfg.entities?.controlled?.includes(id) && ['standard', 'protected'].includes(mode))),
    dryRun: cfg.agent?.dryRun !== false, areaNotes: cfg.areaNotes || {}, allowInsecureTls: cfg.ha?.allowInsecureTls === true,
  });
  const selected = [...(cfg.entities?.observed || []), ...(cfg.entities?.controlled || [])];
  const tv = cfg.appleTv || {};
  // Legacy IDs are used only when found in the owner's explicit selection.
  const mediaPlayerEntity = tv.mediaPlayer || selected.find(id => id === 'media_player.apple_tv') || '';
  const remoteEntity = tv.remoteEntity || selected.find(id => id === 'remote.apple_tv') || '';
  flag('apple-tv', !!(mediaPlayerEntity || remoteEntity));
  entries['apple-tv'].config = { mediaPlayerEntity, remoteEntity, addonSlug: tv.addonSlug || 'local_apple_tv_ai', context: tv.context || '', silentNavigation: tv.silentNavigation !== false, shortReplies: tv.shortReplies !== false };
  Object.assign(entries['even-realities'].config, { pairingToken: cfg.glasses?.token || '', publicBaseUrl: '', microphoneEnabled: false });
  return entries;
}
export function projectRuntimeConfig(store) {
  const saved = store.plugin('assistant-engine').get('legacyConfig', {});
  const cfg = merge(DEFAULTS, saved);
  for (const [id, sections] of Object.entries(SECTION_OWNERS)) {
    const entry = store.config.integrations[id];
    const allowed = new Set(sectionFields(id).map(f => f.key));
    for (const [key, value] of Object.entries(entry?.config || {})) {
      if (allowed.has(key) && key.includes('__')) applyFlat(cfg, key, value);
    }
  }
  cfg.integrations = Object.fromEntries(Object.keys(SECTION_OWNERS).map(id => [id, store.config.integrations[id]?.enabled === true]));
  const config = id => store.config.integrations[id]?.config || {};
  const ha = config('home-assistant');
  cfg.ha = { url: ha.baseUrl || '', token: ha.token || '', allowInsecureTls: ha.allowInsecureTls === true };
  const orphanGuards = Object.fromEntries(Object.entries(saved.entities?.guards || {}).filter(([id]) => !(ha.controlled || []).includes(id)));
  cfg.entities = { observed: ha.observed || [], controlled: ha.controlled || [], guards: { ...orphanGuards, ...ha.guards } };
  cfg.agent.dryRun = ha.dryRun !== false;
  cfg.areaNotes = ha.areaNotes || saved.areaNotes || {};
  const tv = config('apple-tv');
  cfg.appleTv = { ...cfg.appleTv, ...tv, mediaPlayer: tv.mediaPlayerEntity || '', remoteEntity: tv.remoteEntity || '' };
  cfg.glasses.token = config('even-realities').pairingToken || cfg.glasses.token || '';
  cfg.auth = structuredClone(store.config.auth);
  cfg.carvis.personality = store.config.profile.personality;
  const primary = store.config.model;
  if (primary.model) {
    const id = 'carvis-primary';
    cfg.models.providers = cfg.models.providers.filter(p => p.id !== id);
    cfg.models.providers.push({ id, label: 'Carvis model', kind: primary.provider === 'ollama' ? 'ollama' : 'openai', baseUrl: primary.provider === 'ollama' ? primary.baseUrl.replace(/\/v1\/?$/, '') : primary.baseUrl, ...(primary.provider === 'ollama' ? {} : {api:primary.provider === 'compatible' ? 'chat' : 'responses'}), apiKeyEnv: 'CARVIS_PRIMARY_API_KEY' });
    cfg.models.roles.carvis = { ...cfg.models.roles.carvis, provider: id, model: primary.model };
  }
  for (const [id, sections] of Object.entries(SECTION_OWNERS)) {
    if (cfg.integrations[id]) {
      for (const key of sections) if (cfg[key] && 'enabled' in cfg[key] && saved[key]?.enabled === undefined && config(id)[`${key}__enabled`] === undefined) cfg[key].enabled = true;
    }
  }
  cfg.server = { host: '127.0.0.1', port: 0 };
  return cfg;
}
export function runtimeEnvironment(store) {
  const env = store.plugin('assistant-engine').get('environment', {});
  const engine = store.config.integrations['assistant-engine']?.config || {};
  return { ...env, OPENAI_API_KEY: engine.openaiKey || env.OPENAI_API_KEY || '', ANTHROPIC_API_KEY: engine.anthropicKey || env.ANTHROPIC_API_KEY || '', ATLAS_TOKEN: store.config.integrations.atlas?.config?.atlasToken || env.ATLAS_TOKEN || '', CARVIS_PRIMARY_API_KEY: store.config.model.apiKey || '' };
}
