import test from 'node:test';
import assert from 'node:assert/strict';
import { homeSpeechOptions } from '../integrations/assistant-runtime/server/speech-options.js';
import { VoiceOutput } from '../integrations/assistant-runtime/server/voice-output.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { createAccount, issueSession } from '../server/auth.js';
import { runtimeFor } from '../server/assistant-runtime.js';

function fixture() {
  const calls = [];
  const ha = { status: 'connected', states: new Map([
    ['tts.fixture', { attributes: { friendly_name: 'Fixture voice service' } }],
  ]), async send(command) {
    calls.push(command);
    if (command.type === 'tts/engine/list') return { providers: [
      { engine_id: 'tts.fixture', supported_languages: ['en-US', 'de-DE'] },
      { engine_id: 'legacy', supported_languages: ['en'] },
    ] };
    return { voices: [{ voice_id: 'en_US-fixture-medium', name: 'Fixture voice' }] };
  } };
  return { ha, calls };
}
test('speech settings discover compatible providers and voices without device actions', async () => {
  const { ha, calls } = fixture();
  const result = await homeSpeechOptions(ha, {}, { engineId: 'tts.fixture', language: 'en-US' });
  assert.deepEqual(result.providers, [{ value: 'tts.fixture', label: 'Fixture voice service' }]);
  assert.deepEqual(result.languages.map(l => l.value), ['en-US', 'de-DE']);
  assert.deepEqual(result.voices, [{ value: 'en_US-fixture-medium', label: 'Fixture voice' }]);
  assert.deepEqual(calls, [{ type: 'tts/engine/list' }, { type: 'tts/engine/voices', engine_id: 'tts.fixture', language: 'en-US' }]);
});
test('missing, removed, or incompatible voice choices keep the service default available', async () => {
  const { ha, calls } = fixture();
  for (const selection of [{}, { engineId: 'tts.removed' }, { engineId: 'tts.fixture' }, { engineId: 'tts.fixture', language: 'xx' }]) {
    const result = await homeSpeechOptions(ha, {}, selection);
    assert.deepEqual(result.voices, []);
  }
  assert(calls.every(c => c.type === 'tts/engine/list'));
  const send = ha.send;
  ha.send = command => command.type === 'tts/engine/voices' ? Promise.reject(Error('unsupported')) : send(command);
  const result = await homeSpeechOptions(ha, {}, { engineId: 'tts.fixture', language: 'en-US' });
  assert.match(result.note, /default voice is still available/);
  assert.equal(result.languages.length, 2);
});
test('speech discovery respects the home connection and reports missing setup', async () => {
  const { ha, calls } = fixture();
  await assert.rejects(homeSpeechOptions(ha, { integrations: { 'home-assistant': false } }), /Set up Home Assistant/);
  ha.status = 'disconnected';
  await assert.rejects(homeSpeechOptions(ha, {}), /not connected/);
  assert.deepEqual(calls, []);
});
test('spoken replies send the selected language and provider-specific voice to HA', async () => {
  const calls = [];
  const config = { speech: { outputMode: 'ha_only', autoReplies: true, mediaPlayer: 'media_player.fixture', ttsEntity: 'tts.fixture', language: 'en_US', voice: 'en_US-fixture-medium #2' }, entities: { controlled: ['media_player.fixture'] } };
  const output = new VoiceOutput({ getConfig: () => config, ha: { callService: async (...args) => calls.push(args) }, sleep: async () => {} });
  const result = await output.speakReply({ kind: 'reply', text: 'Hello.' });
  assert.equal(result.success, true);
  assert.equal(calls[0][2].language, 'en_US');
  assert.equal(calls[0][2].options.voice, 'en_US-fixture-medium #2');
  config.speech.ttsEntity = '';
  const missing = await output.speakReply({ kind: 'reply', text: 'Hello again.' });
  assert.match(missing.error, /Choose a Home Assistant voice service/);
  assert.equal(calls.length, 1);
});

test('owner can discover voices while configuring disabled speech; discovery never enables it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'carvis-speech-options-'));
  const app = await createApp({ dataDirectory: directory, fetcher: () => assert.fail('No external services during tests') });
  app.store.config.auth = createAccount('fixture-owner', 'fixture-password-only');
  runtimeFor(app.registry).call = async (method, body) => {
    assert.equal(method, 'speech_options');
    assert.deepEqual(body, { engineId: 'tts.fixture', language: 'en-US' });
    return { providers: [{ value: 'tts.fixture', label: 'Fixture service' }], languages: [], voices: [] };
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.registry.close(); await new Promise(resolve => app.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}/api/integrations/speech/voice-options`;
  const request = { method: 'POST', headers: { 'content-type': 'application/json', cookie: `carvis_session=${issueSession(app.store.config)}` }, body: JSON.stringify({ engineId: 'tts.fixture', language: 'en-US' }) };
  const response = await fetch(url, request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).providers[0].value, 'tts.fixture');
  assert.notEqual(app.store.config.integrations.speech?.enabled, true);
  const denied = await fetch(url, { ...request, headers: { 'content-type': 'application/json' } });
  assert.equal(denied.status, 401);
});
