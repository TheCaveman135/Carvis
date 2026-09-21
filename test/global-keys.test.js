import test from 'node:test';
import assert from 'node:assert/strict';
import {globalKeys, publicGlobalKeys, updateGlobalKeys, resolvedMainModel} from '../server/global-keys.js';
import {runtimeEnvironment} from '../server/assistant-config.js';
const fixture=()=>({model:{provider:'openai',baseUrl:'https://api.openai.com/v1',apiKey:'fixture-main'},integrations:{}});
test('existing OpenAI key is inherited and status never exposes the secret',()=>{
 const config=fixture();assert.equal(globalKeys(config).openai,'fixture-main');
 assert.deepEqual(publicGlobalKeys(config).openai,{saved:true,fromMainProvider:true});
 assert(!JSON.stringify(publicGlobalKeys(config)).includes('fixture-main'));
 const store={config,plugin:()=>({get:()=>({})})};assert.equal(runtimeEnvironment(store).OPENAI_API_KEY,'fixture-main');
 config.integrations['assistant-engine']={config:{openaiKey:'fixture-override'}};
 assert.equal(runtimeEnvironment(store).OPENAI_API_KEY,'fixture-override');
});
test('compatible and custom endpoints do not share their credentials with OpenAI',()=>{
 const config=fixture();config.model.provider='compatible';assert.equal(globalKeys(config).openai,'');
 config.model.provider='openai';config.model.baseUrl='https://provider.example/v1';assert.equal(globalKeys(config).openai,'');
 config.apiKeys={openai:'fixture-global'};assert.equal(resolvedMainModel(config).apiKey,'fixture-main');
});
test('global keys rotate, blank keeps, null removes, and unsupported fields are rejected',()=>{
 const config=fixture();updateGlobalKeys(config,{openai:'fixture-global',anthropic:'fixture-claude'});
 assert.equal(resolvedMainModel(config).apiKey,'fixture-global');
 updateGlobalKeys(config,{openai:''});assert.equal(globalKeys(config).openai,'fixture-global');
 updateGlobalKeys(config,{openai:null});assert.equal(globalKeys(config).openai,'fixture-main');
 assert.throws(()=>updateGlobalKeys(config,{unknown:'secret'}));assert.throws(()=>updateGlobalKeys(config,{openai:123}));
});
