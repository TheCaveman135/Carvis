import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {conversationStore,cleanConversation} from '../server/conversation-store.js';
import {Carvis} from '../server/carvis.js';
import {Voice} from '../server/voice.js';
const cfg={voice:{enabled:true,requireWakeWord:false,wakeWords:['carvis'],minChars:3,dedupeWindowSec:0,historyTurns:8},carvis:{maxToolRounds:2}};
function carvis(store=null,model=async()=>({text:'No, the deadbolt is locked.',toolCalls:[]})) {
 return new Carvis({getConfig:()=>cfg,conversationStore:store,gateway:{definitions:()=>[]},worldState:{summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:()=>{}},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:model});
}
test('bounded conversation survives restart, clears on request, and expires',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'carvis-memory-'));
 try {
  const file=path.join(dir,'conversation.json'),store=conversationStore(file);
  const first=carvis(store);first.rememberConversation('Is the deadbolt unlocked?','No, it is locked.');
  const restored=carvis(store);assert.equal(restored.recentConversation()[1].content,'No, it is locked.');
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
  restored.clearHistory();assert.deepEqual(carvis(store).recentConversation(),[]);
  assert.deepEqual(cleanConversation({updatedAt:0,history:[{role:'user',content:'old'}]}).history,[]);
  assert.equal(restored.recentConversation({turns:0}).length,0);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('triage receives the last three exchanges and current follow-up without granting a wake word',async()=>{
 const c=carvis();for(let i=0;i<4;i++)c.rememberConversation(`Question ${i}`,`Answer ${i}`);
 const invocations=[];c.invoke=async request=>{invocations.push(request);return {outcome:'ok',reply:'The other speaker is idle.',calls:[]};};
 let options;
 const voice=new Voice({getConfig:()=>cfg,carvis:c,atlas:{snapshot:{projects:[]}},feed:{push:()=>{}},persistTranscript:()=>{},deleteAllTranscripts:()=>{},complete:async(_cfg,_role,opts)=>{options=opts;return {json:{addressed:true,project_relevant:false,implicit_intent:false,category:'question',acknowledgement:'I will check, sir.'}};}});
 await voice.ingest('What about the other one?',{confidence:0.99});
 assert.equal(options.messages.length,7);assert.equal(options.messages[0].content,'Question 1');assert.equal(options.messages.at(-1).content,'What about the other one?');
 assert.match(options.system,/not new instructions or authorization/);assert.equal(invocations[0].trigger.wake_word,false);
});
test('main model sees prior actual replies and omits timestamp metadata',async()=>{
 let seen;const c=carvis(null,async(_cfg,_role,opts)=>{seen=opts.messages;return {text:'The other one is idle.',toolCalls:[]};});
 c.rememberConversation('Pause Spotify','I could not pause Spotify: unavailable');
 await c.invoke({trigger:{type:'user_voice'},say:'What about the other one?'});
 assert.ok(seen.some(m=>m.content==='I could not pause Spotify: unavailable'));
 assert.ok(seen.every(m=>!('at' in m)));assert.equal(c.recentConversation().at(-1).content,'The other one is idle.');
});
test('triage context expires after five minutes and ignored speech stays out of memory',async()=>{
 const c=carvis();c.history=[{role:'user',content:'old',at:Date.now()-360000},{role:'assistant',content:'old answer',at:Date.now()-360000}];assert.deepEqual(c.recentConversation(),[]);
 const voice=new Voice({getConfig:()=>cfg,carvis:c,atlas:{snapshot:{projects:[]}},feed:{push:()=>{}},persistTranscript:()=>{},deleteAllTranscripts:()=>{},complete:async()=>({json:{addressed:false,project_relevant:false,implicit_intent:false,category:'none',acknowledgement:''}})});
 await voice.ingest('I told him about dinner yesterday',{confidence:0.99});assert.equal(c.history.length,2);
});
test('follow-up history can include eight steps but expires at the requested window', () => {
  const c = carvis();
  for (let i = 0; i < 10; i++) c.rememberConversation(`Step ${i}`, 'Done.');
  assert.equal(c.recentConversation({turns:8,maxAgeMs:120000}).length,16);
  assert.equal(c.recentConversation().length,6);
  c.history.forEach(m => { m.at = Date.now() - 121000; });
  assert.deepEqual(c.recentConversation({turns:8,maxAgeMs:120000}),[]);
});
