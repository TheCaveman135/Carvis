import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function client({getUserMedia,authenticated=true,respond,panel=false}={}) {
 const nodes=new Map(),requests=[],sent=[],peers=[],timers=new Map();let timerId=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,hidden:false,textContent:'',value:'',handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},play:async()=>{}});return nodes.get(id);};
 const track={stopped:false,stop(){this.stopped=true;}};
 const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 class Peer {
  constructor(){peers.push(this);this.iceGatheringState='complete';this.events={handlers:{},readyState:'open',addEventListener(type,fn){this.handlers[type]=fn;},send:s=>sent.push(JSON.parse(s)),close(){this.readyState='closed';}};}
  addEventListener(){} addTrack(){} createDataChannel(){return this.events;}
  async createOffer(){return {sdp:'v=0\r\noffer'};} async setLocalDescription(value){this.localDescription=value;} async setRemoteDescription(){} close(){this.closed=true;}
 }
 const context={document:{querySelector:node},window:{isSecureContext:true,addEventListener(){},removeEventListener(){}},navigator:{mediaDevices:{getUserMedia:getUserMedia || (async()=>stream)}},RTCPeerConnection:Peer,MediaStream:class{},setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearTimeout(id){timers.delete(id);},AbortSignal,Date,Map,JSON,Number,String,Promise,Error,
 fetch:async(path,options)=>{
  requests.push({path,body:options?.body?JSON.parse(options.body):null});
  const custom=respond?.(path,options);if(custom)return custom;
  if(path==='/integrations/assistant-engine/api/auth/login')authenticated=true;
  return {ok:true,status:200,json:async()=>path==='/integrations/assistant-engine/api/auth/status'?{configured:true,authenticated}:path==='/integrations/assistant-engine/api/live/status'?{available:true}:path==='/integrations/assistant-engine/api/live/session'?{session:{id:'live_test'},transport:{sdp:'answer'}}:path==='/integrations/assistant-engine/api/live/delegate'?{silent:true,reply:'Apple TV: button accepted.'}:{ok:true}};
 }};
 let dispose;
 if(panel){vm.runInNewContext(fs.readFileSync(new URL('../web/live-panel.js',import.meta.url),'utf8').replace('export function mountLive','function mountLive'),context);dispose=context.mountLive(context.document);}
 else vm.runInNewContext(fs.readFileSync(new URL('../web/live.js',import.meta.url),'utf8'),context);
 return {node,requests,sent,peers,track,stream,timers,dispose,loaded:new Promise(r=>setImmediate(r))};
}
test('Live browser sends a delegation once, returns quiet results, and releases microphone on end',async()=>{
 const h=client();await h.loaded;await h.node('#start').handlers.click();const channel=h.peers[0].events;
 const event=value=>channel.handlers.message({data:JSON.stringify(value)});
 event({type:'session.started'});event({type:'session.input_transcript.delta',delta:'select',start_ms:0,end_ms:100});
 const delegation={type:'session.delegation.created',offset_ms:150,delegation:{id:'item_1',target:'client'}};
 event(delegation);event(delegation);await new Promise(r=>setImmediate(r));
 assert.equal(h.requests.filter(r=>r.path==='/integrations/assistant-engine/api/live/delegate').length,1);
 assert.equal(h.requests.find(r=>r.path==='/integrations/assistant-engine/api/live/delegate').body.text,'select');
 assert.equal(h.sent[0].type,'session.thinking.append');
 h.node('#end').handlers.click();assert.equal(h.sent.at(-1).type,'session.close');
 event({type:'session.closed'});assert.equal(h.track.stopped,true);assert.equal(h.peers[0].closed,true);
 assert.ok(h.requests.some(r=>r.path==='/integrations/assistant-engine/api/live/end'));
});
test('Cancel during microphone permission prevents a late stream from staying open',async()=>{
 let release;const h=client({getUserMedia:()=>new Promise(r=>{release=r;})});
 await h.loaded;
 const start=h.node('#start').handlers.click();await new Promise(r=>setImmediate(r));
 h.node('#end').handlers.click();release(h.stream);await start;
 assert.equal(h.track.stopped,true);assert.equal(h.peers.length,0);
 assert.equal(h.requests.some(r=>r.path==='/integrations/assistant-engine/api/live/session'),false);
});

