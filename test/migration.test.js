import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { createAccount, verifyPassword } from '../server/auth.js';
import { migrateLegacy, parseEnvironment, projectPrimaryModel, recoverCodeDefaults, normalizeProviderCredentials } from '../scripts/migrate-legacy.mjs';
import { projectRuntimeConfig, runtimeEnvironment } from '../server/assistant-config.js';
import { Registry } from '../server/registry.js';
import { registerAssistantServices } from '../server/integrations/assistant-services.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'carvis-migration-test-'));
  let db;
  t.after(() => { try { db?.close(); } catch {} rmSync(root, {recursive:true,force:true}); });
  const source = join(root, 'source'), data = join(root, 'private', 'carvis');
  mkdirSync(source);
  const config = {
    auth:createAccount('fixture-owner','test-password-long-enough'),
    carvis:{personality:'Fixture personality, preserve exactly.'},
    models:{providers:[{id:'fixture',kind:'openai',baseUrl:'https://api.openai.com/v1',apiKeyEnv:'CUSTOM_MODEL_KEY'}],roles:{carvis:{provider:'fixture',model:'fixture-model',effort:'low'}}},
    ha:{url:'http://ha.example',token:'private-fixture-ha-token'},
    entities:{observed:['light.fixture'],controlled:['light.fixture'],guards:{'light.fixture':'standard','lock.orphan':'protected'}},
    agent:{dryRun:false,allowedDomains:['light'],cooldownSec:111},
  };
  const configText=JSON.stringify(config);
  writeFileSync(join(source,'config.json'),configText);
  writeFileSync(join(source,'.env'),'CUSTOM_MODEL_KEY="private-fixture-model-key"\nEXTRA_KEY=literal$(never-executed)\n');
  const history=Array.from({length:32},(_,i)=>({role:i%2?'assistant':'user',content:`Fixture message ${i}`,at:1000+i}));
  const conversationText=JSON.stringify({history,summary:'Fixture summary',updatedAt:2000});
  writeFileSync(join(source,'conversation.json'),conversationText);
  writeFileSync(join(source,'patterns.json'),JSON.stringify({version:1,observations:[{kind:'fixture'}]}));
  db=new DatabaseSync(join(source,'carvis.db'));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE memories(id TEXT PRIMARY KEY,text TEXT,kind TEXT,source TEXT,ts INTEGER,updated_at INTEGER); CREATE TABLE automation_timers(id TEXT PRIMARY KEY,status TEXT,due_at INTEGER);");
  db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?)').run('memory-one','Fixture preference','preference','owner',100,200);
  db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?)').run('memory-two','Fixture fact','fact','carvis',110,210);
  db.prepare('INSERT INTO automation_timers VALUES (?,?,?)').run('future-timer','active',Date.now()+3600000);
  const projectIntegrations=(cfg,env)=>({
    'assistant-engine':{enabled:true,config:{openaiKey:env.CUSTOM_MODEL_KEY}},
    'home-assistant':{enabled:true,config:{baseUrl:cfg.ha.url,token:cfg.ha.token,observed:cfg.entities.observed,controlled:cfg.entities.controlled,guards:Object.fromEntries(Object.entries(cfg.entities.guards).filter(([id])=>cfg.entities.controlled.includes(id))),dryRun:cfg.agent.dryRun,agent__allowedDomains:cfg.agent.allowedDomains}},
    'learned-memory':{enabled:true,config:{}},
    'even-realities':{enabled:true,config:{publicBaseUrl:'',pairingToken:'fixture-pairing-token'}},
  });
  return {root,source,data,config,configText,conversationText,db,projectIntegrations};
}
test('offline migration preserves account, model, full private settings, WAL database, history and restrictions',async t=>{
  const f=fixture(t);assert(existsSync(join(f.source,'carvis.db-wal')));
  const report=await migrateLegacy(f);
  const store=new Store(f.data),engine=store.plugin('assistant-engine');
  assert.deepEqual(store.config.auth,f.config.auth);assert(verifyPassword(store.config,'fixture-owner','test-password-long-enough'));
  assert.equal(store.config.model.model,'fixture-model');assert.equal(store.config.model.apiKey,'private-fixture-model-key');assert.equal(store.config.profile.personality,f.config.carvis.personality);
  assert.deepEqual(engine.get('legacyConfig'),f.config);assert.equal(engine.get('environment').EXTRA_KEY,'literal$(never-executed)');
  assert.equal(store.config.integrations['home-assistant'].config.guards['lock.orphan'],undefined);assert.equal(engine.get('legacyConfig').entities.guards['lock.orphan'],'protected');
  assert.deepEqual(store.config.integrations['home-assistant'].config.agent__allowedDomains,['light']);
  assert.equal(store.data.conversations.length,1);assert.equal(store.data.conversations[0].messages.length,32);assert.equal(store.data.conversations[0].messages[0].content,'Fixture message 0');
  assert.equal(store.data.memory.length,0);assert.equal(report.learnedMemoriesPreserved,2);assert.equal(report.coreModelImported,true);assert.equal(report.runtimeStarted,false);
  const migrated=new DatabaseSync(join(f.data,'assistant-runtime','carvis.db'),{readOnly:true});
  assert.equal(migrated.prepare('SELECT count(*) AS n FROM memories').get().n,2);assert.equal(migrated.prepare('SELECT status FROM automation_timers').get().status,'active');migrated.close();
  assert.equal(readFileSync(join(f.data,'assistant-runtime','conversation.json'),'utf8'),f.conversationText);
  assert.equal(readFileSync(join(f.source,'config.json'),'utf8'),f.configText);assert.equal(f.db.prepare('SELECT count(*) AS n FROM memories').get().n,2);
  assert(!existsSync(join(f.data,'assistant-runtime','config.json')));assert(!existsSync(join(f.data,'assistant-runtime','.env')));
  assert(!readFileSync(join(f.data,'config.enc'),'utf8').includes('private-fixture-model-key'));assert(!readFileSync(join(f.data,'data.enc'),'utf8').includes('private-fixture-ha-token'));
  assert.equal(statSync(f.data).mode&0o777,0o700);assert.equal(statSync(join(f.data,'assistant-runtime','carvis.db')).mode&0o777,0o600);
  assert(!JSON.stringify(report).includes(f.source));assert(!JSON.stringify(report).includes('fixture-model'));assert(!JSON.stringify(report).includes('token'));
});
test('core memory import is explicit and deduplicates text; optional URL is private configuration',async t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?)').run('memory-three','Fixture preference','preference','owner',120,220);
  const report=await migrateLegacy({...f,importCoreMemory:true,publicUrl:'https://carvis.example/'});
  const store=new Store(f.data);assert.equal(store.data.memory.length,2);assert.equal(report.learnedMemoriesPreserved,3);assert.equal(store.config.integrations['even-realities'].config.publicBaseUrl,'https://carvis.example');
});
test('migration rejects nonempty, source-overlapping, and cloud-synced destinations',async t=>{
  const f=fixture(t);mkdirSync(f.data,{recursive:true});writeFileSync(join(f.data,'existing'),'leave alone');
  await assert.rejects(migrateLegacy(f),/not empty/);assert.equal(readFileSync(join(f.data,'existing'),'utf8'),'leave alone');
  await assert.rejects(migrateLegacy({...f,data:join(f.source,'child')}),/separate private/);
  await assert.rejects(migrateLegacy({...f,data:join(f.root,'Library','Mobile Documents','example')}),/cloud-synced/);
  await assert.rejects(migrateLegacy({...f,source:null}),/both/);
});
test('empty destination succeeds and corrupt database leaves no partial installation',async t=>{
  const f=fixture(t);mkdirSync(f.data,{recursive:true});await migrateLegacy(f);assert(existsSync(join(f.data,'config.enc')));
  const source=join(f.root,'broken');mkdirSync(source);writeFileSync(join(source,'config.json'),f.configText);writeFileSync(join(source,'carvis.db'),'not a database');
  const target=join(f.root,'failed');await assert.rejects(migrateLegacy({...f,source,data:target}),/database/);assert(!existsSync(target));assert(!readdirSync(f.root).some(name=>name.startsWith('.carvis-migration-')));
});
test('environment parsing is literal and model projection follows the bound provider key',()=>{
  assert.deepEqual(parseEnvironment('export KEY="hello"\nOTHER=abc#literal\nEMPTY=\n'),{KEY:'hello',OTHER:'abc#literal',EMPTY:''});
  assert.throws(()=>parseEnvironment('not an assignment'),/could not be parsed/);
  const cfg={models:{providers:[{id:'local',kind:'ollama',baseUrl:'http://localhost:11434'}],roles:{carvis:{provider:'local',model:'fixture'}}}};
  assert.deepEqual(projectPrimaryModel(cfg,{}),{provider:'ollama',model:'fixture',baseUrl:'http://localhost:11434/v1',apiKey:''});
  cfg.models.providers[0].kind='unsupported';assert.equal(projectPrimaryModel(cfg,{}),null);
});
test('real integration projector preserves private code defaults without broadening selections',async t=>{
  const f=fixture(t);
  f.config.entities.observed.push('media_player.fixture_tv');
  f.config.entities.controlled.push('media_player.fixture_tv');
  f.config.glasses={enabled:true,token:'fixture-original-device-token'};
  f.config.stt={enabled:true,engine:'deepgram',model:'nova-3'};
  writeFileSync(join(f.source,'config.json'),JSON.stringify(f.config));
  mkdirSync(join(f.source,'server'));
  writeFileSync(join(f.source,'server','stt.js'),"export function deepgramUrl(model, keyterms = ['fixture word', 'Fixture Room']) {}\n");
  writeFileSync(join(f.source,'server','live-voice.js'),"this.fetch('https://voice.example/v1/live/sessions', {body:JSON.stringify({session:{model:'fixture-live'}})})\n");
  writeFileSync(join(f.source,'server','apple-tv.js'),"export const APPLE_TV_ENTITIES = new Set(['remote.fixture_tv', 'media_player.fixture_tv']);\nconst request = {endpoint:'/addons/fixture_tv_controller/info'};\n");
  const report=await migrateLegacy({...f,projectIntegrations:undefined});
  const store=new Store(f.data),engine=store.plugin('assistant-engine'),runtime=projectRuntimeConfig(store);
  assert.deepEqual(engine.get('originalLegacyConfig'),f.config);
  assert.deepEqual(engine.get('legacyConfig').stt.keyterms,['fixture word','Fixture Room']);
  assert.deepEqual(store.config.integrations.voice.config.stt__keyterms,['fixture word','Fixture Room']);
  assert.deepEqual(runtime.stt.keyterms,['fixture word','Fixture Room']);
  assert.equal(runtime.liveVoice.baseUrl,'https://voice.example/v1');assert.equal(runtime.liveVoice.model,'fixture-live');assert.equal(runtime.liveVoice.voice,'');
  assert.equal(runtime.appleTv.remoteEntity,'remote.fixture_tv');assert.equal(runtime.appleTv.mediaPlayer,'media_player.fixture_tv');assert.equal(runtime.appleTv.addonSlug,'fixture_tv_controller');
  assert.deepEqual(runtime.entities.observed,f.config.entities.observed);assert.deepEqual(runtime.entities.controlled,f.config.entities.controlled);
  assert.equal(runtime.entities.guards['lock.orphan'],'protected');assert.equal(runtime.agent.dryRun,false);assert.deepEqual(runtime.agent.allowedDomains,['light']);assert.equal(runtime.agent.cooldownSec,111);
  assert.equal(store.config.integrations['even-realities'].config.pairingToken,'fixture-original-device-token');assert.equal(store.config.integrations['even-realities'].config.glasses__token,undefined);
  assert.equal(runtimeEnvironment(store).CARVIS_PRIMARY_API_KEY,'private-fixture-model-key');
  assert.equal(runtime.models.roles.carvis.model,'fixture-model');assert.equal(runtime.models.roles.carvis.effort,'low');assert.equal(runtime.models.roles.carvis.provider,'carvis-primary');
  assert.equal(report.unmappedDefaults,0);assert.equal(report.recoveredDefaults,6);
});
test('code default recovery accepts literal data only and preserves explicit settings',()=>{
  const source={stt:"export function deepgramUrl(model, keyterms = ['one', 'owner\\\'s', '\\u0061']) {}"};
  assert.deepEqual(recoverCodeDefaults({},source).config.stt.keyterms,['one',"owner's",'a']);
  const explicit={stt:{keyterms:['explicit']},liveVoice:{baseUrl:'https://configured.example',model:'configured',voice:'configured'}};
  assert.deepEqual(recoverCodeDefaults(explicit,{...source,liveVoice:"this.fetch('https://other.example/live/sessions',{session:{model:'other'}})"}).config,explicit);
  const invalid=recoverCodeDefaults({},{stt:"function deepgramUrl(model, keyterms = ['safe', process.exit()]) {}"});
  assert.equal(invalid.unmappedDefaults,1);assert.equal(invalid.config.stt,undefined);
});
test('inline provider credentials become private environment bindings before UI projection',async t=>{
  const f=fixture(t);
  f.config.models.providers=[{id:'fixture-inline',kind:'openai',baseUrl:'https://api.openai.com/v1',apiKey:'fixture-inline-secret',token:'fixture-unused-token'}];
  f.config.models.roles.carvis.provider='fixture-inline';
  writeFileSync(join(f.source,'config.json'),JSON.stringify(f.config));
  const report=await migrateLegacy({...f,projectIntegrations:undefined});
  const store=new Store(f.data),engine=store.plugin('assistant-engine');
  assert.equal(engine.get('originalLegacyConfig').models.providers[0].apiKey,'fixture-inline-secret');
  const provider=engine.get('legacyConfig').models.providers[0],environment=engine.get('environment');
  assert.equal(provider.apiKey,undefined);assert.equal(provider.token,undefined);
  assert.equal(environment[provider.apiKeyEnv],'fixture-inline-secret');assert.equal(store.config.model.apiKey,'fixture-inline-secret');
  assert.equal(Object.values(environment).includes('fixture-unused-token'),true);assert.equal(report.credentialBindings,2);
  const registry=new Registry(store);registerAssistantServices(registry);
  const metadata=JSON.stringify(registry.list());
  assert(!metadata.includes('fixture-inline-secret'));assert(!metadata.includes('fixture-unused-token'));
  const protectedBinding=normalizeProviderCredentials({models:{providers:[{id:'same',apiKey:'inline-other',token:'',apiKeyEnv:'EXISTING'}]}},{EXISTING:'keep-existing',CARVIS_PROVIDER_SAME_KEY:'keep-collision'});
  assert.equal(protectedBinding.config.models.providers[0].apiKeyEnv,'EXISTING');
  assert.equal(protectedBinding.environment.EXISTING,'keep-existing');assert.equal(protectedBinding.environment.CARVIS_PROVIDER_SAME_KEY,'keep-collision');assert.equal(protectedBinding.environment.CARVIS_PROVIDER_SAME_KEY_2,'inline-other');
});
test('runtime model projection preserves the selected API protocol rather than guessing from a model name',t=>{
  const f=fixture(t),store=new Store(f.data);
  store.config.model={provider:'compatible',model:'gpt-5-fixture',baseUrl:'https://api.openai.com/v1',apiKey:''};
  let provider=projectRuntimeConfig(store).models.providers.find(p=>p.id==='carvis-primary');
  assert.equal(provider.kind,'openai');assert.equal(provider.api,'chat');
  store.config.model.provider='openai';store.config.model.model='fixture-new-generation';
  provider=projectRuntimeConfig(store).models.providers.find(p=>p.id==='carvis-primary');assert.equal(provider.api,'responses');
  store.config.model={provider:'ollama',model:'fixture',baseUrl:'http://localhost:11434/v1',apiKey:''};
  provider=projectRuntimeConfig(store).models.providers.find(p=>p.id==='carvis-primary');assert.equal(provider.kind,'ollama');assert.equal(provider.api,undefined);assert.equal(provider.baseUrl,'http://localhost:11434');
});
