import {FEATURE_IDS} from '../server/features.js';
const TEST_TV={mediaPlayer:'media_player.apple_tv',remoteEntity:'remote.apple_tv',addonSlug:'test_controller'};
import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleModelInput} from '../server/entity-visibility.js';
import {buildTools} from '../server/tools/index.js';
import {ToolGateway} from '../server/tools/gateway.js';
test('model boundary strips unselected IDs and names from history, memory and nested results',()=>{
 const cfg={integrations:Object.fromEntries(FEATURE_IDS.map(id=>[id,true])),appleTv:TEST_TV,entities:{observed:['media_player.apple_tv'],controlled:[]}};
 const ha={listEntities:()=>[{entity_id:'media_player.apple_tv',name:'Apple TV'},{entity_id:'remote.apple_tv',name:'Apple TV'},{entity_id:'lock.secret',name:'Private Door'}]};
 const input={system:'Remember Private Door lock.secret',messages:[{content:'remote.apple_tv and media_player.apple_tv; Apple TV'}],tools:[{schema:{properties:{entity_id:{enum:['remote.apple_tv']}}}}]};
 const result=visibleModelInput(input,cfg,ha),serialized=JSON.stringify(result);
 assert.doesNotMatch(serialized,/remote\.apple_tv|lock\.secret|Private Door/);
 assert.match(serialized,/media_player\.apple_tv/);assert.match(serialized,/Apple TV/);
 assert.match(input.system,/Private Door/);
 cfg.entities.observed=[];assert.doesNotMatch(JSON.stringify(visibleModelInput(input,cfg,ha)),/Apple TV|media_player\.apple_tv/);
});
test('TV tools disappear when TV is unselected; remote is never advertised',()=>{
 const cfg={integrations:Object.fromEntries(FEATURE_IDS.map(id=>[id,true])),appleTv:TEST_TV,entities:{observed:[],controlled:[]}};
 const gateway=new ToolGateway(()=>cfg);gateway.registerAll(buildTools({getConfig:()=>cfg}));
 assert.equal(gateway.definitions().some(t=>t.name.startsWith('ha.apple_tv.')||t.name==='ha.media.navigate'),false);
 cfg.entities.controlled=['media_player.apple_tv'];
 const defs=gateway.definitions();assert.equal(defs.some(t=>t.name==='ha.apple_tv.task'),true);
 assert.doesNotMatch(JSON.stringify(defs.find(t=>t.name==='ha.media.navigate')),/remote\.apple_tv/);
});
test('entity filtering preserves tool protocol names and enum values',()=>{
 const ha={listEntities:()=>[{entity_id:'sensor.power',name:'power'}]};
 const input={tools:[{name:'ha.media.power',schema:{type:'object',properties:{state:{type:'string',enum:['on','off']}}}}],messages:[{role:'user',content:'sensor.power'}]};
 const output=visibleModelInput(input,{entities:{}},ha);
 assert.equal(output.tools[0].name,'ha.media.power');assert.deepEqual(output.tools[0].schema.properties.state.enum,['on','off']);
 assert.equal(output.messages[0].content,'[unavailable]');
});
test('all production tool names and protocol schemas survive entity filtering',()=>{
 const cfg={integrations:Object.fromEntries(FEATURE_IDS.map(id=>[id,true])),appleTv:TEST_TV,entities:{observed:['media_player.apple_tv'],controlled:['media_player.apple_tv']}};
 const gateway=new ToolGateway(()=>cfg);gateway.registerAll(buildTools({getConfig:()=>cfg}));
 const tools=gateway.definitions();
 const filtered=visibleModelInput({tools,system:tools.map(t=>t.name).join(' '),messages:[{role:'assistant',tool_calls:[{type:'function',function:{name:'automation.list',arguments:'{}'}}]}]},cfg,{listEntities:()=>[]});
 assert.deepEqual(filtered.tools.map(t=>t.name),tools.map(t=>t.name));
 assert.equal(filtered.system,tools.map(t=>t.name).join(' '));
 assert.equal(filtered.messages[0].tool_calls[0].function.name,'automation.list');
 for(const tool of filtered.tools)assert.match(tool.name.replaceAll('.','_'),/^[a-zA-Z0-9_-]+$/);
 assert.equal(visibleModelInput('automation.private_rule',cfg,{listEntities:()=>[]}), '[unavailable]');
});
