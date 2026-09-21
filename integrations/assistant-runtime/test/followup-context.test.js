import test from 'node:test';import assert from 'node:assert/strict';
import {followupContext} from '../server/followup-context.js';import {coherent} from '../server/voice.js';
const pair=(u,a)=>[{role:'user',content:u},{role:'assistant',content:a}];
test('navigation fragments require a recent relevant conversation',()=>{
 const tv=pair('Turn on Apple TV','Apple TV is awake.');
 for(const text of ['select','left','right','go to the left','down','back'])assert.equal(followupContext(text,tv).navigation,true,text);
 assert.equal(followupContext('select',[]).eligible,false);
 assert.equal(followupContext('select',[...tv,...pair('What is the weather?','It is sunny.')]).eligible,false);
 assert.equal(followupContext('right',[...tv,...pair('left','Moved left.')]).navigation,true);
});
test('short answers and adjustments use context without overriding audio-quality checks',()=>{
 assert.equal(followupContext('blue',pair('Change the lamp color','Which color?')).eligible,true);
 assert.equal(coherent('select',{contextual:true,confidence:0.99}),true);
 assert.equal(coherent('select',{contextual:true,confidence:0.1}),false);
 assert.equal(coherent('aBcd',{contextual:true,confidence:0.99}),true);
 assert.equal(followupContext('unlock it',pair('Check the deadbolt','Locked.')).eligible,false);
});
test('music steps need music context and cannot borrow an older unrelated topic', () => {
  const music = pair('Play Spotify', 'Music is playing.');
  assert.equal(followupContext('next', music).navigation, true);
  assert.equal(followupContext('previous', []).eligible, false);
  assert.equal(followupContext('next', [...music, ...pair('Check the printer', 'Printing.')]).eligible, false);
});

test('viewing requests retain streaming context through natural navigation but not a new topic',()=>{
 const netflix=pair("Yo. Let's see what's cooking up Netflix.",'Netflix is loading, sir.');
 const recent=[...netflix,...pair('Go down a little bit.','Moved down one row.')];
 for(const text of ["Let's watch neighbors too.",'Put on that movie','Play the first episode']){
   assert.equal(followupContext(text,recent).eligible,true,text);
   assert.equal(followupContext(text,recent).navigation,false,text);
 }
 assert.equal(followupContext("Let's watch neighbors too.",[...recent,...pair('Check printer status','It is printing.')]).eligible,false);
 assert.equal(followupContext('We watched that yesterday',recent).eligible,false);
 assert.equal(followupContext("Let's watch neighbors too.",[]).eligible,false);
});
