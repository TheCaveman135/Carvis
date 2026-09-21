import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcriber, deepgramUrl, audioStats, wavFromPcm } from '../server/stt.js';
test('Nova-3 vocabulary is encoded separately and never sent to Nova-2', () => {
 assert.deepEqual(deepgramUrl('nova-3').searchParams.getAll('keyterm'), []);
 assert.deepEqual(deepgramUrl('nova-3', ['deadbolt']).searchParams.getAll('keyterm'), ['deadbolt']);
 assert.deepEqual(deepgramUrl('nova-3', ['front door', 'front door', null, '']).searchParams.getAll('keyterm'), ['front door']);
 assert.deepEqual(deepgramUrl('nova-2').searchParams.getAll('keyterm'), []);
});
test('PCM diagnostics handle unaligned buffers and distinguish silence and clipping', () => {
 const bytes = new Uint8Array(5); const pcm = bytes.subarray(1); const view = new DataView(bytes.buffer, 1, 4);
 view.setInt16(0, -32768, true); view.setInt16(2, 32767, true);
 assert.equal(audioStats(pcm).clippedPercent, 100);
 assert.equal(audioStats(new Uint8Array(32000)).durationMs, 1000);
 assert.equal(audioStats(new Uint8Array(32000)).rmsDbfs, null);
 assert.throws(() => audioStats(new Uint8Array(3)), /16-bit PCM/);
 const wav = wavFromPcm(pcm); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt32LE(40), 4);
});
test('STT sends WAV with vocabulary and leaves provider transcript unchanged', async t => {
 t.mock.method(globalThis, 'fetch', async (url, options) => {
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.ok(url.searchParams.getAll('keyterm').includes('deadbolt'));
  assert.equal(options.body.toString('ascii', 0, 4), 'RIFF');
  assert.ok(options.signal instanceof AbortSignal);
  return new Response(JSON.stringify({results:{channels:[{alternatives:[{transcript:'Status unneeded bolt.',confidence:0.6}]}]}}));
 });
 const stt = new Transcriber(() => ({stt:{deepgramKey:'test',model:'nova-3',keyterms:['deadbolt']}}));
 const result = await stt.transcribe(new Uint8Array(32000));
 assert.equal(result.text, 'Status unneeded bolt.'); assert.equal(stt.state().audio.durationMs, 1000);
});
