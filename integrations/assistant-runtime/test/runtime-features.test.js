import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS} from '../defaults.js';
import {enabled,effectiveConfig,FEATURE_IDS,toolFeature,toolEnabled} from '../server/features.js';
import {ToolGateway} from '../server/tools/gateway.js';
import {Carvis} from '../server/carvis.js';
import {tvCommand} from '../server/tv-command.js';
import {MemoryStore} from '../server/memory.js';
import {saveConfig,publicConfig,loadConfig} from '../server/config.js';

const fixture=()=>structuredClone(DEFAULTS);

test('public defaults require explicit service setup and enable no integrations',()=>{
 const cfg=fixture();
 assert.deepEqual(Object.keys(cfg.integrations),FEATURE_IDS);
 assert.ok(FEATURE_IDS.every(id=>!enabled(cfg,id)));
 assert.equal(cfg.ha.url,'');assert.equal(cfg.atlas.baseUrl,'');assert.equal(cfg.appleTv.baseUrl,'');
 assert.deepEqual(cfg.entities,{observed:[],controlled:[],guards:{}});
 assert.deepEqual(cfg.stt.keyterms,[]);assert.deepEqual(cfg.areaNotes,{});
 assert.ok(cfg.models.providers.every(provider=>!provider.baseUrl));
 assert.ok(Object.values(cfg.models.roles).every(role=>!role.model));
 assert.equal(cfg.glasses.enabled,false);assert.equal(cfg.voice.enabled,false);assert.equal(cfg.speech.autoReplies,false);
});

test('disabled integrations disappear from schemas and reject direct invocation before execution',async()=>{
 const cfg=fixture(),calls=[];
 const gateway=new ToolGateway(()=>cfg);
 for(const name of ['ha.get_state','ha.apple_tv.task','hud.clear_all','memory.search','vision.inspect','web.search','automation.list','math.calculate'])
  gateway.register({name,execute:async()=>{calls.push(name);return {success:true};}});
 assert.deepEqual(gateway.definitions(),[]);assert.deepEqual(gateway.inventory(),[]);
 for(const name of gateway.tools.keys())assert.equal((await gateway.call(name,{})).success,false);
 assert.deepEqual(calls,[]);
 cfg.integrations['apple-tv']=true;
 assert.deepEqual(gateway.definitions().map(tool=>tool.name),['ha.apple_tv.task']);
 assert.equal((await gateway.call('ha.apple_tv.task',{})).success,true);
 assert.deepEqual(calls,['ha.apple_tv.task']);
 assert.equal(toolFeature('ha.media.navigate'),'apple-tv');
});

test('effective configuration masks disabled adapters without mutating saved owner settings',()=>{
 const raw=fixture();raw.ha={url:'https://ha.example',token:'fixture-only'};
 raw.entities.controlled=['light.example'];raw.voice.enabled=true;raw.sessions.enabled=true;
 const active=effectiveConfig(raw);
 assert.equal(active.ha.token,'');assert.deepEqual(active.entities.controlled,[]);assert.equal(active.voice.enabled,false);
 assert.equal(raw.ha.token,'fixture-only');assert.deepEqual(raw.entities.controlled,['light.example']);assert.equal(raw.voice.enabled,true);
 raw.integrations.proactivity=true;assert.equal(effectiveConfig(raw).sessions.enabled,true);
 raw.integrations['learned-memory']=true;raw.integrations.proactivity=false;assert.equal(effectiveConfig(raw).sessions.enabled,false);
});

test('pause blocks background execution while retaining explicit owner interaction',()=>{
 const before=process.env.CARVIS_RUNTIME_PAUSED;
 try {
  process.env.CARVIS_RUNTIME_PAUSED='1';const cfg=fixture();cfg.integrations['home-assistant']=true;
  assert.equal(toolEnabled(cfg,'ha.get_state',{triggerType:'event'}),false);
  assert.equal(toolEnabled(cfg,'ha.get_state',{triggerType:'user_text'}),true);
  assert.equal(effectiveConfig(cfg).classifier.enabled,false);
 }finally{if(before===undefined)delete process.env.CARVIS_RUNTIME_PAUSED;else process.env.CARVIS_RUNTIME_PAUSED=before;}
});

