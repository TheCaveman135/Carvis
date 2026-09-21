export const GLOBAL_KEY_PROVIDERS = ['openai', 'anthropic', 'deepgram', 'assemblyai', 'gemini'];
export function savedOpenAIKey(config) {
  const model = config.model || {};
  // A compatible endpoint's credential must never be reused for OpenAI.
  return model.provider === 'openai' && new URL(model.baseUrl || 'https://api.openai.com/v1').origin === 'https://api.openai.com' ? model.apiKey || '' : '';
}
export function globalKeys(config) {
  return { ...(config.apiKeys || {}), openai: config.apiKeys?.openai || savedOpenAIKey(config) };
}
export function publicGlobalKeys(config) {
  const keys = globalKeys(config);
  return Object.fromEntries(GLOBAL_KEY_PROVIDERS.map(id => [id, { saved: Boolean(keys[id]), fromMainProvider: id === 'openai' && !config.apiKeys?.openai && Boolean(savedOpenAIKey(config)) }]));
}
export function updateGlobalKeys(config, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('Invalid API keys.');
  config.apiKeys ||= {};
  for (const [id, value] of Object.entries(patch)) {
    if (!GLOBAL_KEY_PROVIDERS.includes(id)) throw Error('Unsupported API key provider.');
    if (value === null) { delete config.apiKeys[id]; continue; }
    if (typeof value !== 'string' || value.length > 1000) throw Error('Invalid API key.');
    if (value.trim()) config.apiKeys[id] = value.trim();
  }
}

export function resolvedMainModel(config) {
  const model = config.model || {};
  const official = model.provider === 'openai' && new URL(model.baseUrl || 'https://api.openai.com/v1').origin === 'https://api.openai.com';
  return {...model, apiKey: official ? config.apiKeys?.openai || model.apiKey || '' : model.apiKey || ''};
}
