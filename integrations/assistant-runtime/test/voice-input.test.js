import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceInputIssue, transcribeVoiceInput } from '../server/voice-input.js';

function config(inputDevice = 'even-glasses') {
  return {
    integrations: { voice: true, 'even-realities': true },
    voice: { enabled: true, inputMuted: false, inputDevice },
    stt: { enabled: true },
  };
}

const revoke = {
  mute: config => { config.voice.inputMuted = true; },
  'input setting': config => { config.voice.enabled = false; },
  'voice integration': config => { config.integrations.voice = false; },
  transcription: config => { config.stt.enabled = false; },
  glasses: config => { config.integrations['even-realities'] = false; },
  device: config => { config.voice.inputDevice = 'local:other-mic'; },
};

for (const [name, change] of Object.entries(revoke)) {
  test(`microphone ${name} revocation blocks new and pending audio`, async () => {
    const cfg = config();
    let calls = 0;
    const transcriber = { transcribe: async () => { calls++; change(cfg); return { text: 'Turn on the light' }; } };
    const transcribe = () => transcribeVoiceInput({ getConfig: () => cfg, transcriber, inputDevice: 'even-glasses', pcm: new Uint8Array(3200) });
    assert.equal((await transcribe()).ignored, true);
    assert.equal((await transcribe()).ignored, true);
    assert.equal(calls, 1);
  });
}

test('stale host capture is discarded and local microphones do not require glasses', async () => {
  const cfg = config('local:mic');
  cfg.integrations['even-realities'] = false;
  assert.equal(voiceInputIssue(cfg, 'local:mic'), '');
  let current = true;
  const heard = await transcribeVoiceInput({ getConfig: () => cfg, inputDevice: 'local:mic', isCurrent: () => current,
    transcriber: { transcribe: async () => { current = false; return { text: 'Old audio' }; } } });
  assert.equal(heard.ignored, true);
});