test('runtime browser config redacts every integration secret while raw persistence retains values',()=>{
 const cfg=fixture();cfg.atlas.token='fixture-atlas';cfg.appleTv.token='fixture-tv';cfg.ha.token='fixture-ha';cfg.glasses.token='fixture-glasses';cfg.stt.deepgramKey='fixture-stt';cfg.models.providers.push({id:'fixture',apiKey:'fixture-provider',headers:{Authorization:'fixture-header'},apiKeyEnv:'EXAMPLE_API_KEY'});
 let invalidations=0;const invalidate=()=>invalidations++;process.on('carvis:config-changed',invalidate);
 try{saveConfig(cfg);}finally{process.off('carvis:config-changed',invalidate);}
 assert.equal(invalidations,1);assert.equal(loadConfig().atlas.token,'fixture-atlas');
 const browser=publicConfig();
 for(const value of ['fixture-atlas','fixture-tv','fixture-ha','fixture-glasses','fixture-stt','fixture-provider','fixture-header'])assert.ok(!JSON.stringify(browser).includes(value));
 assert.equal(browser.models.providers.at(-1).apiKeyEnv,'EXAMPLE_API_KEY');assert.equal(browser.atlas.tokenSet,true);assert.equal(browser.appleTv.tokenSet,true);
});

test('standing owner rules survive disabling learned retrieval',()=>{
 const cfg=fixture(),memory=new MemoryStore(()=>cfg);memory.start();
 memory.remember({text:'Never open the test door automatically.',kind:'rule',source:'owner'});
 memory.remember({text:'The sample chair is red.',kind:'fact',source:'owner'});
 const rulesOnly=new MemoryStore(()=>cfg);rulesOnly.start({rulesOnly:true});
 assert.equal(rulesOnly.all().length,1);assert.equal(rulesOnly.all()[0].kind,'rule');
 const carvis=new Carvis({getConfig:()=>cfg,gateway:{},worldState:{ha:{states:new Map(),listEntities:()=>[]},summary:()=>''},atlas:{retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push(){}}});
 carvis.ownerRules=()=>rulesOnly.rules().map(rule=>rule.text).join('\n');
 assert.match(carvis.context(),/Never open the test door automatically/);
 assert.doesNotMatch(carvis.context(),/sample chair/);
});

test('disabled assistant engine cannot be awakened by a background protocol',async()=>{
 const carvis=new Carvis({getConfig:fixture,gateway:{},worldState:{},atlas:{},feed:{}});
 assert.equal((await carvis.invoke({trigger:{type:'event'},say:'hello'})).outcome,'disabled');
});

test('TV grammar resolves configured entity IDs and honors navigation/reply preferences',()=>{
 const cfg=fixture();cfg.appleTv={mediaPlayer:'media_player.streaming_box',remoteEntity:'remote.streaming_remote',silentNavigation:false,shortReplies:true};
 cfg.entities.controlled=[cfg.appleTv.mediaPlayer];const states=new Map([[cfg.appleTv.mediaPlayer,{state:'on'}]]);
 const nav=tvCommand('select on Apple TV',cfg,states);
 assert.equal(nav.arguments.entity_id,'media_player.streaming_box');assert.equal(nav.quiet,false);
 assert.equal(tvCommand('turn Apple TV off',cfg,states).arguments.state,'off');
 cfg.appleTv.shortReplies=false;assert.equal(tvCommand('turn Apple TV off',cfg,states),null);
});

test('retired Atlas integration remains disabled even with legacy enabled settings',()=>{
 const cfg=fixture();cfg.integrations.atlas=true;cfg.atlas.enabled=true;
 assert.equal(enabled(cfg,'atlas'),false);assert.equal(toolEnabled(cfg,'atlas.capture'),false);assert.equal(effectiveConfig(cfg).atlas.enabled,false);
});
