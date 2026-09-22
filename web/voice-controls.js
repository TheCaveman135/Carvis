/** Live microphone controls shared with the voice conversation screen. */
export function mountVoiceControls({el,button,api}) {
 const endpoint='/integrations/assistant-engine/api/voice/microphone';
 const abort=new AbortController();let current=null,devices=[],pending=false,polling=false,loading=false,operationError='';
 const status=el('p',{role:'status'},'Checking microphone…'),error=el('p',{class:'notice error',hidden:true});
 const select=el('select',{'aria-label':'Voice microphone',disabled:true}),level=el('meter',{min:0,max:100,value:0,'aria-label':'Microphone input level'});
 const mute=button('Mute',()=>update({muted:!current.muted}),'primary');mute.disabled=true;
 const retry=button('Reconnect microphone',()=>update({restart:true}),'quiet compact');retry.disabled=true;
 const audioNotice=el('p',{class:'small muted'});
 const root=el('section',{class:'control-card voice-input-controls','aria-label':'Voice controls'},
  el('div',{class:'voice-input-toolbar'},el('label',{},el('span',{},'Microphone'),select),mute,retry,button('Refresh devices',()=>loadDevices(),'quiet compact'),el('a',{href:'#integrations/voice',class:'button quiet compact'},'Voice settings')),
  el('div',{class:'voice-input-level'},level,status),error,audioNotice);
 function notice(text=''){error.textContent=text;error.hidden=!text;}
 function options(){
  const input=current?.inputDevice || '',known=devices.some(d=>d.value===input);
  select.replaceChildren(el('option',{value:''},'Choose a microphone'),...devices.map(d=>el('option',{value:d.value},d.label)),...(input&&!known?[el('option',{value:input},'Selected microphone (unavailable)')]:[]));
  select.value=input;
 }
 function show(value){
  current=value;const name=devices.find(d=>d.value===value.inputDevice)?.label || 'selected microphone';
  mute.textContent=value.muted?'Unmute':'Mute';mute.setAttribute('aria-pressed',String(value.muted));
  mute.disabled=pending||!value.voiceEnabled||!value.inputDevice;
  select.disabled=pending||loading;retry.disabled=pending||value.muted||!value.inputDevice?.startsWith('local:');
  level.value=value.muted?0:value.level || 0;
  status.textContent=value.muted?'Microphone muted':!value.voiceEnabled?'Voice requests are switched off. Open Voice settings.':!value.transcriptionEnabled?'Transcription is switched off. Open Voice settings.':!value.transcriptionReady?'Speech recognition needs configuration. Open Voice settings.':!value.inputDevice?'Choose a microphone to start.':value.inputDevice==='even-glasses'?'Using Even glasses. The paired companion supplies audio.':value.error?value.error:value.processing?'Processing your request…':value.speaking?'Carvis is speaking…':value.listening?`Listening · ${name}`:value.reconnecting?`Reconnecting · ${name}`:`Waiting for audio · ${name}`;
  if(!pending)select.value=value.inputDevice || '';
  const fault=value.transcriptionError || value.lastVoiceError;notice(operationError || (value.muted?'':fault));
  audioNotice.replaceChildren(value.spokenRepliesEnabled?'Spoken replies are enabled.':el('span',{},'Replies appear below. To hear Carvis, ',el('a',{href:'#integrations/speech'},'enable Spoken replies and choose a speaker'),'.'));
 }
 async function poll(){
  if(abort.signal.aborted||polling||pending)return;polling=true;
  try{const value=await api(endpoint,{signal:abort.signal});if(!abort.signal.aborted&&!pending){if(value.inputDevice!==current?.inputDevice){current=value;options();}show(value);}}
  catch(e){if(!abort.signal.aborted){status.textContent='Voice is unavailable. Check Voice settings and Advanced assistant.';notice(e.message);mute.disabled=true;retry.disabled=true;}}
  finally{polling=false;}
 }
 async function loadDevices(){
  if(loading||abort.signal.aborted)return;loading=true;select.disabled=true;
  try{const value=await api('/api/integrations/voice/audio-devices',{signal:abort.signal});if(!abort.signal.aborted){devices=value.inputs || [];options();if(value.warning)notice(value.warning);}}
  catch(e){if(!abort.signal.aborted){operationError=e.message;notice(e.message);}}
  finally{loading=false;if(!abort.signal.aborted){select.disabled=pending;if(current)show(current);}}
 }
 async function update(patch){
  if(pending||abort.signal.aborted)return;pending=true;operationError='';mute.disabled=true;select.disabled=true;retry.disabled=true;notice();
  try{const value=await api(endpoint,{method:'POST',body:patch,signal:abort.signal});if(!abort.signal.aborted){current=value;options();}}
  catch(e){if(!abort.signal.aborted){operationError=e.message;notice(e.message);}}
  finally{pending=false;if(!abort.signal.aborted){if(current)show(current);void poll();}}
 }
 select.addEventListener('change',()=>update({inputDevice:select.value,...(!select.value?{muted:true}:{})}));
 void poll();void loadDevices();const timer=setInterval(()=>void poll(),1000);
 return {root,dispose(){abort.abort();clearInterval(timer);}};
}
