import test from 'node:test';
import assert from 'node:assert/strict';
import {modelRouterEntries} from '../web/model-router.js';
test('model router hides disabled integrations and discovers model fields',()=>{
 const entries=modelRouterEntries([
  {id:'cameras',enabled:false,fields:[{key:'models__roles__vision__model',type:'text'}]},
  {id:'custom-ai',enabled:true,fields:[{key:'model',type:'text'},{key:'apiKey',type:'password'}]},
  {id:'home-assistant',enabled:true,fields:[]},
  {id:'apple-tv',enabled:true,fields:[]},
 ]);
 assert.deepEqual(entries.map(e=>e.integration.id),['custom-ai','apple-tv']);
 assert.equal(entries[0].fields.length,1);
 assert.match(entries[1].note,/controller/);
});
