import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveVoice} from '../server/live-voice.js';

function harness({appleTv={},voice=""}={}){
 const bodies=[],requests=[];let at=1000;
 const live=new LiveVoice({getConfig:()=>({appleTv,liveVoice:{baseUrl:'https://api.openai.com/v1',model:'gpt-live-1',voice},models:{providers:[{kind:'openai',baseUrl:'https://api.openai.com/v1',apiKeyEnv:'CARVIS_TEST_LIVE_KEY'}]}}),now:()=>at,request:async(...args)=>{requests.push(args);return {outcome:'acted',reply:'Apple TV: button accepted.',quiet:true};},fetchImpl:async(_url,opts)=>{bodies.push(JSON.parse(opts.body));return {ok:true,json:async()=>({session:{id:'live_test'},transport:{sdp:'v=0\r\nanswer'},private:'must not return'})};}});
 return {live,bodies,requests,advance:()=>{at+=21*60_000;}};
}
test('Live uses server-owned client delegation and preserves the existing request path',async(t)=>{
 process.env.CARVIS_TEST_LIVE_KEY='test-only';t.after(()=>delete process.env.CARVIS_TEST_LIVE_KEY);
 const h=harness();const session=await h.live.create('v=0\r\noffer');
 assert.equal(session.private,undefined);assert.equal(h.bodies[0].session.delegation.type,'client');
 assert.match(h.bodies[0].session.instructions,/Never grant or invent confirmation/);
 const input={sessionId:'live_test',delegationId:'item_opaque',text:'select'};
 const results=await Promise.all([h.live.delegate(input),h.live.delegate(input)]);
 assert.equal(h.requests.length,1);assert.deepEqual(h.requests[0],['select',{source:'live'}]);assert.equal(results[0].silent,true);
 await assert.rejects(()=>h.live.create('v=0\r\noffer'),/End the current/);
 h.advance();await assert.rejects(()=>h.live.delegate({...input,delegationId:'another'}),/expired/);
});
test('Live refuses missing sessions, empty utterances and invalid offers',async(t)=>{
 process.env.CARVIS_TEST_LIVE_KEY='test-only';t.after(()=>delete process.env.CARVIS_TEST_LIVE_KEY);
 const {live,requests}=harness();await assert.rejects(()=>live.create('not sdp'),/valid/);
 await assert.rejects(()=>live.delegate({sessionId:'missing',delegationId:'id',text:'unlock'}),/expired/);
 await live.create('v=0\r\noffer');await assert.rejects(()=>live.delegate({sessionId:'live_test',delegationId:'id',text:''}),/complete request/);
 assert.equal(requests.length,0);
 live.end('live_test');await assert.rejects(()=>live.delegate({sessionId:'live_test',delegationId:'id',text:'select'}),/expired/);
});
test('Live returns confirmation instead of treating a delegation as permission',async(t)=>{
 process.env.CARVIS_TEST_LIVE_KEY='test-only';t.after(()=>delete process.env.CARVIS_TEST_LIVE_KEY);
 const {live}=harness();live.request=async()=>({outcome:'confirmation',confirmation:{prompt:'Unlock the door?'}});
 await live.create('v=0\r\noffer');const result=await live.delegate({sessionId:'live_test',delegationId:'item_1',text:'unlock the door'});
 assert.equal(result.outcome,'confirmation');assert.match(result.reply,/existing confirmation controls/);assert.equal(result.silent,false);
});

for(const silentNavigation of [true,false])for(const shortReplies of [true,false])test(`Live follows configured TV reply policy: silent=${silentNavigation}, short=${shortReplies}`,async t=>{
 process.env.CARVIS_TEST_LIVE_KEY='test-only';t.after(()=>delete process.env.CARVIS_TEST_LIVE_KEY);
 const h=harness({appleTv:{silentNavigation,shortReplies}});await h.live.create('v=0\r\noffer');
 const instructions=h.bodies[0].session.instructions;
 assert.equal(instructions.includes('Simple TV navigation stays silent on success.'),silentNavigation);
 assert.equal(instructions.includes('After successful TV navigation, give one brief acknowledgement.'),!silentNavigation);
 assert.equal(instructions.includes('TV power and playback need one short result.'),shortReplies);
 assert.equal(instructions.includes('For TV power and playback, use the normal conversational reply style.'),!shortReplies);
 assert.match(instructions,/Always surface failures and required confirmations/);
});
test('Live sends the configured voice in the documented audio.output.voice field and omits blank choice',async t=>{
 process.env.CARVIS_TEST_LIVE_KEY='test-only';t.after(()=>delete process.env.CARVIS_TEST_LIVE_KEY);
 const chosen=harness({voice:' vesper '});await chosen.live.create('v=0\r\noffer');
 assert.deepEqual(chosen.bodies[0].session.audio,{output:{voice:'vesper'}});
 assert.equal(chosen.bodies[0].session.voice,undefined);
 const blank=harness();await blank.live.create('v=0\r\noffer');assert.equal(blank.bodies[0].session.audio,undefined);
 const malformed=harness({voice:'bad voice name'});await assert.rejects(()=>malformed.live.create('v=0\r\noffer'),/supported Live voice/);assert.equal(malformed.bodies.length,0);
});