test('Signed-out live page offers login without requesting a microphone, then enables voice',async()=>{
 let microphones=0;const h=client({authenticated:false,getUserMedia:async()=>{microphones++;return h.stream;}});
 await h.loaded;
 assert.equal(h.node('#login').hidden,false);assert.equal(h.node('#start').disabled,true);
 assert.equal(microphones,0);
 h.node('#username').value=' Owner ';h.node('#password').value='test-password';
 await h.node('#loginForm').handlers.submit({preventDefault(){}});
 assert.deepEqual(h.requests.find(r=>r.path==='/integrations/assistant-engine/api/auth/login').body,{username:'Owner',password:'test-password'});
 assert.equal(h.node('#password').value,'');assert.equal(h.node('#login').hidden,true);
 assert.equal(h.node('#start').disabled,false);assert.equal(microphones,0);
});

test('Incorrect password displays the server error and allows another attempt',async()=>{
 const h=client({authenticated:false,respond:path=>path==='/integrations/assistant-engine/api/auth/login'?{ok:false,status:401,json:async()=>({message:'Incorrect username or password.'})}:null});
 await h.loaded;await h.node('#loginForm').handlers.submit({preventDefault(){}});
 assert.equal(h.node('#loginError').textContent,'Incorrect username or password.');
 assert.equal(h.node('#loginError').hidden,false);assert.equal(h.node('#signIn').disabled,false);
 assert.equal(h.node('#start').disabled,true);assert.equal(h.peers.length,0);
});

test('Expired sign-in returns to login before opening the microphone',async()=>{
 let microphones=0;const h=client({getUserMedia:async()=>{microphones++;return h.stream;},respond:path=>path==='/integrations/assistant-engine/api/live/status'?{ok:false,status:401,json:async()=>({})}:null});
 await h.loaded;await h.node('#start').handlers.click();
 assert.equal(h.node('#login').hidden,false);assert.equal(h.node('#start').disabled,true);assert.equal(microphones,0);
});

test('A stalled microphone prompt times out and a late stream is stopped',async()=>{
 let release;const h=client({getUserMedia:()=>new Promise(r=>{release=r;})});
 await h.loaded;const attempt=h.node('#start').handlers.click();await new Promise(r=>setImmediate(r));
 assert.match(h.node('#status').textContent,/Allow microphone/);
 const deadline=[...h.timers.values()].find(t=>t.ms===45000);assert.ok(deadline);deadline.fn();
 assert.match(h.node('#status').textContent,/timed out/);assert.equal(h.node('#start').disabled,false);
 release(h.stream);await attempt;
 assert.equal(h.track.stopped,true);assert.equal(h.peers.length,0);
});

 test('Leaving native voice controls closes the microphone, peer, and billed session',async()=>{
 const h=client({panel:true});await h.loaded;await h.node('#start').handlers.click();h.dispose();
 assert.equal(h.track.stopped,true);assert.equal(h.peers[0].closed,true);
 assert.equal(h.sent.at(-1).type,'session.close');
 assert.equal(h.requests.filter(r=>r.path.endsWith('/live/end')).length,1);
 h.dispose();assert.equal(h.requests.filter(r=>r.path.endsWith('/live/end')).length,1);
 });
 test('Leaving native controls while microphone permission is pending stops a late stream',async()=>{
 let release;const h=client({panel:true,getUserMedia:()=>new Promise(r=>{release=r;})});await h.loaded;
 const attempt=h.node('#start').handlers.click();await new Promise(r=>setImmediate(r));h.dispose();release(h.stream);await attempt;
 assert.equal(h.track.stopped,true);assert.equal(h.peers.length,0);
 });
