import test from 'node:test';
import assert from 'node:assert/strict';
import {Carvis} from '../server/carvis.js';

for (const acknowledgement of [undefined, "I've got your request for the light, sir.", 'x'.repeat(161), {invalid:true}]) {
const expected = typeof acknowledgement === 'string' && acknowledgement.length <= 160 ? acknowledgement : 'One moment.';
test(`slow work gets one delayed acknowledgement ${JSON.stringify(acknowledgement)} then its result`, async () => {
  const feed = []; const roles = []; const actions = []; let release;
  const carvis = new Carvis({
    getConfig: () => ({ carvis: {maxToolRounds:3},voice:{historyTurns:8} }),
    gateway: {definitions:()=>[],get:()=>({risk:1}),call:async (...args)=>{actions.push(args);return {success:true};}},
    worldState:{summary:()=> 'Test home'},
    atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false,canWrite:true})},
    feed:{push:(...args)=>feed.push(args)},
    persistInvocation:()=>{},persistStep:()=>{},
    invokeWithTools:async (cfg,role)=>{
      roles.push(role);
      if(roles.length===1) {await new Promise(r=>{release=r;});return {text:'',toolCalls:[{id:'tool1',name:'ha.light.set',arguments:{target:'light.test',state:'on'}}]};}
      return {text:'The light is on, sir.',toolCalls:[]};
    },
  });
  const pending=carvis.invoke({trigger:{type:'user_voice',wake_word:true},say:'Turn on the light.',acknowledgement});
  assert.deepEqual(roles,['carvis']);
  assert.equal(feed.length,0);
  await new Promise(resolve=>setTimeout(resolve,1250));
  assert.equal(feed[0][1],expected);
  release();
  const result=await pending;
  assert.equal(result.outcome,'ok');
  assert.deepEqual(roles,['carvis','carvis']);
  assert.equal(actions.length,1);
  assert.equal(actions[0][2].wakeWord,true);
  assert.deepEqual(feed.map(x=>x[1]),[expected,'The light is on, sir.']);
});

}
