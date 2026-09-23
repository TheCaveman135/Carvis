export const GLOBAL_KEY_PROVIDERS = ['openai', 'anthropic', 'deepgram', 'assemblyai', 'gemini'];

export function usesOfficialOpenAI(model = {}) {
  if (model.provider !== 'openai') return false;
  try {
    const url = new URL(model.baseUrl || 'https://api.openai.com/v1');
    return url.origin === 'https://api.openai.com' && !url.username && !url.password;
  } catch { return false; }
}

export function savedOpenAIKey(config) {
  const model = config.model || {};
  // A compatible endpoint's credential must never be reused for OpenAI.
  return usesOfficialOpenAI(model) ? model.apiKey || '' : '';
}
export function globalKeys(config) {
  return { ...(config.apiKeys || {}), openai: config.apiKeys?.openai || savedOpenAIKey(config) };
}

export function resolveServiceKey(config, provider, { override = '', legacy = '' } = {}) {
  if (override) return override;
  const shared = globalKeys(config)[provider];
  if (shared) return shared;
  // A removal must not resurrect a credential copied into an older runtime.
  return Object.hasOwn(config.apiKeys || {}, provider) ? '' : legacy || '';
}
export function publicGlobalKeys(config) {
  const keys = globalKeys(config);
  return Object.fromEntries(GLOBAL_KEY_PROVIDERS.map(id => [id, { saved: Boolean(keys[id]), fromMainProvider: id === 'openai' && !config.apiKeys?.openai && Boolean(savedOpenAIKey(config)) }]));
}
export function updateGlobalKeys(config, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('Invalid API keys.');
  const next = { ...(config.apiKeys || {}) };
  for (const [id, value] of Object.entries(patch)) {
    if (!GLOBAL_KEY_PROVIDERS.includes(id)) throw Error('Unsupported API key provider.');
    if (value === null) { next[id] = null; continue; }
    if (typeof value !== 'string' || value.length > 1000) throw Error('Invalid API key.');
    if (value.trim()) next[id] = value.trim();
  }
  config.apiKeys = next;
  if ((patch.openai === null || (typeof patch.openai === 'string' && patch.openai.trim())) && usesOfficialOpenAI(config.model)) {
    // Once managed globally, keep one source of truth instead of a stale copy.
    config.model.apiKey = '';
  }
}

export function resolvedMainModel(config) {
  const model = config.model || {};
  const official = usesOfficialOpenAI(model);
  return {...model, apiKey: official ? config.apiKeys?.openai || model.apiKey || '' : model.apiKey || ''};
}
