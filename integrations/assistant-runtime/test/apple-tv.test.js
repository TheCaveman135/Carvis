const TEST_TV={mediaPlayer:'media_player.apple_tv',remoteEntity:'remote.apple_tv',addonSlug:'test_controller'};
import test from 'node:test';
import assert from 'node:assert/strict';
import {AppleTvController} from '../server/apple-tv.js';
import {HAClient} from '../server/ha.js';
import {buildTools} from '../server/tools/index.js';

function fixture() {
  const requests=[],auth=[];
  const ha={url:'https://ha.example',token:'test',send:async message=>{auth.push(message);return message.endpoint.endsWith('/info')?{state:'started',ingress_url:'/api/hassio_ingress/test/'}:{session:'session-test'};}};
  const tv=new AppleTvController({ha,getConfig:()=>({appleTv:TEST_TV}),fetchImpl:async(url,options)=>{
    requests.push({url:String(url),options,body:options.body && JSON.parse(options.body)});
    return {ok:true,status:200,json:async()=>({id:'run-test',status:'completed'})};
  }});
  return {ha,tv,requests,auth};
}

test('Every Apple TV service is routed through the controller, including generic callers',async()=>{
  const ha=new HAClient(),calls=[];ha.getConfig=()=>({appleTv:TEST_TV});
  ha.appleTv={command:async(...args)=>{calls.push(args);return {source:'apple_tv_ai'};}};
  for(const [domain,entity_id,services] of [
    ['remote','remote.apple_tv',['turn_on','turn_off','send_command']],
    ['media_player','media_player.apple_tv',['turn_on','turn_off','media_play','media_pause','media_stop','media_next_track','media_previous_track','select_source','volume_set','play_media']],
  ])for(const service of services)assert.equal((await ha.callService(domain,service,{entity_id})).source,'apple_tv_ai');
  assert.equal(calls.length,13);
  await assert.rejects(()=>ha.callService('media_player','turn_on',{entity_id:['media_player.apple_tv','media_player.spotify']}),/No direct fallback/);
  ha.appleTv=null;
  await assert.rejects(()=>ha.callService('remote','send_command',{entity_id:'remote.apple_tv',command:'select'}),/No direct fallback/);
});

test('Controller uses existing HA ingress session and dedup ID, never sends credentials in payload',async()=>{
  const h=fixture();const result=await h.tv.command('remote','send_command',{entity_id:'remote.apple_tv',command:'select'});
  assert.equal(result.source,'apple_tv_ai');assert.equal(result.verified,false);
  assert.equal(h.requests[0].url,'https://ha.example/api/hassio_ingress/test/api/command');
  assert.equal(h.requests[0].options.headers.Cookie,'ingress_session=session-test');
  assert.deepEqual(h.requests[0].body.data,{command:'select'});
  assert.ok(h.requests[0].body.request_id);assert.equal(h.requests[0].body.token,undefined);
  await h.tv.command('media_player','media_pause',{entity_id:'media_player.apple_tv'});
  assert.equal(h.auth.length,2);assert.notEqual(h.requests[0].body.request_id,h.requests[1].body.request_id);
});

test('Uncertain delivery and busy responses never retry a command',async()=>{
  for(const result of [null,{ok:false,status:409},{ok:false,status:403}]){
    const h=fixture();let attempts=0;
    h.tv.fetch=async()=>{attempts++;if(!result)throw Error('network');return result;};
    await assert.rejects(()=>h.tv.command('remote','send_command',{entity_id:'remote.apple_tv',command:'right'}));
    assert.equal(attempts,1);
  }
});

test('Visual task authorization retains entity selection, guards, live owner and dry-run',async()=>{
  const cfg={appleTv:TEST_TV,entities:{controlled:['media_player.apple_tv'],guards:{'media_player.apple_tv':'standard'}},agent:{allowedDomains:['remote','media_player'],dryRun:false}};
  let starts=0;
  const ha={states:new Map([['remote.apple_tv',{state:'on'}],['media_player.apple_tv',{state:'playing'}]]),appleTv:{start:async()=>{starts++;return {success:true,status:'running'};}}};
  const tool=buildTools({ha,agent:{},getConfig:()=>cfg}).find(t=>t.name==='ha.apple_tv.task');
  assert.equal((await tool.execute({goal:'Find Euphoria'},{triggerType:'user_voice'})).status,'running');
  cfg.agent.dryRun=true;
  assert.equal((await tool.execute({goal:'Find Euphoria'},{triggerType:'user_voice'})).dry_run,true);
  cfg.agent.dryRun=false;cfg.entities.guards['media_player.apple_tv']='protected';
  assert.equal((await tool.execute({goal:'Find Euphoria'},{triggerType:'user_text'})).success,false);
  assert.equal((await tool.execute({goal:'Find Euphoria'},{triggerType:'home_event',confirmed:true})).success,false);
  cfg.entities.controlled=[];
  assert.equal((await tool.execute({goal:'Find Euphoria'},{triggerType:'user_voice',confirmed:true})).success,false);
  assert.equal(starts,1);
});

