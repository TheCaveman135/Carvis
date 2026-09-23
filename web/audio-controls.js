import { el, errorText } from './ui.js';

const placeholders = {
  voice__inputDevice: 'Choose a microphone', speech__localDevice: 'Choose a speaker',
  speech__mediaPlayer: 'Choose a Home Assistant speaker', speech__ttsEntity: 'Choose a voice service',
  speech__language: 'Service default', speech__voice: 'Service default',
};

/** Audio discovery belongs to one form, so dependent choices stay in sync. */
export function createAudioControls({ state, api, read, integration, values }) {
  const controls = new Map();
  let discoveryQueued = false, requestVersion = 0;
  const note = (control, message) => {
    control.title = message;
    let status = control.parentElement?.querySelector('.audio-discovery-status');
    if (!status && control.parentElement) {
      status = el('span', { class: 'field-description audio-discovery-status', role: 'status' });
      control.parentElement.append(status);
    }
    if (status) status.textContent = message;
  };
  const fill = (key, options, message = '') => {
    const control = controls.get(key);
    if (!control) return;
    const current = control.value;
    control.replaceChildren(el('option', { value: '' }, placeholders[key]),
      ...options.map(o => el('option', { value: o.value }, o.label)));
    if (current && !options.some(o => o.value === current))
      control.append(el('option', { value: current }, `${current} (saved, unavailable)`));
    control.value = current;
    control.removeAttribute('aria-busy');
    note(control, message);
  };
  const loadVoices = async () => {
    const version = ++requestVersion;
    const keys = ['speech__ttsEntity', 'speech__language', 'speech__voice'];
    for (const key of keys) {
      const control = controls.get(key);
      control?.setAttribute('aria-busy', 'true');
      if (control) note(control, 'Loading available choices…');
    }
    try {
      if (!state.data.homeAssistant?.enabled) throw Error('Set up Home Assistant to choose a voice service.');
      const result = await api('/api/integrations/speech/voice-options', { method: 'POST', body: {
        engineId: controls.get('speech__ttsEntity')?.value || '',
        language: controls.get('speech__language')?.value || '',
      } });
      if (version !== requestVersion) return;
      fill('speech__ttsEntity', result.providers, result.providers.length ? '' : 'No voice services found. Add a text-to-speech integration in Home Assistant.');
      fill('speech__language', result.languages.map(option => {
        try {
          const name = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(option.value.replaceAll('_', '-'));
          return { ...option, label: `${name} (${option.value})` };
        } catch { return option; }
      }));
      fill('speech__voice', result.voices, result.note);
    } catch (error) {
      if (version !== requestVersion) return;
      for (const key of keys) {
        const control = controls.get(key);
        control?.removeAttribute('aria-busy');
        if (control) note(control, errorText(error));
      }
    }
  };
  const updateVisibility = () => {
    const mode = values.speech__outputMode?.control.value || integration.config?.speech__outputMode || 'physical_then_ha';
    for (const [key, control] of controls) {
      const field = control.closest('.field');
      if (field && key.startsWith('speech__')) field.hidden = key === 'speech__localDevice'
        ? mode !== 'local_only' : !['ha_only', 'physical_then_ha'].includes(mode);
    }
  };
  return (field, value) => {
    const key = field.key;
    if (!(key in placeholders)) return null;
    const control = el('select', { name: key }, el('option', { value: '' }, placeholders[key]),
      value ? el('option', { value, selected: true }, `${value} (saved)`) : null);
    controls.set(key, control);
    if (key === 'speech__ttsEntity' || key === 'speech__language' || key === 'speech__voice') {
      if (key !== 'speech__voice') control.addEventListener('change', () => {
        // A different provider/language must not inherit an incompatible voice.
        if (key === 'speech__ttsEntity') {
          controls.get('speech__language').value = '';
          fill('speech__language', []);
        }
        controls.get('speech__voice').value = '';
        fill('speech__voice', []);
        void loadVoices();
      });
      if (!discoveryQueued) {
        discoveryQueued = true;
        queueMicrotask(() => {
          void loadVoices();
          updateVisibility();
          values.speech__outputMode?.control.addEventListener('change', updateVisibility);
        });
      }
    } else queueMicrotask(async () => {
      try {
        if (key === 'speech__mediaPlayer') {
          const ha = state.data.homeAssistant;
          if (!ha?.enabled) throw Error('Set up Home Assistant to choose a speaker.');
          const result = await read('/api/home-assistant/entities');
          const options = result.entities.filter(e => e.entity_id.startsWith('media_player.') && ha.config?.controlled?.includes(e.entity_id))
            .map(e => ({ value: e.entity_id, label: e.name || e.entity_id }));
          fill(key, options, options.length ? '' : 'Allow Interact for a speaker in Settings → Home Assistant to use it here.');
        } else {
          const result = await read(`/api/integrations/${integration.id}/audio-devices`);
          fill(key, key === 'voice__inputDevice' ? result.inputs : result.outputs, result.warning || '');
        }
      } catch (error) { note(control, errorText(error)); }
    });
    return control;
  };
}
