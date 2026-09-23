import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicalCarvis } from '../server/physical-carvis.js';
import { VoiceOutput, speechChunks } from '../server/voice-output.js';
import { buildTools } from '../server/tools/index.js';

function config(overrides = {}) {
  return {
    speech: {
      autoReplies: true,
      outputMode: 'physical_then_ha',
      mediaPlayer: 'media_player.room',
      ttsEntity: 'tts.openai_tts',
      ...overrides.speech,
    },
    physicalCarvis: { deviceToken: 'device-secret', staleAfterSec: 20, ...overrides.physicalCarvis },
    entities: { observed: ['media_player.room'], controlled: ['media_player.room'], ...overrides.entities },
  };
}

test('a docked physical Carvis core receives queued speak commands', async () => {
  let now = 1_800_000_000_000;
  const physical = new PhysicalCarvis({ getConfig: () => config(), now: () => now });
  const reported = physical.report({
    core_id: 'carvis_core_01',
    dock: { id: 'example_dock_01', name: 'workspace', capabilities: ['power', 'speaker', 'microphone'] },
  });
  assert.equal(reported.connected, true);
  assert.equal(physical.isAuthorised({ headers: { authorization: 'Bearer device-secret' } }), true);
  assert.equal(physical.isAuthorised({ headers: { authorization: 'Bearer wrong' } }), false);

  const haCalls = [];
  const output = new VoiceOutput({
    getConfig: () => config(),
    physicalCarvis: physical,
    ha: { callService: async (...args) => haCalls.push(args) },
  });
  const result = await output.speakReply({ kind: 'reply', text: 'The lights are on.', source: 'carvis' });
  assert.equal(result.success, true);
  assert.equal(result.target, 'physical_core');
  assert.equal(haCalls.length, 0);

  const pending = physical.pending('carvis_core_01');
  assert.deepEqual(pending.commands.map((command) => ({ type: command.type, text: command.text })), [{ type: 'speak', text: 'The lights are on.' }]);
  assert.equal(physical.acknowledge('carvis_core_01', pending.commands[0].id).ok, true);
  now += 21_000;
  assert.equal(physical.state().activeSpeaker, null);
});

test('automatic replies fall back to the selected HA speaker when undocked', async () => {
  const physical = new PhysicalCarvis({ getConfig: () => config() });
  const calls = [];
  const output = new VoiceOutput({
    getConfig: () => config(),
    physicalCarvis: physical,
    ha: { callService: async (...args) => calls.push(args) },
  });
  const result = await output.speakReply({ kind: 'reply', text: 'Checking the printer.' });
  assert.equal(result.success, true);
  assert.equal(result.target, 'media_player.room');
  assert.deepEqual(calls[0], ['tts', 'speak', {
    entity_id: 'tts.openai_tts',
    media_player_entity_id: 'media_player.room',
    message: 'Checking the printer.',
    cache: true,
  }, {timeoutMs: 90_000}]);
});

test('spoken replies are ordered so the result cannot collide with its acknowledgement', async () => {
  const physical = new PhysicalCarvis({ getConfig: () => config() });
  const calls = [];
  let releasePlayback;
  const output = new VoiceOutput({
    getConfig: () => config(),
    physicalCarvis: physical,
    ha: { callService: async (...args) => calls.push(args) },
    sleep: () => new Promise((resolve) => { releasePlayback = resolve; }),
  });

  const acknowledgement = output.speakReply({ kind: 'reply', text: 'Checking that now.' });
  const result = output.speakReply({ kind: 'reply', text: 'The workbench light is off.' });
  await acknowledgement;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, 'the second line must wait for the first playback lane');
  assert.equal(calls[0][2].message, 'Checking that now.');

  releasePlayback();
  await result;
  assert.equal(calls.length, 2);
  assert.equal(calls[1][2].message, 'The workbench light is off.');
});

test('a stuck Apple TV TTS stream is reset once and retried on the dedicated speaker', async () => {
  const physical = new PhysicalCarvis({ getConfig: () => config() });
  const calls = [];
  let firstTts = true;
  const output = new VoiceOutput({
    getConfig: () => config(),
    physicalCarvis: physical,
    sleep: async () => {},
    ha: {
      platformFor: () => 'apple_tv',
      callService: async (...args) => {
        calls.push(args);
        if (args[0] === 'tts' && firstTts) {
          firstTts = false;
          throw new Error('HA 500: 500 Internal Server Error');
        }
      },
    },
  });

  const result = await output.speakReply({ kind: 'reply', text: 'Trying the speaker again.' });
  assert.deepEqual(calls.map(([domain, service]) => `${domain}.${service}`), [
    'tts.speak',
    'media_player.media_stop',
    'tts.speak',
  ]);
  assert.equal(calls[1][2].entity_id, 'media_player.room');
  assert.equal(result.success, true);
  assert.equal(result.recovered, true);
});

