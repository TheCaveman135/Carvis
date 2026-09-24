import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PcmSentences,HostMicrophone} from '../integrations/assistant-runtime/server/host-audio.js';
function frame(level=0){const b=Buffer.alloc(640);for(let i=0;i<b.length;i+=2)b.writeInt16LE(level,i);return b;}
function sentence(){return Buffer.concat([...Array(30)].map(()=>frame(1500)).concat([...Array(40)].map(()=>frame())));}
test('continuous capture ignores silence and ends a sentence after a pause',()=>{
 const vad=new PcmSentences();for(let i=0;i<1000;i++)assert.equal(vad.push(frame()),null);
 for(let i=0;i<30;i++)assert.equal(vad.push(frame(1200)),null);
 let result;for(let i=0;i<40;i++)result=vad.push(frame()) || result;
 assert(result?.length>16000);assert.equal(vad.speaking,false);
});
test('muting during native helper startup prevents capture',async()=>{
 let ready;const pending=new Promise(resolve=>{ready=resolve;});let spawned=false;
 const mic=new HostMicrophone({onAudio:()=>{},helper:()=>pending,list:async()=>[{uid:'test',input:true}],spawnImpl:()=>{spawned=true;}});
 const start=mic.start('test');mic.stop();ready('/fixture');await start;assert.equal(spawned,false);assert.equal(mic.state().listening,false);
});
test('mute terminates capture and drops audio from the previous session',async()=>{
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();let killed=false,calls=0;child.kill=()=>{killed=true;};
 const mic=new HostMicrophone({onAudio:()=>calls++,helper:async()=>'/fixture',list:async()=>[{uid:'test',input:true}],spawnImpl:()=>child});
 await mic.start('test');assert.equal(mic.state().capturing,true);assert.equal(mic.state().listening,false);mic.stop();
 child.stdout.emit('data',Buffer.concat([...Array(30)].map(()=>frame(1500)).concat([...Array(40)].map(()=>frame()))));
 assert(killed);assert.equal(calls,0);assert.equal(mic.state().listening,false);
});

import {VoiceOutput} from '../integrations/assistant-runtime/server/voice-output.js';
test('local spoken replies use the selected speaker without HA or physical hardware',async()=>{
 const calls=[];
 const output=new VoiceOutput({getConfig:()=>({speech:{autoReplies:true,outputMode:'local_only',localDevice:'speaker-uid'}}),localSpeaker:async(text,uid)=>{calls.push({text,uid});return {success:true,target:'local_speaker',streamFinished:true};}});
 const result=await output.speakReply({kind:'reply',text:'Ready.'});
 assert.equal(result.success,true);assert.deepEqual(calls,[{text:'Ready.',uid:'speaker-uid'}]);
});

function microphoneFixture(t){
 let clock=1000;const children=[];
 const mic=new HostMicrophone({now:()=>clock,onAudio:()=>{},helper:async()=>'/fixture',list:async()=>[{uid:'test',input:true}],spawnImpl:()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{child.killed=true;};children.push(child);return child;
 }});t.after(()=>mic.stop());return {mic,children,setClock:value=>{clock=value;}};
}
test('capture reports listening only when PCM arrives and exposes a level without retaining audio',async t=>{
 const {mic,children}=microphoneFixture(t);await mic.start('test');assert.equal(mic.state().listening,false);
 children[0].stdout.emit('data',frame(1500));assert.equal(mic.state().listening,true);assert(mic.state().level>0);assert.equal(mic.state().bytesReceived,640);
 mic.stop();assert.equal(mic.state().level,0);
});
test('a stalled microphone is reopened and mute cancels its pending reconnect',async t=>{
 const {mic,children,setClock}=microphoneFixture(t);await mic.start('test');setClock(32000);mic.checkHealth();
 assert(children[0].killed);assert.equal(mic.state().listening,false);assert.equal(mic.state().reconnecting,true);assert.match(mic.state().error,/not sending audio/);
 mic.stop();assert.equal(mic.desired,'');assert.equal(mic.state().reconnecting,false);
});
test('changing microphones invalidates already queued transcription work',async t=>{
 const {mic,children}=microphoneFixture(t);let current;
 mic.onAudio=async (_audio,guard)=>{current=guard.isCurrent;};await mic.start('test');
 children[0].stdout.emit('data',Buffer.concat([...Array(30)].map(()=>frame(1500)).concat([...Array(40)].map(()=>frame()))));
 await new Promise(resolve=>setImmediate(resolve));assert(current());mic.stop();assert.equal(current(),false);
});

test('quiet speech reaches transcription while low background noise is ignored',()=>{
 const vad=new PcmSentences();for(let i=0;i<100;i++)assert.equal(vad.push(frame(60)),null);
 for(let i=0;i<30;i++)assert.equal(vad.push(frame(220)),null);
 let result;for(let i=0;i<40;i++)result=vad.push(frame(60)) || result;
 assert(result?.length>16000);
});

test('Mac microphone queues speech heard while an earlier request is still running',async t=>{
 const {mic,children}=microphoneFixture(t);let release;const heard=[];
 mic.onAudio=audio=>{heard.push(audio.length);return heard.length===1?new Promise(resolve=>{release=resolve;}):undefined;};
 await mic.start('test');children[0].stdout.emit('data',sentence());
 await new Promise(resolve=>setImmediate(resolve));assert.equal(heard.length,1);
 children[0].stdout.emit('data',sentence());assert.equal(mic.state().queuedUtterances,1);
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(heard.length,2);assert.equal(mic.state().queuedUtterances,0);
});

test('muting discards queued Mac microphone speech from the old capture',async t=>{
 const {mic,children}=microphoneFixture(t);let release;let heard=0;
 mic.onAudio=()=>{heard++;return new Promise(resolve=>{release=resolve;});};
 await mic.start('test');children[0].stdout.emit('data',sentence());
 await new Promise(resolve=>setImmediate(resolve));children[0].stdout.emit('data',sentence());
 assert.equal(mic.state().queuedUtterances,1);
 mic.stop();release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(heard,1);assert.equal(mic.state().queuedUtterances,0);
});

test('Mac microphone ignores its own HA speech through playback and the audio tail',async t=>{
 const {mic,children}=microphoneFixture(t);let heard=0;mic.onAudio=()=>{heard++;};
 await mic.start('test');const waits=[];
 const output=new VoiceOutput({
  getConfig:()=>({speech:{autoReplies:true,outputMode:'ha_only',mediaPlayer:'media_player.fixture',ttsEntity:'tts.fixture'},entities:{controlled:['media_player.fixture']}}),
  ha:{callService:async()=>{}},
  sleep:ms=>new Promise(resolve=>waits.push({ms,resolve})),
  onPlaybackChange:active=>mic.setSpeakingOutput(active),
 });
 assert.equal((await output.speakReply({kind:'reply',text:'Checking the lights now.'})).success,true);
 assert.equal(mic.state().speaking,true);
 children[0].stdout.emit('data',sentence());assert.equal(heard,0);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(waits.length,1);
 waits[0].resolve();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(waits[1].ms,750);assert.equal(mic.state().speaking,true);
 children[0].stdout.emit('data',sentence());assert.equal(heard,0);
 waits[1].resolve();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(mic.state().speaking,false);
 children[0].stdout.emit('data',sentence());await new Promise(resolve=>setImmediate(resolve));
 assert.equal(heard,1);
});
