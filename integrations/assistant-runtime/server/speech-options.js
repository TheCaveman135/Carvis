/** Owner settings discovery only. Never add this inventory to model context. */
export async function homeSpeechOptions(ha, config, { engineId = '', language = '' } = {}) {
  if (config.integrations?.['home-assistant'] === false)
    throw Error('Set up Home Assistant to choose a voice service.');
  if (ha.status !== 'connected') throw Error('Home Assistant is not connected. Try again when it reconnects.');
  const { providers = [] } = await ha.send({ type: 'tts/engine/list' });
  // Playback uses tts.speak, which requires an entity-backed voice service.
  const engines = providers.filter(p => typeof p.engine_id === 'string' && p.engine_id.startsWith('tts.'));
  const result = {
    providers: engines.map(p => ({ value: p.engine_id, label: ha.states.get(p.engine_id)?.attributes?.friendly_name || p.name || p.engine_id })),
    languages: [], voices: [], note: '',
  };
  if (!engineId) return result;
  const engine = engines.find(p => p.engine_id === engineId);
  if (!engine) { result.note = 'This saved voice service is unavailable. Choose another service.'; return result; }
  result.languages = (engine.supported_languages || []).map(value => ({ value, label: value }));
  if (!language) { result.note = 'Use the service’s default voice, or choose a language to see its voices.'; return result; }
  if (!engine.supported_languages?.includes(language)) {
    result.note = 'This service does not support the saved language. Choose another language.';
    return result;
  }
  try {
    const { voices = [] } = await ha.send({ type: 'tts/engine/voices', engine_id: engineId, language });
    result.voices = (voices || []).map(voice => ({ value: voice.voice_id, label: voice.name || voice.voice_id }));
    if (!result.voices.length) result.note = 'This service uses its default voice for this language.';
  } catch {
    result.note = 'This service could not list its voices. Its default voice is still available.';
  }
  return result;
}
