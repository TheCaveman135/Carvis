import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PcmSentences,HostMicrophone} from '../integrations/assistant-runtime/server/host-audio.js';
function frame(level=0){const b=Buffer.alloc(640);for(let i=0;i<b.length;i+=2)b.writeInt16LE(level,i);return b;}
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
 await mic.start('test');assert.equal(mic.state().listening,true);mic.stop();
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
