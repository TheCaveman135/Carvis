import test from 'node:test';
import assert from 'node:assert/strict';
import {globalKeys, publicGlobalKeys, updateGlobalKeys, resolvedMainModel} from '../server/global-keys.js';
import {projectRuntimeConfig, runtimeEnvironment} from '../server/assistant-config.js';
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
 updateGlobalKeys(config,{openai:null});assert.equal(globalKeys(config).openai,'');
 assert.throws(()=>updateGlobalKeys(config,{unknown:'secret'}));assert.throws(()=>updateGlobalKeys(config,{openai:123}));
});

test('invalid key patches are atomic and do not discard a saved main credential', () => {
  const config = fixture();
  const before = structuredClone(config);
  assert.throws(() => updateGlobalKeys(config, { openai: 'replacement', unknown: 'invalid' }));
  assert.deepEqual(config, before);
});

test('removing shared keys cannot revive legacy runtime copies, and explicit overrides still work', () => {
  const config = { ...fixture(), profile: {}, model: { provider: 'compatible', apiKey: 'scoped' } };
  const legacy = { stt: { deepgramKey: 'old-deepgram', assemblyaiKey: 'old-assemblyai' }, search: { geminiKey: 'old-gemini' } };
  const environment = { OPENAI_API_KEY: 'old-openai', ANTHROPIC_API_KEY: 'old-anthropic', DEEPGRAM_API_KEY: 'old-deepgram-env', ASSEMBLYAI_API_KEY: 'old-assemblyai-env', GEMINI_API_KEY: 'old-gemini-env' };
  const store = { config, plugin: () => ({ get: key => key === 'environment' ? environment : legacy }) };
  const removed = { openai: null, anthropic: null, deepgram: null, assemblyai: null, gemini: null };
  updateGlobalKeys(config, removed);
  const projected = projectRuntimeConfig(store);
  assert.equal(projected.stt.deepgramKey, '');
  assert.equal(projected.stt.assemblyaiKey, '');
  assert.equal(projected.search.geminiKey, '');
  assert.equal(runtimeEnvironment(store).OPENAI_API_KEY, '');
  assert.equal(runtimeEnvironment(store).ANTHROPIC_API_KEY, '');
  assert.equal(runtimeEnvironment(store).DEEPGRAM_API_KEY, '');
  assert.equal(runtimeEnvironment(store).ASSEMBLYAI_API_KEY, '');
  assert.equal(runtimeEnvironment(store).GEMINI_API_KEY, '');
  assert.equal(resolvedMainModel(config).apiKey, 'scoped');
  config.integrations.voice = { config: { stt__deepgramKey: 'deliberate-override' } };
  config.integrations['assistant-engine'] = { config: { openaiKey: 'deliberate-openai' } };
  assert.equal(projectRuntimeConfig(store).stt.deepgramKey, 'deliberate-override');
  assert.equal(runtimeEnvironment(store).OPENAI_API_KEY, 'deliberate-openai');
});

test('global OpenAI removal clears its old main copy without touching compatible credentials', () => {
  const config = fixture();
  updateGlobalKeys(config, { openai: null });
  assert.equal(config.model.apiKey, '');
  assert.equal(resolvedMainModel(config).apiKey, '');
  config.model = { provider: 'compatible', baseUrl: 'https://provider.example/v1', apiKey: 'scoped-key' };
  updateGlobalKeys(config, { openai: 'shared-key' });
  assert.equal(resolvedMainModel(config).apiKey, 'scoped-key');
});

test('malformed saved provider URLs never expose the main credential as a shared OpenAI key', () => {
  for (const baseUrl of ['not a URL', 'https://owner:secret@api.openai.com/v1', 'http://api.openai.com/v1']) {
    const config = fixture();
    config.model.baseUrl = baseUrl;
    assert.equal(globalKeys(config).openai, '');
  }
});

test('global speech keys override stale runtime copies and explicit overrides remain deliberate',()=>{
 const config={...fixture(),profile:{},apiKeys:{deepgram:'global-current',assemblyai:'global-aai',gemini:'global-gemini'}};
 const legacy={stt:{deepgramKey:'stale-copy',assemblyaiKey:'stale-aai'},search:{geminiKey:'stale-gemini'}};
 const store={config,plugin:()=>({get:()=>legacy})};
 let projected=projectRuntimeConfig(store);
 assert.equal(projected.stt.deepgramKey,'global-current');
 assert.equal(projected.stt.assemblyaiKey,'global-aai');
 assert.equal(projected.search.geminiKey,'global-gemini');
 config.apiKeys.deepgram='rotated';assert.equal(projectRuntimeConfig(store).stt.deepgramKey,'rotated');
 config.integrations.voice={enabled:true,config:{stt__deepgramKey:'explicit-override'}};
 assert.equal(projectRuntimeConfig(store).stt.deepgramKey,'explicit-override');
});
