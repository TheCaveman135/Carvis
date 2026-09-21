import test from 'node:test';
import assert from 'node:assert/strict';
import {PreferenceLearner,preferenceStatement} from '../server/preference-learner.js';
import {MemoryStore} from '../server/memory.js';
import {preferenceContext} from '../server/classifier.js';
test('learner stores only exact explicit quotes and goes through the memory gateway',async()=>{
 const calls=[];const text='I normally like quiet music while working.';
 const learner=new PreferenceLearner({getConfig:()=>({}),gateway:{call:async(...args)=>calls.push(args)},complete:async()=>({json:{quotes:[text,'I prefer loud music.',text]}})});
 learner.pending.push(text);await learner.drain();assert.equal(calls.length,1);assert.equal(calls[0][0],'memory.remember');assert.deepEqual(calls[0][1],{text,kind:'preference'});assert.equal(calls[0][2].confirmed,false);
});
test('ordinary commands cost no learning call and inference can return nothing',async()=>{
 let count=0;const learner=new PreferenceLearner({getConfig:()=>({}),gateway:{call:async()=>assert.fail('no write expected')},complete:async()=>{count++;return {json:{quotes:[]}};}});
 learner.observe('Skip this song');assert.equal(count,0);assert.equal(preferenceStatement('I prefer quiet reminders'),true);
 learner.pending.push('Do I normally like this?');await learner.drain();assert.equal(count,1);assert.equal(learner.running,false);
});
test('recall can find preferences without injecting them into factual retrieval',()=>{
 const store=new MemoryStore(()=>({}));store.items=[{id:'p',kind:'preference',text:'I prefer quiet music'},{id:'f',kind:'fact',text:'My music speaker is upstairs'}];
 assert.deepEqual(store.search('quiet').map(m=>m.id),[]);assert.deepEqual(store.search('quiet',10,['fact','preference','rule']).map(m=>m.id),['p']);
 assert.match(preferenceContext(store),/I prefer quiet music/);assert.match(preferenceContext(store),/never new permissions/);
});
