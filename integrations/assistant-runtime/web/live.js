const start=document.querySelector('#start'),end=document.querySelector('#end'),status=document.querySelector('#status'),audio=document.querySelector('#audio'),caption=document.querySelector('#transcript');
const login=document.querySelector('#login'),loginError=document.querySelector('#loginError'),signIn=document.querySelector('#signIn');
let authenticated=false;
function showLogin(){
  authenticated=false;login.hidden=false;start.disabled=true;
  status.textContent='Sign in above, then start your conversation.';
}
async function checkAccess(){
  const response=await fetch('/integrations/assistant-engine/api/auth/status',{cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Could not check sign-in. Reload this page to retry.');
  const auth=await response.json();
  if(!auth.configured){status.textContent='Open Back to Carvis to set up your account first.';start.disabled=true;return;}
  if(!auth.authenticated){showLogin();return;}
  authenticated=true;login.hidden=true;start.disabled=false;
  status.textContent='Ready. Uses this device’s microphone and speaker. Live voice is billed while connected.';
}
document.querySelector('#loginForm').addEventListener('submit',async event=>{
  event.preventDefault();signIn.disabled=true;loginError.hidden=true;
  try{
    await api('/integrations/assistant-engine/api/auth/login',{username:document.querySelector('#username').value.trim(),password:document.querySelector('#password').value});
    document.querySelector('#password').value='';
    await checkAccess();
    if(!authenticated)throw Error('Your browser did not keep the sign-in. Allow cookies for this Carvis address and try again.');
  }catch(error){loginError.textContent=error.message;loginError.hidden=false;}
  finally{signIn.disabled=false;}
});
let peer,channel,mic,sessionId,ready=false,closing=false,timer,startTimer,generation=0;
let input=[],delegations=new Map(),captions=[];
let pendingConfirmation=null,confirmationTimer;
const confirmation=document.querySelector('#confirmation'),accept=document.querySelector('#accept'),decline=document.querySelector('#decline');
function showConfirmation(value,delegationId){
  clearTimeout(confirmationTimer);pendingConfirmation=value?{...value,delegationId}:null;
  confirmation.hidden=!value;accept.disabled=false;decline.disabled=false;
  if(!value)return;
  document.querySelector('#confirmationText').textContent=value.prompt;
  confirmationTimer=setTimeout(()=>showConfirmation(null),Math.max(0,value.expiresAt-Date.now()));
}
async function confirm(accepted){
  if(!pendingConfirmation || closing)return;
  const pending=pendingConfirmation,current=generation;accept.disabled=true;decline.disabled=true;
  try{
    const result=await api('/integrations/assistant-engine/api/glasses/confirmation',{id:pending.id,accepted});
    if(current!==generation)return;
    showConfirmation(result.confirmation,pending.delegationId);
    send({type:result.quiet?'session.thinking.append':'session.commentary.append',delegation_id:pending.delegationId,content:String(result.reply || result.message || (accepted?'The action returned no spoken result. Do not assume success.':'The owner declined. No action was taken.')).slice(0,1000)});
  }catch(error){if(current===generation){showConfirmation(null);status.textContent=error.message;}}
}
accept.addEventListener('click',()=>confirm(true));decline.addEventListener('click',()=>confirm(false));
async function api(path,body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const result=await r.json();
  if(!r.ok){
    if(r.status===401 && path!=='/integrations/assistant-engine/api/auth/login'){cleanup();showLogin();}
    throw Error(result.message || 'Connection failed');
  }
  return result;
}
function send(event){if(channel?.readyState==='open')channel.send(JSON.stringify(event));}
function display(role,text){
  if(captions.at(-1)?.role===role)captions.at(-1).text+=text;else captions.push({role,text});
  captions=captions.slice(-12);caption.textContent=captions.map(m=>`${m.role}: ${m.text}`).join('\n\n');
}
function cleanup(){
  showConfirmation(null);
  generation++;clearTimeout(timer);clearTimeout(startTimer);mic?.getTracks().forEach(t=>t.stop());
  channel?.close();peer?.close();audio.srcObject=null;ready=false;
  const id=sessionId;sessionId=null;if(id)api('/integrations/assistant-engine/api/live/end',{sessionId:id}).catch(()=>{});
  peer=null;channel=null;mic=null;start.disabled=!authenticated;end.disabled=true;closing=false;
}
function stop(){
  if(closing)return;closing=true;clearTimeout(timer);end.disabled=true;mic?.getTracks().forEach(t=>{t.enabled=false;});
  if(!ready){cleanup();status.textContent='Conversation ended.';return;}
  send({type:'session.close'});status.textContent='Ending conversation…';
  timer=setTimeout(()=>{cleanup();status.textContent='Connection closed; final usage was not received.';},15000);
}
async function onEvent(event,current){
  if(current!==generation)return;
  if(event.type==='session.started'){
    clearTimeout(startTimer);ready=true;end.disabled=false;status.textContent='Listening. You can speak naturally.';
    timer=setTimeout(stop,19*60_000);
  }else if(event.type==='session.closed'){cleanup();status.textContent='Conversation ended.';}
  else if(event.type==='session.input_transcript.delta'){
    input.push({text:event.delta || '',end:event.end_ms});input=input.slice(-100);display('You',event.delta || '');
  }else if(event.type==='session.output_transcript.delta')display('Carvis',event.delta || '');
  else if(event.type==='error'){status.textContent=event.error?.message || 'Live voice reported an error';}
  else if(event.type==='session.delegation.created' && event.delegation?.target==='client'){
    const id=event.delegation.id;if(delegations.has(id))return;
    // Only complete transcript fragments through this delegation's timestamp.
    const usable=input.filter(p=>Number.isFinite(p.end) && p.end<=event.offset_ms);
    const text=usable.map(p=>p.text).join('').trim();
    const remaining=input.filter(p=>!usable.includes(p));
    delegations.set(id,true);input=remaining;
    if(!text){send({type:'session.commentary.append',delegation_id:id,content:'No complete request was captured. Ask the owner to repeat the request.'});return;}
    try{
      const result=await api('/integrations/assistant-engine/api/live/delegate',{sessionId,delegationId:id,text});
      if(current!==generation || closing)return;
      if(result.confirmation)showConfirmation(result.confirmation,id);
      send({type:result.silent?'session.thinking.append':'session.commentary.append',delegation_id:id,content:result.reply.slice(0,1000)});
    }catch(error){if(current===generation)send({type:'session.commentary.append',delegation_id:id,content:error.message.slice(0,500)});}
  }
}
start.addEventListener('click',async()=>{
  if(!authenticated){showLogin();return;}
  if(!window.isSecureContext || !navigator.mediaDevices){status.textContent='Microphone access requires HTTPS. Open Carvis using your private HTTPS address, then try again.';return;}
  start.disabled=true;end.disabled=false;status.textContent='Connecting…';input=[];captions=[];delegations=new Map();
  const current=++generation;
  startTimer=setTimeout(()=>{
    if(current!==generation)return;
    cleanup();status.textContent='Voice startup timed out. Check microphone permission, then try again.';
  },45000);
  try{
    const check=await fetch('/integrations/assistant-engine/api/live/status',{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(current!==generation)return;
    if(check.status===401){cleanup();showLogin();return;}
    if(!check.ok)throw Error('Carvis could not check voice availability. Try again.');
    const state=await check.json();if(!state.available)throw Error('Configure an OpenAI API key in Carvis first.');
    if(current!==generation)return;
    status.textContent='Allow microphone access in your browser to continue. You can cancel below.';
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    if(current!==generation){stream.getTracks().forEach(t=>t.stop());return;}
    mic=stream;
    status.textContent='Connecting voice…';
    const connection=new RTCPeerConnection();peer=connection;
    connection.addEventListener('track',e=>{audio.srcObject=new MediaStream([e.track]);audio.play().catch(()=>{status.textContent='Press play below to hear Carvis.';});});
    mic.getAudioTracks().forEach(track=>connection.addTrack(track,mic));
    channel=connection.createDataChannel('oai-events');
    channel.addEventListener('message',e=>{try{void onEvent(JSON.parse(e.data),current);}catch{status.textContent='An unreadable voice event arrived.';}});
    channel.addEventListener('close',()=>{if(current===generation){cleanup();status.textContent='Voice disconnected.';}});
    connection.addEventListener('connectionstatechange',()=>{if(current===generation && connection.connectionState==='failed'){cleanup();status.textContent='Connection lost. Start again to reconnect.';}});
    await connection.setLocalDescription(await connection.createOffer());
    if(connection.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{connection.removeEventListener('icegatheringstatechange',changed);reject(Error('Microphone connection timed out'));},10000);
      function changed(){if(connection.iceGatheringState==='complete'){clearTimeout(timeout);connection.removeEventListener('icegatheringstatechange',changed);resolve();}}
      connection.addEventListener('icegatheringstatechange',changed);changed();
    });
    if(current!==generation)return;
    const result=await api('/integrations/assistant-engine/api/live/session',{sdp:connection.localDescription.sdp});
    if(current!==generation){await api('/integrations/assistant-engine/api/live/end',{sessionId:result.session.id});return;}
    sessionId=result.session.id;
    await connection.setRemoteDescription({type:'answer',sdp:result.transport.sdp});
  }catch(error){if(current===generation){cleanup();status.textContent=error.name==='NotAllowedError'?'Microphone access was denied. Allow it in your browser’s settings, then try again.':error.message;}}
});
end.addEventListener('click',stop);
window.addEventListener('pagehide',()=>{
  send({type:'session.close'});
  if(sessionId)fetch('/integrations/assistant-engine/api/live/end',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId}),keepalive:true}).catch(()=>{});
  cleanup();
});
checkAccess().catch(error=>{status.textContent=error.message;});
