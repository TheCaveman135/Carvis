import { enabled } from './features.js';
import { voiceInputIssue } from './voice-input.js';

/** Owner controls affect capture only; they do not restart the assistant or its routines. */
export class VoiceControls {
  constructor({ microphone, getConfig, saveConfig, listDevices, transcriber, voice }) {
    Object.assign(this, { microphone, getConfig, saveConfig, listDevices, transcriber, voice });
    this.captureSettings = null;
  }

  sync({ restart = false } = {}) {
    const config = this.getConfig();
    const inputDevice = config.voice?.inputDevice || '';
    const issue = voiceInputIssue(config, inputDevice);
    const settings = JSON.stringify([inputDevice, issue]);
    if (this.captureSettings !== settings || restart) this.transcriber.cancel?.();
    this.captureSettings = settings;
    const uid = !issue && inputDevice.startsWith('local:') ? inputDevice.slice(6) : '';
    if (!uid) this.microphone.stop();
    else if (restart || this.microphone.desired !== uid) void this.microphone.start(uid);
  }

  state() {
    const config = this.getConfig();
    const voice = config.voice || {};
    const stt = this.transcriber.state();
    return {
      ...this.microphone.state(),
      inputDevice: voice.inputDevice || '',
      muted: voice.inputMuted === true,
      voiceEnabled: enabled(config, 'voice') && voice.enabled === true,
      transcriptionEnabled: config.stt?.enabled === true,
      transcriptionReady: stt.ready,
      transcriptionError: stt.error || '',
      lastTranscriptionMs: stt.lastMs,
      lastVoiceError: this.voice.state().lastError || '',
      spokenRepliesEnabled: enabled(config, 'speech') && config.speech?.autoReplies === true,
    };
  }

  async update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('Choose a microphone or mute setting.');
    for (const key of Object.keys(patch)) {
      if (!['muted', 'inputDevice', 'restart'].includes(key)) throw Error('Unsupported voice control.');
    }
    if (patch.muted !== undefined && typeof patch.muted !== 'boolean') throw Error('Mute must be on or off.');
    if (patch.restart !== undefined && typeof patch.restart !== 'boolean') throw Error('Restart must be on or off.');

    if (patch.inputDevice !== undefined) {
      const id = patch.inputDevice;
      if (typeof id !== 'string') throw Error('Choose a valid microphone.');
      if (id !== 'even-glasses' && id && (!id.startsWith('local:') || !(await this.listDevices()).some(device => device.input && device.uid === id.slice(6)))) {
        throw Error('That microphone is not available.');
      }
    }
    // Device discovery is asynchronous. Apply only this patch to the latest
    // settings so concurrent mute or integration changes cannot be overwritten.
    const current = this.getConfig();
    const voice = { ...current.voice };
    if (patch.inputDevice !== undefined) {
      if (patch.inputDevice === 'even-glasses' && !enabled(current, 'even-realities')) throw Error('Enable Even Realities glasses first.');
      voice.inputDevice = patch.inputDevice;
    }
    if (patch.muted !== undefined) voice.inputMuted = patch.muted;
    if (!voice.inputMuted && !voice.inputDevice) throw Error('Choose a microphone before unmuting.');
    this.saveConfig({ ...current, voice });
    this.sync({ restart: patch.restart === true });
    return this.state();
  }
}
