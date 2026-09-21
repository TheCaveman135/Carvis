import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

// Exercise the actual companion modules without requiring a frontend build.
const source = name => readFileSync(new URL(`../integrations/even-realities/src/${name}.ts`,import.meta.url),'utf8');
const moduleUrl = name => {
  let code = stripTypeScriptTypes(source(name),{mode:'strip'});
  if (name === 'vad') code = code.replace("'./config'",JSON.stringify(moduleUrl('config')));
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
};
const {CarvisClient,normalizeConnection}=await import(moduleUrl('client'));
const {WidgetFocus}=await import(moduleUrl('interaction'));
const {hostLifecycleAction}=await import(moduleUrl('lifecycle'));
const {installForegroundRecovery}=await import(moduleUrl('foreground-recovery'));
const {UtteranceDetector}=await import(moduleUrl('vad'));
const {DEFAULTS,STORAGE_KEYS}=await import(moduleUrl('config'));

test('public full companion has no bundled destination or pairing credential',()=>{
  assert.deepEqual(DEFAULTS,{baseUrl:'',token:''});
  for (const key of Object.values(STORAGE_KEYS)) assert.match(key,/^carvis\.public\.full\./);
});

test('pairing validates destinations and an unconfigured device sends no traffic',async()=>{
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(...args)=>{calls.push(args);return Response.json({ok:true});};
  try{
    const client=new CarvisClient('','');
    assert.equal(client.configured,false);
    await assert.rejects(()=>client.pollFeed(0,0),/pairing token first/);
    await assert.rejects(()=>client.sendAudio(new Uint8Array(320)),/pairing token first/);
    await assert.rejects(()=>client.phonePoll('demo',false),/pairing token first/);
    assert.equal(calls.length,0);
    for(const address of ['javascript:alert(1)','http://remote.example','https://u:p@carvis.example','https://carvis.example/?token=x','https://carvis.example/#secret'])assert.throws(()=>normalizeConnection(address,'pairing-token'));
    assert.throws(()=>normalizeConnection('https://carvis.example',''),/pairing token/);
    client.configure('https://carvis.example/','fixture-pairing-token');
    await client.sendText('Hello');
    assert.equal(calls[0][0],'https://carvis.example/api/voice/transcript');
    assert.equal(calls[0][1].headers.Authorization,'Bearer fixture-pairing-token');
    assert.deepEqual(JSON.parse(calls[0][1].body),{text:'Hello'});
    assert.deepEqual(normalizeConnection('http://127.0.0.1:9371/','local'),{baseUrl:'http://127.0.0.1:9371',token:'local'});
    assert.throws(()=>client.configure('http://unsafe.example','changed'));
    await client.sendText('Still paired');
    assert.equal(calls[1][0],'https://carvis.example/api/voice/transcript');
  }finally{globalThis.fetch=original;}
});

test('full widget gestures use numeric order and discard unfinished edits on double tap',()=>{
  const focus=new WidgetFocus();
  const hud={slots:[1,2,3,4].map(slot=>({slot,widget_id:`widget-${slot}`,data:{title:'Demo',value:'50%',control_value:50},interaction:{kind:'slider',field:'brightness_pct',min:0,max:100,step:5,options:[]}}))};
  for(const expected of [1,2,3,4,1]){focus.swipe(1,hud);assert.equal(focus.selected,expected);}
  assert.equal(focus.press(hud),null);
  focus.swipe(1,hud);
  assert.equal(focus.preview(hud.slots[0]),'55% · tap to set');
  focus.clear();
  assert.equal(focus.selected,null);assert.equal(focus.editing,false);
  assert.equal(hud.slots.filter(Boolean).length,4);
  focus.swipe(1,hud);focus.press(hud);focus.swipe(-1,hud);
  assert.deepEqual(focus.press(hud),{slot:1,widget_id:'widget-1',value:45});
  hud.slots[0].widget_id='replacement';focus.sync(hud);assert.equal(focus.selected,null);
});

test('native overlays keep the runtime alive and positive foreground events recover it',()=>{
  assert.equal(hostLifecycleAction(5),'cover');assert.equal(hostLifecycleAction(4),'resume');
  assert.equal(hostLifecycleAction(6),'cleanup');assert.equal(hostLifecycleAction(7),'cleanup');
  const host=new EventTarget(),doc=new EventTarget();let resumed=0;
  doc.visibilityState='hidden';
  const remove=installForegroundRecovery(host,doc,()=>resumed++);
  host.dispatchEvent(new Event('focus'));assert.equal(resumed,0);
  doc.visibilityState='visible';doc.dispatchEvent(new Event('pointerdown'));assert.equal(resumed,1);
  remove();host.dispatchEvent(new Event('pageshow'));assert.equal(resumed,1);
});

test('full microphone segmentation sends speech with pre-roll and keeps silence local',()=>{
  const vad=new UtteranceDetector(),quiet=new Uint8Array(3200),loud=new Uint8Array(3200);
  const samples=new DataView(loud.buffer);for(let i=0;i<loud.length;i+=2)samples.setInt16(i,2500,true);
  for(let i=0;i<20;i++)assert.equal(vad.push(quiet),null);
  for(let i=0;i<5;i++)assert.equal(vad.push(loud),null);
  let utterance;for(let i=0;i<9;i++)utterance=vad.push(quiet);
  assert.ok(utterance?.pcm instanceof Uint8Array);assert.ok(utterance.pcm.length>loud.length*5);
  assert.equal(vad.finish(),null);
  vad.push(loud);vad.reset();assert.equal(vad.finish(),null);
});
