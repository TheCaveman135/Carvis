import {encodePcm} from './mic-pcm.js';
export function mountMic(root,{el,field,signal}) {
  const devices=el('select',{'aria-label':'Microphone'},el('option',{value:''},'System default microphone'));
  const status=el('p',{role:'status',class:'small muted'},'Choose a microphone, then record a request. Stop & send sends it to Carvis.');
  const start=el('button',{type:'button',class:'button primary'},'Record request');
  const stop=el('button',{type:'button',class:'button',disabled:true},'Stop & send');
  const cancel=el('button',{type:'button',class:'button quiet',disabled:true},'Cancel');
  const transcript=el('p',{'aria-live':'polite'});
  root.append(field('Microphone',devices),el('div',{class:'action-row'},start,stop,cancel),status,transcript);
  let stream,context,node,source,timer,chunks=[],disposed=false,starting=false,recording=false,submitting=false,epoch=0;
  const controller=new AbortController();
  const enumerate=async()=>{
    const selected=devices.value;
    const microphones=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
    if(disposed)return;
    devices.replaceChildren(el('option',{value:''},'System default microphone'),...microphones.filter(d=>d.deviceId&&d.deviceId!=='default').map((d,i)=>el('option',{value:d.deviceId},d.label || `Microphone ${i+1}`)));
    devices.value=[...devices.options].some(o=>o.value===selected)?selected:'';
  };
  const release=()=>{
    clearTimeout(timer);recording=false;
    if(node){node.port.onmessage=null;node.disconnect();node=null;}
    source?.disconnect();source=null;
    stream?.getTracks().forEach(t=>t.stop());stream=null;
    if(context){void context.close().catch(()=>{});context=null;}
    devices.disabled=false;stop.disabled=true;cancel.disabled=true;start.disabled=submitting||starting;
  };
  const abortRecording=()=>{epoch++;release();chunks=[];status.textContent='Recording cancelled. Nothing sent.';};
  const send=async()=>{
    if(!recording || submitting)return;
    const rate=context.sampleRate;const audio=encodePcm(chunks,rate);chunks=[];
    submitting=true;release();status.textContent='Transcribing and asking Carvis…';
    try {
      if(audio.byteLength<12800)throw Error('That was too short. Record at least a short sentence.');
      const response=await fetch('/integrations/assistant-engine/api/voice/audio?source=browser',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:audio,signal:controller.signal});
      const result=await response.json();if(!response.ok||result.ok===false)throw Error(result.message || result.error || 'Could not process this recording.');
      if(disposed)return;
      transcript.textContent=result.text?`You said: ${result.text}`:'';
      status.textContent=result.outcome==='ignored'?`Not acted on: ${result.reason || 'no request detected'}`:'Request sent through Carvis. Replies use your configured speech output.';
    }catch(error){if(!disposed)status.textContent=error.message;}
    finally{submitting=false;if(!disposed)start.disabled=false;}
  };
  start.addEventListener('click',async()=>{
    if(starting||recording||submitting)return;
    starting=true;start.disabled=true;const requestEpoch=++epoch;
    try {
      const capture=await navigator.mediaDevices.getUserMedia({audio:{deviceId:devices.value?{exact:devices.value}:undefined,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(disposed||requestEpoch!==epoch){capture.getTracks().forEach(t=>t.stop());return;}
      stream=capture;await enumerate();
      if(disposed||requestEpoch!==epoch){release();return;}
      context=new AudioContext();await context.audioWorklet.addModule(new URL('./mic-worklet.js',import.meta.url));
      if(disposed||requestEpoch!==epoch){release();return;}
      await context.resume();chunks=[];node=new AudioWorkletNode(context,'carvis-mic');
      node.port.onmessage=event=>{if(recording)chunks.push(event.data);};
      source=context.createMediaStreamSource(stream);source.connect(node);node.connect(context.destination);
      recording=true;devices.disabled=true;stop.disabled=false;cancel.disabled=false;
      status.textContent='Recording… Stop & send when finished. Maximum 30 seconds.';
      timer=setTimeout(()=>void send(),30000);
      stream.getAudioTracks()[0].addEventListener('ended',()=>{if(recording){abortRecording();status.textContent='Microphone disconnected. Choose a microphone and try again.';}},{once:true});
    }catch(error){release();status.textContent=error.name==='NotAllowedError'?'Microphone permission was denied. Allow microphone access in your browser and try again.':error.message;}
    finally{starting=false;if(!disposed)start.disabled=recording||submitting;}
  });
  stop.addEventListener('click',()=>void send());cancel.addEventListener('click',abortRecording);
  const dispose=()=>{disposed=true;epoch++;release();controller.abort();navigator.mediaDevices?.removeEventListener('devicechange',refreshDevices);};
  const refreshDevices=()=>void enumerate().catch(()=>{});
  if(!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode){start.disabled=true;status.textContent='Browser microphone capture needs HTTPS or localhost and a browser with audio recording support.';}
  else{refreshDevices();navigator.mediaDevices.addEventListener('devicechange',refreshDevices);}
  signal.addEventListener('abort',dispose,{once:true});
  return dispose;
}
