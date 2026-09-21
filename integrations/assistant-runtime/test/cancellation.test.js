import test from 'node:test';
import assert from 'node:assert/strict';
import {Carvis} from '../server/carvis.js';
import {ToolGateway} from '../server/tools/gateway.js';
import {DEFAULTS} from '../defaults.js';

function fixture() {
 const cfg=structuredClone(DEFAULTS);cfg.integrations['assistant-engine']=true;
 const state={cancelled:false,modelCalls:0,toolCalls:[],feed:[],records:[]};
 const carvis=new Carvis({getConfig:()=>cfg,
  gateway:{definitions:()=>[],get:()=>({risk:1}),call:async(name)=>{state.toolCalls.push(name);return {success:true};}},
  worldState:{ha:{states:new Map(),listEntities:()=>[]},summary:()=>''},
  atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},
  feed:{push:(...args)=>state.feed.push(args)},persistInvocation:record=>state.records.push(record),persistStep:()=>{},
  invokeWithTools:async()=>{state.modelCalls++;return {text:'Done.',toolCalls:[],usage:{}};},
 });
 carvis.isCancelled=()=>state.cancelled;carvis.integrationRequestId='fixture-request';
 return {cfg,state,carvis,run:()=>carvis.invoke({trigger:{type:'user_text',source:'web'},say:'Use the example integration.'})};
}

test('cancel before starting performs no model call, tool call, or spoken reply',async()=>{
 const h=fixture();h.state.cancelled=true;
 assert.equal((await h.run()).outcome,'cancelled');
 assert.equal(h.state.modelCalls,0);assert.deepEqual(h.state.toolCalls,[]);assert.deepEqual(h.state.feed,[]);
});

test('cancel during a model call discards returned actions and avoids further model calls or speech',async()=>{
 const h=fixture();let finish,started;const modelStarted=new Promise(resolve=>started=resolve);
 h.carvis.invokeWithTools=async()=>{h.state.modelCalls++;started();return new Promise(resolve=>finish=resolve);};
 const pending=h.run();await modelStarted;h.state.cancelled=true;
 finish({text:'I will do it.',toolCalls:[{id:'one',name:'integration.example',arguments:{}}],usage:{}});
 const result=await pending;
 assert.equal(result.outcome,'cancelled');assert.equal(result.quiet,true);assert.equal(h.state.modelCalls,1);
 assert.deepEqual(h.state.toolCalls,[]);assert.deepEqual(h.state.feed,[]);assert.equal(h.state.records.at(-1).outcome,'cancelled');
 assert.equal(h.carvis.busy,false);
});

test('cancel after a delivered action prevents the next action without retrying or undoing the first',async()=>{
 const h=fixture();
 h.carvis.invokeWithTools=async()=>{h.state.modelCalls++;return {text:'',toolCalls:[{id:'one',name:'integration.first',arguments:{}},{id:'two',name:'integration.second',arguments:{}}],usage:{}};};
 h.carvis.gateway.call=async name=>{h.state.toolCalls.push(name);h.state.cancelled=true;return {success:true};};
 const result=await h.run();
 assert.equal(result.outcome,'cancelled');assert.deepEqual(h.state.toolCalls,['integration.first']);
 assert.equal(h.state.modelCalls,1);assert.deepEqual(h.state.feed,[]);assert.equal(result.calls[0].name,'integration.first');
});

test('gateway independently rejects a cancelled request before adapter dispatch',async()=>{
 const cfg=structuredClone(DEFAULTS);cfg.integrations['assistant-engine']=true;
 let actions=0;const gateway=new ToolGateway(()=>cfg);gateway.isCancelled=id=>id==='cancelled';
 gateway.register({name:'integration.example',execute:async()=>{actions++;return {success:true};}});
 const result=await gateway.call('integration.example',{},{integrationRequestId:'cancelled',triggerType:'user_text'});
 assert.equal(result.cancelled,true);assert.equal(actions,0);
 assert.equal((await gateway.call('integration.example',{},{integrationRequestId:'active',triggerType:'user_text'})).success,true);
 assert.equal(actions,1);
});
