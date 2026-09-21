import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {recordVoiceEvent} from '../server/integrations/voice-history.js';
import {voiceTurn,voiceReply} from '../integrations/assistant-runtime/server/voice-events.js';
test('voice history persists replies, separates sources, and preserves turn association',t=>{
 const dir=mkdtempSync(join(tmpdir(),'carvis-voice-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new Store(dir);
 const put=(turnId,source,role,text)=>recordVoiceEvent(store,{turnId,source,role,text});
 put('a','server-microphone','user','Hello');put('b','glasses','user','Lights on');
 put('a','server-microphone','assistant','Hello there');put('b','glasses','status','silent');
 assert.equal(store.data.conversations.length,2);
 const mic=store.data.conversations.find(c=>c.source==='server-microphone');assert.equal(mic.messages[1].content,'Hello there');
 assert.equal(new Store(dir).conversation(mic.id).channel,'voice');
 store.data.conversations=store.data.conversations.filter(c=>c.id!==mic.id);put('a','server-microphone','assistant','Late reply');assert.equal(store.data.conversations.length,1);
 const glasses=store.data.conversations[0];glasses.updatedAt=Date.now()-11*60*1000;put('c','glasses','user','Another request');assert.equal(store.data.conversations.length,2);
});
test('overlapping voice turns keep asynchronous replies correlated and exclude unrelated feed',async()=>{
 const old=process.send,events=[];process.send=e=>events.push(e);
 try{
  await Promise.all(['one','two'].map(text=>voiceTurn(text,'test',async()=>{await Promise.resolve();voiceReply({kind:'reply',text:`reply ${text}`});return {outcome:'accepted'};})));
  voiceReply({kind:'reply',text:'typed chat'});
  assert.equal(events.length,6);
  for(const user of events.filter(e=>e.role==='user'))assert.equal(events.find(e=>e.turnId===user.turnId&&e.role==='assistant').text,`reply ${user.text}`);
 }finally{if(old)process.send=old;else delete process.send;}
});