test('physical-only output never falls back to an HA speaker', async () => {
  const physical = new PhysicalCarvis({ getConfig: () => config({ speech: { outputMode: 'physical_only' } }) });
  const calls = [];
  const output = new VoiceOutput({
    getConfig: () => config({ speech: { outputMode: 'physical_only' } }),
    physicalCarvis: physical,
    ha: { callService: async (...args) => calls.push(args) },
  });
  const result = await output.speakReply({ kind: 'reply', text: 'No speaker connected.' });
  assert.equal(result.success, false);
  assert.match(result.error, /no physical/i);
  assert.equal(calls.length, 0);
});

test('explicit speech tools use the same dock-aware output route', async () => {
  const calls = [];
  const tools = buildTools({
    ha: { states: new Map(), listEntities: () => [] },
    getConfig: () => config(),
    voiceOutput: {
      speak: async (text, options) => {
        calls.push({ text, options });
        return { success: true, target: 'physical_core' };
      },
    },
  });
  const say = tools.find((tool) => tool.name === 'speech.say');
  const result = await say.execute({ text: 'Timer finished.' }, { reason: 'timer' });
  assert.equal(result.success, true);
  assert.equal(result.media_player, null);
  assert.deepEqual(calls, [{ text: 'Timer finished.', options: { source: 'timer' } }]);
});

test('failed automatic speech can be retried immediately without being suppressed as a duplicate', async () => {
  let fails = true;
  let calls = 0;
  const output = new VoiceOutput({
    getConfig: () => config(), sleep: async () => {},
    ha: { callService: async () => { calls++; if (fails) throw new Error('HA 503: unavailable'); } },
  });
  assert.equal((await output.speakReply({ kind: 'reply', text: 'Printer finished.' })).success, false);
  fails = false;
  assert.equal((await output.speakReply({ kind: 'reply', text: 'Printer finished.' })).success, true);
  assert.deepEqual(await output.speakReply({ kind: 'reply', text: 'Printer finished.' }), { skipped: true });
  assert.equal(calls, 3);
});

test('queued speech honors a changed route and turning automatic replies off', async () => {
  const cfg = config();
  let release;
  const calls = [];
  const output = new VoiceOutput({
    getConfig: () => cfg,
    sleep: () => new Promise((resolve) => { release = resolve; }),
    ha: { callService: async (...args) => calls.push(args) },
  });
  await output.speak('First line.');
  await new Promise((resolve) => setImmediate(resolve));
  const queued = output.speakReply({ kind: 'reply', text: 'Second line.' });
  cfg.speech.autoReplies = false;
  release();
  assert.deepEqual(await queued, { skipped: true });
  assert.equal(calls.length, 1);
  cfg.speech.outputMode = 'physical_only';
  assert.equal((await output.speak('Explicit third line.')).success, false);
  assert.equal(calls.length, 1);
});

test('duplicate automatic replies remain suppressed while a delivery is in flight', async () => {
  let release;
  let calls = 0;
  const output = new VoiceOutput({
    getConfig: () => config(), sleep: async () => {},
    ha: { callService: () => { calls++; return new Promise((resolve) => { release = resolve; }); } },
  });
  const first = output.speakReply({ kind: 'reply', text: 'Checking.' });
  assert.deepEqual(await output.speakReply({ kind: 'reply', text: 'Checking.' }), { skipped: true });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await first).success, true);
  assert.equal(calls, 1);
});

test('long replies are delivered completely in ordered bounded speech chunks', async () => {
  const text = Array.from({ length: 80 }, (_, i) => `Sentence ${i} is part of this reply.`).join(' ');
  const chunks = speechChunks(text);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 450));
  assert.equal(chunks.join(' '), text);
  const messages = [];
  const output = new VoiceOutput({getConfig: () => config(), sleep: async () => {}, ha: {callService: async (d,s,data) => messages.push(data.message)}});
  const result = await output.speakReply({kind: 'reply', text});
  assert.equal(result.success, true);
  assert.deepEqual(messages, chunks);
  assert.equal(output.state().lastDelivery.chunks, chunks.length);
});

test('reply errors and confirmation prompts speak, but ambient heard text remains silent', async () => {
  const messages = [];
  const output = new VoiceOutput({getConfig: () => config(), sleep: async () => {}, ha: {callService: async (d,s,data) => messages.push(data.message)}});
  await output.speakReply({kind: 'error', text: 'I could not complete that.'});
  await output.speakReply({kind: 'heard', source: 'confirmation', text: 'Confirm this command?'});
  await output.speakReply({kind: 'heard', source: 'glasses', text: 'Private background conversation.'});
  assert.deepEqual(messages, ['I could not complete that.', 'Confirm this command?']);
});

