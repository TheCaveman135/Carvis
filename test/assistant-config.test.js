import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS} from '../integrations/assistant-runtime/defaults.js';
import {integrationConfigFromLegacy,projectRuntimeConfig} from '../server/assistant-config.js';

function fixture(original) {
 const config={integrations:integrationConfigFromLegacy(original),auth:{},profile:{personality:'Synthetic persona'},model:{model:''}};
 const store={config,plugin:()=>({get:(_key,fallback)=>original || fallback})};
 return store;
}

test('disabled integrations retain their private settings through projection and a later legacy save',()=>{
 const saved=structuredClone(DEFAULTS);
 for(const section of ['voice','stt','glasses','classifier','sessions','atlas','mac','search'])saved[section].enabled=true;
 saved.stt.deepgramKey='synthetic-stt-key';saved.voice.confirmationTimeoutSec=19;
 const store=fixture(saved);
 for(const id of ['voice','even-realities','proactivity','atlas','desktop','web-search'])store.config.integrations[id].enabled=false;
 const projected=projectRuntimeConfig(store);
 for(const section of ['voice','stt','glasses','classifier','sessions','atlas','mac','search'])assert.equal(projected[section].enabled,true,section);
 assert.equal(projected.integrations.voice,false);
 const afterSave=integrationConfigFromLegacy(projected);
 assert.equal(afterSave.voice.config.voice__enabled,true);assert.equal(afterSave.voice.config.stt__enabled,true);
 assert.equal(afterSave.voice.config.stt__deepgramKey,'synthetic-stt-key');assert.equal(afterSave.voice.config.voice__confirmationTimeoutSec,19);
});

test('runtime projection preserves role tuning and supplemental saved configuration',()=>{
 const saved=structuredClone(DEFAULTS);
 saved.models.roles.carvis={provider:'example',model:'example-model',effort:'high',maxTokens:3210,temperature:0.37,timeoutSec:44};
 saved.models.roles.voice_triage={provider:'example',model:'fast-example',effort:'low',maxTokens:678};
 saved.models.providers.push({id:'example',kind:'openai',baseUrl:'https://model.example/v1',apiKeyEnv:'EXAMPLE_KEY',api:'chat'});
 saved.agent.houseRules='Never perform the synthetic restricted action.';
 const store=fixture(saved);const projected=projectRuntimeConfig(store);
 assert.deepEqual(projected.models.roles.carvis,saved.models.roles.carvis);
 assert.equal(projected.models.roles.voice_triage.model,'fast-example');
 assert.equal(projected.models.roles.voice_triage.maxTokens,678);
 assert.equal(projected.models.providers.find(p=>p.id==='example').api,'chat');
 assert.equal(projected.agent.houseRules,saved.agent.houseRules);
});
