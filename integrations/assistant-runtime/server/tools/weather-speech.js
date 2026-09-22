import { RISK } from './gateway.js';
import { str } from './schema.js';
import { isVisibleEntity, visibleEntities } from './entity-access.js';
import { planTtsCall, shapeWeatherState } from '../automation-utils.js';
import { applyHaCommand } from './home-assistant.js';

export function buildWeatherSpeechTools({ ha, agent, voiceOutput, getConfig }) {
  let lastAutomationSpeechAt = 0;

  return [
    /* ── Weather and speech ──────────────────────────────────── */
    {
      name: 'weather.get_status',
      description: 'Read current weather and an optional daily/hourly forecast from Home Assistant.',
      risk: RISK.READ,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          entity_id: str('weather entity; omitted chooses the first available', 160),
          forecast: { type: 'string', enum: ['none', 'daily', 'hourly'] },
          periods: { type: 'integer', minimum: 0, maximum: 48 },
        },
        required: [],
      },
      execute: async ({ entity_id, forecast = 'none', periods = 12 }) => {
        try {
          const state = entity_id
            ? (isVisibleEntity(getConfig, entity_id) ? ha.states.get(entity_id) : null)
            : visibleEntities(ha, getConfig).find((item) => item.entity_id.startsWith('weather.'));
          if (!state) return { success: false, error: 'weather is not available to Carvis' };
          let response = [];
          if (forecast !== 'none') {
            response = await ha.callService('weather', 'get_forecasts', { entity_id: state.entity_id, type: forecast }, { returnResponse: true });
          }
          return { success: true, ...shapeWeatherState(state, response, { forecastType: forecast === 'none' ? 'daily' : forecast, limit: forecast === 'none' ? 0 : periods }) };
        } catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'speech.say',
      description: 'Speak text aloud through Carvis’s single dedicated speaker. The output device is fixed by the owner and cannot be changed per message. For a quiet glasses-only response, use the HUD instead.',
      risk: RISK.LOW,
      idempotent: true,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          text: str('Text to speak aloud', 500),
          language: str('Optional language tag such as en-US', 24),
          cache: { type: 'boolean' },
          voice: str('Reserved voice hint; provider defaults when unsupported', 80),
        },
        required: ['text'],
      },
      execute: async ({ text, tts_entity, media_player, language, cache = true }, ctx = {}) => {
        try {
          if (ctx.triggerType === 'automation') {
            const ruleRun = /^automation\s+"/i.test(String(ctx.reason || ''));
            const gapMs = ruleRun ? 30_000 : 2_000;
            // Explicit timer/alarm deliveries queue behind one another instead
            // of silently losing every alarm after the first. General rule
            // speech remains rate-limited to protect the room from a tight
            // WHILE loop.
            if (ctx.scheduled === true) {
              while (lastAutomationSpeechAt && Date.now() - lastAutomationSpeechAt < gapMs) {
                await new Promise((resolve) => setTimeout(resolve, gapMs - (Date.now() - lastAutomationSpeechAt)));
              }
            } else if (lastAutomationSpeechAt && Date.now() - lastAutomationSpeechAt < gapMs) {
              return { success: false, error: `background speech is limited to one message every ${gapMs / 1000} seconds` };
            }
            lastAutomationSpeechAt = Date.now();
          }
          const config = getConfig();
          if (voiceOutput) {
            const routed = await voiceOutput.speak(text, { source: ctx.reason || 'speech.say' });
            return { ...routed, spoken: text, media_player: routed.target === 'physical_core' ? null : (routed.target || null) };
          }
          const available = new Set(ha.listEntities().map((entity) => entity.entity_id));
          const target = String(config.speech?.mediaPlayer || '').trim();
          const provider = String(config.speech?.ttsEntity || tts_entity || '').trim();
          const allowed = new Set(target ? [target] : []);
          if (!target || !isVisibleEntity(getConfig, target) || !config.entities?.controlled?.includes(target)) {
            return { success: false, error: 'Carvis has no dedicated speaker configured' };
          }
          if (media_player && media_player !== target) {
            return { success: false, error: 'Carvis speech is pinned to its dedicated speaker' };
          }
          if (!provider) return { success: false, error: 'Carvis has no TTS provider configured' };
          const plan = planTtsCall({
            tts_entity_id: provider,
            media_player_entity_id: target,
            message: text,
            cache,
            language,
          }, { availableEntities: available, allowedMediaPlayers: allowed });
          await ha.callService(plan.domain, plan.service, plan.data);
          return { success: true, spoken: text, media_player: target };
        } catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'speech.stop',
      description: 'Stop speech/media playback on Carvis’s dedicated speaker.',
      risk: RISK.LOW,
      schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: (_args, ctx) => {
        const target = String(getConfig()?.speech?.mediaPlayer || '').trim();
        if (!target || !isVisibleEntity(getConfig, target)) return { success: false, error: 'Carvis has no dedicated speaker configured' };
        return applyHaCommand({ ha, agent }, { entity_id: target, service: 'media_stop' }, ctx);
      },
    },
  ];
}