test('a transient TTS outage retries once without resetting an unrelated speaker', async () => {
  const calls = [];
  const output = new VoiceOutput({getConfig: () => config(), sleep: async () => {}, ha: {callService: async (...args) => {calls.push(args); if(calls.length===1) throw new Error('HA 503: unavailable');}}});
  const result = await output.speakReply({kind:'reply',text:'The printer is ready.'});
  assert.equal(result.recovered,true);
  assert.equal(calls.length,2);
  assert(calls.every(([domain,service,data]) => domain==='tts' && service==='speak' && data.media_player_entity_id==='media_player.room'));
});

test('TTS authentication failures are reported without retrying', async () => {
  let calls = 0;
  const output = new VoiceOutput({getConfig: () => config(), sleep: async () => {}, ha: {callService: async () => {calls++;throw new Error('HA 401: denied');}}});
  assert.equal((await output.speakReply({kind:'reply',text:'Checking.'})).success,false);
  assert.equal(calls,1);
  assert.equal(output.state().lastDelivery.status,'failed');
});

test('HomePod streaming gets a speech deadline and no second playback wait after HA finishes', async () => {
  const calls=[]; const waits=[];
  const output=new VoiceOutput({getConfig:()=>config(),sleep:async ms=>waits.push(ms),ha:{platformFor:()=> 'apple_tv',callService:async (...args)=>calls.push(args)}});
  await output.speakReply({kind:'reply',text:'On it, sir.'});
  await output.speakReply({kind:'reply',text:'Your answer is ready.'});
  assert.equal(calls.length,2);
  assert(calls.every(call=>call[3].timeoutMs===90000));
  assert.deepEqual(waits,[]);
});

test('Carvis passes its configured voice to TTS without changing provider defaults', async () => {
  const calls=[];
  const output=new VoiceOutput({getConfig:()=>({speech:{autoReplies:true,outputMode:'ha_only',mediaPlayer:'media_player.test',ttsEntity:'tts.test',voice:'fable'},entities:{observed:['media_player.test'],controlled:['media_player.test']}}),ha:{platformFor:()=> 'apple_tv',callService:async (...args)=>{calls.push(args);}}});
  const result=await output.speakReply({kind:'reply',text:'At your service, sir.'});
  assert.equal(result.success,true);
  assert.deepEqual(calls[0][2].options,{voice:'fable'});
});

test('disabling speech drops queued explicit and automatic replies', async () => {
  for (const automatic of [false,true]) {
    const cfg={...config(),integrations:{speech:true,'home-assistant':true}};
    let release;
    const calls=[];
    const output=new VoiceOutput({getConfig:()=>cfg,ha:{callService:async(...args)=>calls.push(args)},sleep:()=>new Promise(resolve=>{release=resolve;})});
    await output.speak('First line.');
    await new Promise(resolve=>setImmediate(resolve));
    const queued=output.speak('Do not play.',{automatic});
    cfg.integrations.speech=false;
    release();
    assert.deepEqual(await queued,{skipped:true});
    assert.equal(calls.length,1);
  }
});

test('disabling speech between chunks stops the rest of a long reply',async()=>{
  const cfg={...config(),integrations:{speech:true,'home-assistant':true}};
  let calls=0;
  const output=new VoiceOutput({getConfig:()=>cfg,ha:{callService:async()=>{calls++;}},sleep:async()=>{cfg.integrations.speech=false;}});
  const result=await output.speak('A long sentence. '.repeat(50));
  assert.equal(result.skipped,true);assert.equal(result.chunks,1);assert.equal(calls,1);
});

for (const revoked of ['speaker','provider','home','speech','route']) {
  test(`speech recovery rechecks ${revoked} access before retrying`,async()=>{
    const cfg={...config(),integrations:{speech:true,'home-assistant':true}};
    let calls=0;
    const output=new VoiceOutput({getConfig:()=>cfg,ha:{callService:async()=>{calls++;throw Error('HA 503: unavailable');}},sleep:async()=>{
      if(revoked==='speaker')cfg.entities.controlled=[];
      if(revoked==='provider')cfg.speech.ttsEntity='tts.other';
      if(revoked==='home')cfg.integrations['home-assistant']=false;
      if(revoked==='speech')cfg.integrations.speech=false;
      if(revoked==='route')cfg.speech.outputMode='local_only';
    }});
    assert.equal((await output.speak('Do not retry.')).skipped,true);
    assert.equal(calls,1);
  });
}

test('ordinary speaker failures never reset unrelated media playback',async()=>{
  const calls=[];
  const output=new VoiceOutput({getConfig:()=>config(),ha:{platformFor:()=> 'cast',callService:async(domain,service)=>{calls.push(`${domain}.${service}`);throw Error('HA 500: unavailable');}}});
  assert.equal((await output.speak('Failed playback.')).success,false);
  assert.deepEqual(calls,['tts.speak']);
});
