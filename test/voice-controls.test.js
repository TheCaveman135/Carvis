import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceControls} from '../integrations/assistant-runtime/server/voice-controls.js';
function fixture(){
 let config={integrations:{voice:true,speech:false},voice:{enabled:true,inputDevice:'local:mic',inputMuted:false},stt:{enabled:true},speech:{autoReplies:false}};
 const calls=[];const microphone={desired:'mic',state:()=>({listening:true}),stop(){calls.push('stop');this.desired='';},start(uid){calls.push(uid);this.desired=uid;}};
 const controls=new VoiceControls({microphone,getConfig:()=>config,saveConfig:next=>{config=next;},listDevices:async()=>[{uid:'mic',input:true},{uid:'speaker',output:true}],transcriber:{state:()=>({ready:true})},voice:{state:()=>({})}});
 return {controls,microphone,calls,config:()=>config};
}
test('voice mute persists and stops capture without restarting other services',async()=>{
 const {controls,calls,config}=fixture();const result=await controls.update({muted:true});
 assert.equal(result.muted,true);assert.equal(config().voice.inputMuted,true);assert.deepEqual(calls,['stop']);
 await controls.update({muted:false});assert.deepEqual(calls,['stop','mic']);
});
test('voice controls reject unavailable devices and disabled companion inputs',async()=>{
 const {controls,config}=fixture();
 for(const inputDevice of ['local:missing','local:speaker','even-glasses','browser'])await assert.rejects(()=>controls.update({inputDevice}));
 assert.equal(config().voice.inputDevice,'local:mic');await assert.rejects(()=>controls.update({muted:'false'}));
 await assert.rejects(()=>controls.update({token:'anything'}));
});
test('changing input preserves mute and reconnect stays on the chosen microphone',async()=>{
 const {controls,calls,config}=fixture();await controls.update({muted:true});await controls.update({inputDevice:'local:mic'});assert.equal(config().voice.inputMuted,true);
 await controls.update({muted:false});await controls.update({restart:true});assert.deepEqual(calls,['stop','stop','mic','mic']);
 assert.equal(controls.state().spokenRepliesEnabled,false);
});
