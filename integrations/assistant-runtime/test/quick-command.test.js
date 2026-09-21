const TEST_TV={mediaPlayer:'media_player.apple_tv',remoteEntity:'remote.apple_tv',addonSlug:'test_controller'};
import test from 'node:test';
import assert from 'node:assert/strict';
import {quickCommand,quickReply} from '../server/quick-command.js';
import {Carvis} from '../server/carvis.js';
const cfg={appleTv:TEST_TV,voice:{wakeWords:['carvis'],historyTurns:8},entities:{controlled:['media_player.spotify']},carvis:{maxToolRounds:3}};
const states=new Map([['media_player.spotify',{state:'playing'}]]);
const tvCfg={...cfg,appleTv:TEST_TV,entities:{controlled:['remote.apple_tv','media_player.apple_tv','media_player.bedroom_tv','media_player.spotify']}};
const tvStates=new Map([...states,['remote.apple_tv',{state:'on'}],['media_player.apple_tv',{state:'playing'}],['media_player.bedroom_tv',{state:'off'}]]);
const tvRecent=[{role:'user',content:'turn on Apple TV'},{role:'assistant',content:'Apple TV on.'}];
const tvInventory=[{entity_id:'media_player.apple_tv',name:'Apple TV',area:'Living Room'},{entity_id:'media_player.bedroom_tv',name:'Bedroom TV',area:'Bedroom'}];
for (const [phrase,buttons] of [
 ['Press the home button.',['top_menu']],['Go to the home screen.',['top_menu']],
 ['Select one more time.',['select']],['Alright. Just press the select button.',['select']],
 ['Go up and then select.',['up','select']],['Now press home and then select.',['top_menu','select']],
 ['Go to the right three times.',['right','right','right']],
]) test(`real TV wording executes without main-model or speech: ${phrase}`,async()=>{
 const feeds=[],calls=[];let models=0;
 const carvis=new Carvis({getConfig:()=>tvCfg,gateway:{definitions:()=>[],get:()=>({risk:3}),call:async(name,args,ctx)=>{calls.push({name,args,ctx});return {success:true};}},worldState:{ha:{states:tvStates,listEntities:()=>tvInventory},summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:(...a)=>feeds.push(a)},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:async()=>{models++;throw Error('Model must not run');}});
 carvis.rememberConversation(tvRecent[0].content,tvRecent[1].content);
 const result=await carvis.invoke({trigger:{type:'user_voice',wake_word:false},say:phrase});
 assert.equal(result.outcome,'ok');assert.equal(result.quiet,true);assert.equal(models,0);assert.equal(feeds.length,0);
 assert.deepEqual(calls.map(c=>c.args.button),buttons);assert.ok(calls.every(c=>c.ctx.confirmed===false && c.ctx.wakeWord===false));
});
for(const phrase of ['Alright. Turn on the living room TV, please.','Turn Apple TV off.','Pause the Apple TV.','Resume'])test(`TV power/playback produces exactly one short result: ${phrase}`,async()=>{
 const feeds=[];let calls=0;
 const carvis=new Carvis({getConfig:()=>tvCfg,gateway:{definitions:()=>[],get:()=>({risk:1}),call:async()=>{calls++;return {success:true};}},worldState:{ha:{states:tvStates,listEntities:()=>tvInventory},summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:(...a)=>feeds.push(a)},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:async()=>{throw Error('Model must not run');}});
 carvis.rememberConversation(tvRecent[0].content,tvRecent[1].content);
 const result=await carvis.invoke({trigger:{type:'user_voice'},say:phrase,acknowledgement:'On it, sir.'});
 assert.equal(result.outcome,'ok');assert.equal(result.rounds,0);assert.equal(calls,1);assert.equal(feeds.length,1);assert.ok(feeds[0][1].split(' ').length<=6);
});
test('TV sequences stop immediately on failure and never replay an accepted press',async()=>{
 const feeds=[],calls=[];
 const carvis=new Carvis({getConfig:()=>tvCfg,gateway:{definitions:()=>[],get:()=>({risk:3}),call:async(_name,args)=>{calls.push(args);return calls.length===1?{success:true}:{success:false,error:'Unavailable'};}},worldState:{ha:{states:tvStates},summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:(...a)=>feeds.push(a)},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:async()=>{throw Error('Model must not run');}});
 carvis.rememberConversation(tvRecent[0].content,tvRecent[1].content);
 const result=await carvis.invoke({trigger:{type:'user_voice'},say:'right three times'});
 assert.equal(calls.length,2);assert.equal(result.quiet,false);assert.equal(feeds.length,1);assert.match(feeds[0][1],/1 button presses accepted before stopping/);
});
test('TV fast path resolves explicit targets and recent context without guessing',()=>{
 assert.equal(quickCommand('go to the left',tvCfg,tvStates,tvRecent).arguments.button,'left');
 assert.equal(quickCommand('select on Apple TV',tvCfg,tvStates).quiet,true);
 assert.equal(quickCommand('turn Apple TV off',tvCfg,tvStates).arguments.state,'off');
 assert.equal(quickCommand('pause',tvCfg,tvStates,tvRecent).arguments.entity_id,'media_player.apple_tv');
 for(const phrase of ['left','turn on TV','do not select','select and go left','select in ten minutes']) assert.equal(quickCommand(phrase,tvCfg,tvStates),null,phrase);
 assert.equal(quickCommand('left',tvCfg,tvStates,[{role:'user',content:'pause Spotify'},{role:'assistant',content:'Spotify paused.'}]),null);
});
for(const outcome of [{success:true},{success:false,error:'Confirmation required',requires_confirmation:true},{success:true,dry_run:true}]){
 test(`TV navigation stays quiet only on real success: ${JSON.stringify(outcome)}`,async()=>{
  const feeds=[],calls=[];
  const carvis=new Carvis({getConfig:()=>tvCfg,gateway:{definitions:()=>[],get:()=>({risk:3}),call:async(...args)=>{calls.push(args);return outcome;}},worldState:{ha:{states:tvStates},summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:(...args)=>feeds.push(args)},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:async()=>{throw Error('Unexpected model call');}});
  carvis.rememberConversation('turn on Apple TV','Apple TV on.');
  const result=await carvis.invoke({trigger:{type:'user_voice',wake_word:false},say:'left',acknowledgement:'Moving left, sir.'});
  assert.equal(result.rounds,0);assert.equal(calls.length,1);assert.equal(calls[0][2].wakeWord,false);assert.equal(calls[0][2].confirmed,false);
  assert.equal(feeds.length,outcome.success && !outcome.dry_run ? 0 : 1);
  assert.match(carvis.recentConversation().at(-1).content,outcome.success && !outcome.dry_run ? /Apple TV/ : /couldn't|Dry run/);
 });
}
test('quick commands require a complete single request and unambiguous player',()=>{
 assert.equal(quickCommand('Carvis, skip this song.',cfg,states).arguments.action,'next');
 assert.equal(quickCommand('Please clear my HUD.',cfg,states).name,'hud.clear_all');
 for(const phrase of ['Do not pause Spotify','I told him to pause Spotify','pause Spotify and turn off the lights','pause Spotify in ten minutes','clear my HUD if I leave','unlock the door','pause the TV'])assert.equal(quickCommand(phrase,cfg,states),null,phrase);
 const multi={...cfg,entities:{controlled:[...cfg.entities.controlled,'media_player.tv']}};
 const two=new Map([...states,['media_player.tv',{state:'playing'}]]);
 assert.equal(quickCommand('pause',multi,two),null);assert.equal(quickCommand('pause Spotify',multi,two).arguments.action,'pause');
 assert.equal(quickCommand('pause Spotify',{...cfg,entities:{controlled:[]}},states),null);
});
test('quick replies never turn errors or dry runs into success',()=>{
 const command=quickCommand('pause Spotify',cfg,states);
 assert.match(quickReply(command,{success:false,error:'Unavailable'}),/couldn't.*Unavailable/);
 assert.match(quickReply(command,{success:true,dry_run:true}),/Nothing was changed/);
});
for(const outcome of [{success:true},{success:false,error:'Device unavailable'},{success:true,dry_run:true}]){
 test(`one-tool voice execution needs zero main-model rounds: ${JSON.stringify(outcome)}`,async()=>{
  const feeds=[],calls=[],records=[];let models=0;
  const carvis=new Carvis({getConfig:()=>cfg,gateway:{definitions:()=>[],get:()=>({risk:1}),call:async(...args)=>{calls.push(args);return outcome;}},worldState:{ha:{states},summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:(...args)=>feeds.push(args)},persistInvocation:r=>records.push(r),persistStep:()=>{},invokeWithTools:async()=>{models++;throw Error('unexpected model call');}});
  const result=await carvis.invoke({trigger:{type:'user_voice',wake_word:false},say:'pause Spotify',acknowledgement:"I've got your Spotify request, sir."});
  assert.equal(result.outcome,'ok');assert.equal(result.rounds,0);assert.equal(models,0);assert.equal(calls.length,1);assert.equal(calls[0][2].wakeWord,false);assert.equal(calls[0][2].confirmed,false);
  assert.equal(feeds.length,1);assert.equal(feeds[0][1],quickReply(quickCommand('pause Spotify',cfg,states),outcome));assert.equal(records.at(-1).outcome,'ok');assert.equal(carvis.busy,false);
 });
}
test('overheard and tool-restricted turns cannot enter fast execution',async()=>{
 for(const options of [{trigger:{type:'overheard'},toolNames:['atlas.capture']},{trigger:{type:'user_voice'},toolNames:['atlas.capture']}]){
 let models=0;const calls=[];
 const carvis=new Carvis({getConfig:()=>cfg,gateway:{definitions:()=>[],call:async(...args)=>calls.push(args)},worldState:{ha:{states},summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:()=>{}},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:async()=>{models++;return {text:'',toolCalls:[]};}});
 await carvis.invoke({...options,say:'pause Spotify'});assert.equal(models,1);assert.equal(calls.length,0);
 }
});

for(const source of ['glasses','live'])for(const silentNavigation of [true,false])test(`TV navigation honors silentNavigation=${silentNavigation} through ${source}`,async()=>{
 const configured={...tvCfg,appleTv:{...tvCfg.appleTv,silentNavigation}},feeds=[];
 const carvis=new Carvis({getConfig:()=>configured,gateway:{definitions:()=>[],get:()=>({risk:3}),call:async()=>({success:true})},worldState:{ha:{states:tvStates,listEntities:()=>tvInventory},summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:(...args)=>feeds.push(args)},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:async()=>{throw Error('Navigation must not call the main model');}});
 const result=await carvis.invoke({trigger:{type:source==='live'?'user_text':'user_voice',source},say:'select on Apple TV'});
 assert.equal(result.quiet,silentNavigation);assert.equal(result.rounds,0);
 assert.equal(feeds.length,silentNavigation?0:1);
 if(!silentNavigation)assert.match(feeds[0][1],/button press accepted/);
});

test('shortReplies disabled lets playback use the main conversational loop and configured prompt',async()=>{
 const configured={...tvCfg,appleTv:{...tvCfg.appleTv,shortReplies:false}},feeds=[];let rounds=0;
 const carvis=new Carvis({getConfig:()=>configured,gateway:{definitions:()=>[],get:()=>({risk:1}),call:async()=>({success:true})},worldState:{ha:{states:tvStates,listEntities:()=>tvInventory},summary:()=>''},atlas:{refresh:async()=>{},retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{push:(...args)=>feeds.push(args)},persistInvocation:()=>{},persistStep:()=>{},invokeWithTools:async(_cfg,_role,options)=>{
  assert.match(options.system,/For TV power and playback, use the normal conversational reply style/);
  assert.doesNotMatch(options.system,/TV power and playback need one short result/);
  rounds++;return rounds===1?{toolCalls:[{id:'pause',name:'ha.media.control',arguments:{entity_id:'media_player.apple_tv',action:'pause'}}],usage:{}}:{text:'Playback is paused. Ready whenever you are.',toolCalls:[],usage:{}};
 }});
 const result=await carvis.invoke({trigger:{type:'user_voice',source:'glasses'},say:'Pause the Apple TV'});
 assert.equal(rounds,2);assert.equal(result.quiet,false);assert.equal(feeds.length,1);assert.equal(result.reply,'Playback is paused. Ready whenever you are.');
});
