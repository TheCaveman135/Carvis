import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {Registry} from '../server/registry.js';
import {registerAssistantServices} from '../server/integrations/assistant-services.js';
async function fixture(t) {
 const path=mkdtempSync(join(tmpdir(),'carvis-catalog-'));t.after(()=>rmSync(path,{recursive:true,force:true}));
 const registry=new Registry(new Store(path));
 for(const id of ['home-assistant','apple-tv','even-realities']) {const {default:module}=await import(`../server/integrations/${id}.js`);registry.register({...module,fields:structuredClone(module.fields)});}
 registerAssistantServices(registry);return registry;
}
test('all bundled integrations explain HA requirements and expose native management without legacy links',async t=>{
 const registry=await fixture(t),catalog=registry.list();assert.equal(catalog.length,14);
 for(const item of catalog){assert(['required','recommended','not-required'].includes(item.homeAssistant.requirement));assert(item.homeAssistant.note);assert(item.setupSteps.length);assert.equal(item.controls.module,'/integrations/assistant-engine/controls.js');assert.equal(item.workspaceUrl,undefined);assert.equal(item.workspaceDependsOn,undefined);}
 const byId=id=>catalog.find(i=>i.id===id);
 assert.equal(byId('apple-tv').homeAssistant.requirement,'required');assert(byId('apple-tv').dependsOn.includes('home-assistant'));
 assert.equal(byId('cameras').homeAssistant.requirement,'recommended');assert.match(byId('cameras').homeAssistant.note,/Uploaded images/);
 assert.equal(byId('protocols').homeAssistant.requirement,'recommended');assert.equal(byId('voice').homeAssistant.requirement,'not-required');
});
test('speech choices match supported routes and context settings do not require raw JSON',async t=>{
 const registry=await fixture(t);
 const fields=registry.modules.get('speech').fields;
 assert.deepEqual(fields.find(f=>f.key==='speech__outputMode').options.map(o=>o.value).sort(),['ha_only','phone_only','physical_only','physical_then_ha']);
 const context=registry.modules.get('home-assistant').fields.find(f=>f.key==='areaNotes');assert.equal(context.type,'room-notes');assert.equal(context.advanced,false);
 const engine=registry.modules.get('assistant-engine');assert.equal(engine.fields.find(f=>f.key==='models__providers').advanced,true);
});

test('an unchanged imported companion address does not block display edits, but new HTTP destinations are rejected',async t=>{
 const r=await fixture(t),module=r.modules.get('even-realities');
 r.store.config.integrations['assistant-engine']={enabled:true,config:{}};
 const config={publicBaseUrl:'http://192.0.2.10:8787',pairingToken:'synthetic-pairing-token-long-enough',glasses__feedSize:70};
 r.store.config.integrations['even-realities']={enabled:true,config:{...config}};
 assert.throws(()=>module.validateConfig(config),/HTTPS/);
 r.store.plugin('assistant-engine').set('originalLegacyConfig',{server:{host:'192.0.2.10',port:8787}});
 assert.equal(module.validateConfig({...config,glasses__feedSize:80}).publicBaseUrl,config.publicBaseUrl);
 assert.throws(()=>module.validateConfig({...config,publicBaseUrl:'http://192.0.2.11:8787'}),/HTTPS/);
 assert.throws(()=>module.validateConfig({...config,publicBaseUrl:'http://192.0.2.10:8788'}),/HTTPS/);
 assert.throws(()=>module.validateConfig({...config,pairingToken:'short'}),/32/);
});
