import test from 'node:test';
import assert from 'node:assert/strict';
import {integrationModels} from '../server/integration-models.js';
function fixture(){
 const store={config:{model:{provider:'compatible',baseUrl:'https://model.example/v1',model:'main',apiKey:'fixture-key'},profile:{},integrations:{}},plugin:()=>({get:(_key,fallback)=>fallback})};
 const registry={modules:new Map([['cameras',{fields:[{key:'models__roles__vision__model'}]}],['voice',{fields:[{key:'stt__model'}]}]])};
 return {store,registry};
}
test('integration picker resolves saved provider credentials and returns only deduplicated IDs',async()=>{
 const {store,registry}=fixture();let request;
 const result=await integrationModels({integrationId:'cameras',field:'models__roles__vision__model',providerId:'carvis-primary'},store,registry,async(url,options)=>{request={url,options};return Response.json({data:[{id:'vision-a'},{id:'vision-a'},{id:'vision-b'}]});});
 assert.deepEqual(result.models,['vision-a','vision-b']);assert.equal(request.url,'https://model.example/v1/models');assert.equal(request.options.headers.Authorization,'Bearer fixture-key');assert.equal(request.options.redirect,'error');assert(!JSON.stringify(result).includes('fixture-key'));
});
test('picker rejects unknown fields before making any external request',async()=>{
 const {store,registry}=fixture();await assert.rejects(()=>integrationModels({integrationId:'cameras',field:'secret'},store,registry,()=>{throw Error('must not fetch');}),/Unknown integration model/);
});
test('Deepgram picker only returns batch transcription models',async()=>{
 const {store,registry}=fixture();store.config.apiKeys={deepgram:'fixture-dg'};
 const result=await integrationModels({integrationId:'voice',field:'stt__model'},store,registry,async(url,options)=>{assert.equal(url,'https://api.deepgram.com/v1/models');assert.equal(options.headers.Authorization,'Token fixture-dg');return Response.json({stt:[{canonical_name:'nova-3',batch:true},{canonical_name:'stream-only',batch:false}],tts:[{name:'not-transcription'}]});});
 assert.deepEqual(result.models,['nova-3']);
});
