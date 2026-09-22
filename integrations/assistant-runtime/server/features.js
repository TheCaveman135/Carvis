/** Feature policy is enforced in code, before an adapter or tool is reached. */
export const FEATURE_IDS = ['assistant-engine', 'voice', 'speech', 'protocols', 'proactivity', 'learned-memory', 'cameras', 'home-assistant', 'apple-tv', 'even-realities', 'web-search', 'desktop', 'physical-carvis'];
export function enabled(config, id) { if (id === 'atlas') return false; const setting = config?.integrations?.[id]; return setting === true || setting?.enabled === true; }
export const paused = () => process.env.CARVIS_RUNTIME_PAUSED === '1';
export function toolFeature(name) {
  if (name.startsWith('ha.apple_tv.') || name === 'ha.media.navigate') return 'apple-tv';
  if (name.startsWith('ha.') || name.startsWith('weather.')) return 'home-assistant';
  if (name.startsWith('vision.')) return 'cameras';
  if (name.startsWith('hud.')) return 'even-realities';
  if (name.startsWith('memory.')) return 'learned-memory';
  if (name.startsWith('atlas.')) return 'atlas';
  if (name.startsWith('mac.')) return 'desktop';
  if (name.startsWith('speech.')) return 'speech';
  if (name.startsWith('web.')) return 'web-search';
  if (/^(automation|variable|timer|alarm)\./.test(name)) return 'protocols';
  return 'assistant-engine';
}
export function toolEnabled(config, name, context = {}) {
  if (!enabled(config, toolFeature(name))) return false;
  if (paused() && !['user_voice', 'user_text'].includes(context.triggerType || 'user_voice')) return false;
  return true;
}
export function routeFeature(path) {
  if (/^\/api\/(?:auth|state|events|config|restart)(?:\/|$)/.test(path)) return null;
  if (/^\/api\/(?:voice|live|stt)(?:\/|$)/.test(path)) return 'voice';
  if (path.startsWith('/api/tv/')) return 'apple-tv';
  if (path.startsWith('/api/vision/')) return 'cameras';
  if (/^\/api\/(?:glasses|hud)(?:\/|$)/.test(path)) return 'even-realities';
  if (path.startsWith('/api/physical-carvis/')) return 'physical-carvis';
  if (path.startsWith('/api/ha/') || path === '/api/control') return 'home-assistant';
  if (path.startsWith('/api/atlas/')) return 'atlas';
  if (path.startsWith('/api/mac/')) return 'desktop';
  if (path.startsWith('/api/search/')) return 'web-search';
  if (/^\/api\/(?:memories|patterns|rules)(?:\/|$)/.test(path)) return 'learned-memory';
  if (path.startsWith('/api/automations')) return 'protocols';
  return 'assistant-engine';
}
export function effectiveConfig(raw) {
  const config = structuredClone(raw);
  const flag = id => enabled(config, id);
  if (!flag('home-assistant')) { config.ha = {...config.ha, url:'', token:''}; config.entities = { observed:[], controlled:[], guards:{} }; }
  for (const [section, feature] of Object.entries({ voice:'voice', stt:'voice', glasses:'even-realities', atlas:'atlas', mac:'desktop', search:'web-search', classifier:'proactivity', sessions:'proactivity' })) {
    config[section] ??= {}; if (!flag(feature)) config[section].enabled = false;
  }
  if (!flag('speech')) config.speech = { ...config.speech, autoReplies:false, mediaPlayer:'', ttsEntity:'', outputMode:'disabled' };
  if (!flag('physical-carvis')) config.physicalCarvis = { ...config.physicalCarvis, deviceToken:'' };
  if (!flag('apple-tv')) config.appleTv = { ...config.appleTv, mediaPlayer:'', remoteEntity:'', addonSlug:'', baseUrl:'', token:'' };
  if (paused()) { config.classifier.enabled=false; config.classifier.proactivity=0; config.sessions.enabled=false; }
  return config;
}
