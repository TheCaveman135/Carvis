import test from 'node:test';
import assert from 'node:assert/strict';
import {Carvis} from '../server/carvis.js';
import {VoiceOutput} from '../server/voice-output.js';
import {buildTools} from '../server/tools/index.js';
import {followupContext} from '../server/followup-context.js';

function harness(model){
 const feeds=[],calls=[];
 const carvis=new Carvis({getConfig:()=>({carvis:{maxToolRounds:3},voice:{historyTurns:8}}),gateway:{definitions:()=>[],get:()=>({risk:1}),call:async(...args)=>{calls.push(args);return {success:true};}},worldState:{summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:(...args)=>feeds.push(args)},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:model});
 return {carvis,feeds,calls};
}
test('casual chat has no preamble and includes expressive but grounded instructions',async()=>{
 const h=harness(async(_cfg,_role,options)=>{
  assert.match(options.system,/hud.express/);assert.match(options.system,/Never change lights/);
  return {text:'I have a few theories. None flattering to the printer.',toolCalls:[]};
 });
 const r=await h.carvis.invoke({trigger:{type:'user_voice'},say:'How are you doing?'});
 assert.equal(r.outcome,'ok');assert.equal(h.feeds.length,1);assert.equal(h.calls.length,0);
});
test('overlapping owner turns wait in order and see the previous reply',async()=>{
 let release,modelCalls=0;
 const h=harness(async(_cfg,_role,opts)=>{
  modelCalls++;
  if(modelCalls===1){await new Promise(r=>{release=r;});return {text:'The first answer.',toolCalls:[]};}
  assert.ok(opts.messages.some(m=>m.content==='The first answer.'));
  return {text:'The follow-up answer.',toolCalls:[]};
 });
 const one=h.carvis.invoke({trigger:{type:'user_voice'},say:'What do you think?'});
 const two=h.carvis.invoke({trigger:{type:'user_voice'},say:'Why?'});
 assert.equal(modelCalls,1);release();
 assert.equal((await one).outcome,'ok');assert.equal((await two).outcome,'ok');assert.equal(modelCalls,2);
});
test('live speech is not duplicated on the dedicated speaker',async()=>{
 const output=new VoiceOutput({getConfig:()=>{throw Error('must not route live audio');}});
 assert.deepEqual(await output.speakReply({kind:'reply',source:'live',text:'Hello.'}),{skipped:true});
});
test('conversational fragments reach triage with context only',()=>{
 assert.equal(followupContext('why?',[]).eligible,false);
 assert.equal(followupContext('why?',[{role:'user',content:'What do you think?'},{role:'assistant',content:'I would wait.'}]).eligible,true);
});
test('HUD expressions fade, stay silent, and never replace an active notification',()=>{
 const shown=[],hud={showNotification:o=>shown.push(o)};
 const tools=buildTools({hud,getConfig:()=>({}),feed:{push:()=>assert.fail('An expression must not speak')}});
 const tool=tools.find(t=>t.name==='hud.express');
 assert.equal(tool.execute({mood:'amused'},{triggerType:'automation'}).success,false);
 hud.overlay={until:Date.now()+10000};assert.equal(tool.execute({mood:'amused'},{triggerType:'user_voice'}).skipped,true);
 hud.overlay=null;assert.equal(tool.execute({mood:'amused'},{triggerType:'user_voice'}).silent,true);
 assert.equal(shown.length,1);assert.equal(shown[0].seconds,4);
 assert.equal(tool.execute({mood:'amused'},{triggerType:'user_voice'}).skipped,true);
});

test('an apology and action promise triggers one real tool attempt before responding',async()=>{
 let n=0;
 const h=harness(async(_cfg,_role,opts)=>{
  n++;
  if(n===1)return {text:'I was wrong. I’ll select the movie and start it.',toolCalls:[]};
  if(n===2){assert.match(opts.messages.at(-1).content,/no tool has run/);return {text:'',toolCalls:[{id:'repair1',name:'ha.apple_tv.task',arguments:{goal:'Continue the requested movie from the search screen'}}]};}
  return {text:'The controller is working from the search screen.',toolCalls:[]};
 });
 await h.carvis.invoke({trigger:{type:'user_text'},say:'It is on the search screen, not playing.'});
 assert.equal(n,3);assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'ha.apple_tv.task');
 assert.equal(h.feeds.at(-1)[1],'The controller is working from the search screen.');
});
test('repeated empty promises are bounded and never reported as action',async()=>{
 let n=0;const h=harness(async()=>{n++;return {text:'I will start the movie.',toolCalls:[]};});
 await h.carvis.invoke({trigger:{type:'user_text'},say:'Start the movie'});
 assert.equal(n,2);assert.equal(h.calls.length,0);assert.equal(h.feeds.at(-1)[1],'I haven’t sent that action yet.');
});