test('Async completion follows the exact task even if another task is now current',async()=>{
  const h=fixture();let finished;const done=new Promise(r=>finished=r),progress=[];
  h.tv.pollMs=1;h.tv.onProgress=run=>progress.push(run);h.tv.onFinished=run=>finished(run);
  h.tv.fetch=async()=>({ok:true,status:200,json:async()=>({model:'gpt-5.6-luna',run:{id:'new-task',status:'running'},history:[{id:'old-task',status:'blocked',message:'Login required.'}]})});
  h.tv.monitor('old-task',{});
  const keepAlive=setTimeout(()=>finished(null),1000);
  const run=await done;clearTimeout(keepAlive);
  assert.equal(run.id,'old-task');assert.equal(run.status,'blocked');assert.equal(h.tv.monitors.size,0);assert.equal(progress.length,1);
});

test('task status identifies historical claims and carries independent verification evidence',async()=>{
 const cfg={appleTv:TEST_TV,entities:{observed:['media_player.apple_tv'],controlled:[]}};
 const run={id:'past',status:'completed',message:'Playing',finished_at:123};
 const tool=buildTools({getConfig:()=>cfg,ha:{appleTv:{status:async()=>run}}}).find(t=>t.name==='ha.apple_tv.status');
 const old=await tool.execute({});assert.equal(old.live_observation,false);assert.equal(old.completion_verified,false);assert.equal(old.finished_at,123);
 run.completion_check={confirmed:true,time:124,observation:'Movie visible'};
 const verified=await tool.execute({});assert.equal(verified.completion_verified,true);assert.equal(verified.live_observation,false);assert.equal(verified.completion_check.time,124);
});

test('context update targets the existing task and never starts or stops it',async()=>{
 const h=fixture();h.tv.monitor=()=>{};
 h.tv.fetch=async(url,options)=>{h.requests.push({url:String(url),body:JSON.parse(options.body)});return {ok:true,json:async()=>({id:'current-task',status:'running',context_revision:2,applied_context_revision:1})};};
 const r=await h.tv.addContext('current-task','Use Netflix, not Prime');
 assert.equal(r.success,true);assert.equal(r.applied,false);assert.equal(h.requests.length,1);
 assert.match(h.requests[0].url,/\/api\/context$/);assert.equal(h.requests[0].body.task_id,'current-task');assert.equal(h.requests[0].body.context,'Use Netflix, not Prime');
});
test('TV context retains live-owner, selected TV, guard and dry-run checks',async()=>{
 const cfg={appleTv:TEST_TV,entities:{controlled:['media_player.apple_tv']},agent:{allowedDomains:['media_player'],dryRun:false}};let updates=0;
 const ha={states:new Map([['media_player.apple_tv',{state:'on'}]]),appleTv:{addContext:async()=>{updates++;return {success:true};}}};
 const tool=buildTools({ha,agent:{},getConfig:()=>cfg}).find(t=>t.name==='ha.apple_tv.context');
 const args={id:'task1',context:'Netflix'};
 assert.equal((await tool.execute(args,{triggerType:'user_voice'})).success,true);
 assert.equal((await tool.execute(args,{triggerType:'home_event'})).success,false);
 cfg.agent.dryRun=true;assert.equal((await tool.execute(args,{triggerType:'user_text'})).dry_run,true);
 cfg.agent.dryRun=false;cfg.entities.controlled=[];assert.equal((await tool.execute(args,{triggerType:'user_text'})).success,false);
 assert.equal(updates,1);
});

test('TV preview uses authenticated ingress and rejects non-image responses',async()=>{
 const h=fixture();h.tv.fetch=async(url,opts)=>{h.requests.push({url:String(url),opts});return {ok:true,headers:new Headers({'Content-Type':'image/jpeg'}),arrayBuffer:async()=>new Uint8Array([255,216,255]).buffer};};
 const bytes=await h.tv.frame();assert.equal(bytes.length,3);assert.match(h.requests[0].url,/\/api\/frame$/);assert.match(h.requests[0].opts.headers.Cookie,/ingress_session=/);
 h.tv.fetch=async()=>({ok:true,headers:new Headers({'Content-Type':'text/html'})});
 await assert.rejects(()=>h.tv.frame(),/unavailable/);
});

 test('configured TV context reaches new controller tasks without changing live context updates',async()=>{
  const h=fixture();h.tv.monitor=()=>{};
  h.tv.getConfig=()=>({appleTv:{...TEST_TV,context:'Use the sample streaming profile.'}});
  await h.tv.start('Find the requested film');
  assert.equal(h.requests[0].body.goal,'Find the requested film\n\nOwner-provided TV context:\nUse the sample streaming profile.');
  assert.equal(h.requests.length,1);
  await h.tv.addContext('run-test','Search the other service');
  assert.equal(h.requests[1].body.context,'Search the other service');
  h.tv.getConfig=()=>({appleTv:TEST_TV});
  await h.tv.start('Open the home screen');
  assert.equal(h.requests[2].body.goal,'Open the home screen');
 });
