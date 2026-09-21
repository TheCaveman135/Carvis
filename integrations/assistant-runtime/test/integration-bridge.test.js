import test from 'node:test';
import assert from 'node:assert/strict';
import {IntegrationBridge} from '../server/integration-bridge.js';
import {ToolGateway} from '../server/tools/gateway.js';
import {DEFAULTS} from '../defaults.js';

function fixture() {
 const cfg=structuredClone(DEFAULTS);cfg.integrations['assistant-engine']=true;
 const gateway=new ToolGateway(()=>cfg),sent=[],confirmations=[];
 const bridge=new IntegrationBridge({gateway,send:message=>sent.push(message),onConfirmation:value=>confirmations.push(value),timeoutMs:1000});
 return {cfg,gateway,bridge,sent,confirmations};
}

test('new integrations register typed tools and relay through the parent without escalating confirmation',async()=>{
 const h=fixture();
 h.bridge.replace({tools:[{name:'example_action',description:'Example integration',schema:{type:'object',properties:{level:{type:'number'}},required:['level'],additionalProperties:false}}],context:'Example owner context'});
 assert.equal(h.gateway.get('integration.example_action').risk,1);
 const promise=h.gateway.call('integration.example_action',{level:3},{triggerType:'user_text',source:'web',confirmed:false});
 assert.equal(h.sent[0].type,'integration_call');assert.equal(h.sent[0].name,'example_action');assert.equal(h.sent[0].context.confirmed,false);
 const result={requiresConfirmation:true,confirmation:{id:'example-confirmation',summary:'Apply level 3?',expiresAt:Date.now()+10000}};
 h.bridge.receive({type:'integration_result',id:h.sent[0].id,result});
 assert.deepEqual(await promise,result);assert.equal(h.bridge.confirmation().prompt,'Apply level 3?');assert.equal(h.bridge.confirmation().source,'owner');
 h.bridge.clearConfirmation('another-id');assert.ok(h.bridge.confirmation());
 h.bridge.clearConfirmation('example-confirmation');assert.equal(h.bridge.confirmation(),null);
 assert.equal(h.sent.length,1,'clearing/confirming a notice cannot execute a tool locally');
});

test('integration replacement removes old tools and core feature revocation rejects calls',async()=>{
 const h=fixture();h.bridge.replace({tools:[{name:'old_tool',readOnly:true}]});
 assert.equal(h.gateway.get('integration.old_tool').risk,0);
 h.bridge.replace({tools:[{name:'new_tool',readOnly:true}],context:'Current context'});
 assert.equal(h.gateway.get('integration.old_tool'),undefined);
 h.cfg.integrations['assistant-engine']=false;
 assert.deepEqual(h.gateway.definitions(),[]);
 assert.equal((await h.gateway.call('integration.new_tool',{})).success,false);assert.equal(h.sent.length,0);
});

test('parent errors, unmatched results and shutdown never fabricate success',async()=>{
 const h=fixture();
 const pending=h.bridge.invoke('tool',{});h.bridge.receive({type:'integration_result',id:h.sent[0].id,error:'Permission revoked'});
 await assert.rejects(pending,/Permission revoked/);
 assert.equal(h.bridge.receive({type:'integration_result',id:'unknown',result:{requiresConfirmation:true,confirmation:{id:'unknown'}}}),true);
 assert.equal(h.bridge.confirmation(),null);
 const stopped=h.bridge.invoke('tool',{});h.bridge.close();await assert.rejects(stopped,/worker stopped/);
});

test('device confirmation prompts retain source and expire without execution',async()=>{
 const h=fixture();const pending=h.bridge.invoke('tool',{},{triggerType:'user_voice',source:'glasses'});
 h.bridge.receive({type:'integration_result',id:h.sent[0].id,result:{requiresConfirmation:true,confirmation:{id:'device-pending',summary:'Continue?',expiresAt:Date.now()-1}}});
 await pending;assert.equal(h.confirmations[0].source,'device');assert.equal(h.bridge.confirmation(),null);assert.equal(h.sent.length,1);
});
