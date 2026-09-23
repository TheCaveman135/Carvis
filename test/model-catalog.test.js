import test from 'node:test';import assert from 'node:assert/strict';import {discoverModels} from '../server/model-catalog.js';
const saved={provider:'openai',baseUrl:'https://api.openai.com/v1',apiKey:'saved-test-key'};
test('Model discovery uses saved key and returns only deduplicated IDs',async()=>{const result=await discoverModels({},saved,async(url,opts)=>{assert.equal(url,'https://api.openai.com/v1/models');assert.equal(opts.headers.Authorization,'Bearer saved-test-key');assert.equal(opts.redirect,'error');return Response.json({data:[{id:'chat-a'},{id:'chat-a'},{id:'chat-b'},{id:5}]});});assert.deepEqual(result.models,['chat-a','chat-b']);});
test('Changed providers never receive the previous saved key',async()=>{await discoverModels({provider:'compatible',baseUrl:'https://other.example/v1'},saved,async(url,opts)=>{assert.equal(opts.headers.Authorization,undefined);return Response.json({data:[]});});});
test('Unsaved key can list models without changing stored config',async()=>{await discoverModels({apiKey:'new-test-key'},saved,async(url,opts)=>{assert.equal(opts.headers.Authorization,'Bearer new-test-key');return Response.json({data:[]});});assert.equal(saved.apiKey,'saved-test-key');});
test('Missing and rejected keys give actionable errors without upstream secrets',async()=>{await assert.rejects(discoverModels({clearApiKey:true},saved),/Enter your OpenAI/);await assert.rejects(discoverModels({},saved,async()=>new Response('secret',{status:401})),/provider rejected/);});

test('changing to OpenAI uses the global key without sending it to compatible providers', async () => {
 const previous={provider:'compatible',baseUrl:'https://compatible.example/v1',apiKey:'compatible-key'};
 const shared={openai:'global-openai-key'};
 await discoverModels({provider:'openai'},previous,async(url,options)=>{
   assert.equal(url,'https://api.openai.com/v1/models');
   assert.equal(options.headers.Authorization,'Bearer global-openai-key');
   return Response.json({data:[null,{id:'available-model'}]});
 },shared);
 await discoverModels({provider:'compatible',baseUrl:'https://new.example/v1'},previous,async(_url,options)=>{
   assert.equal(options.headers.Authorization,undefined);
   return Response.json({data:[]});
 },shared);
 await assert.rejects(discoverModels({provider:'openai',clearApiKey:true},previous,()=>{throw Error('must not fetch');},shared),/Enter your OpenAI/);
});
