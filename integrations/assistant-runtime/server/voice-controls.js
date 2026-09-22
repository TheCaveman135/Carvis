import {enabled} from './features.js';
/** Owner controls affect capture only; they do not restart the assistant or its routines. */
export class VoiceControls {
 constructor({microphone,getConfig,saveConfig,listDevices,transcriber,voice}){Object.assign(this,{microphone,getConfig,saveConfig,listDevices,transcriber,voice});}
 sync({restart=false}={}){
  const c=this.getConfig(),v=c.voice || {},uid=enabled(c,'voice')&&v.enabled&&c.stt?.enabled&&!v.inputMuted&&v.inputDevice?.startsWith('local:')?v.inputDevice.slice(6):'';
  if(!uid)this.microphone.stop();
  else if(restart||this.microphone.desired!==uid)void this.microphone.start(uid);
 }
 state(){
  const c=this.getConfig(),v=c.voice || {},stt=this.transcriber.state();
  return {...this.microphone.state(),inputDevice:v.inputDevice || '',muted:v.inputMuted===true,voiceEnabled:enabled(c,'voice')&&v.enabled===true,transcriptionEnabled:c.stt?.enabled===true,transcriptionReady:stt.ready,transcriptionError:stt.error || '',lastTranscriptionMs:stt.lastMs,lastVoiceError:this.voice.state().lastError || '',spokenRepliesEnabled:enabled(c,'speech')&&c.speech?.autoReplies===true};
 }
 async update(patch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Choose a microphone or mute setting.');
  for(const key of Object.keys(patch))if(!['muted','inputDevice','restart'].includes(key))throw Error('Unsupported voice control.');
  if(patch.muted!==undefined&&typeof patch.muted!=='boolean')throw Error('Mute must be on or off.');
  if(patch.restart!==undefined&&typeof patch.restart!=='boolean')throw Error('Restart must be on or off.');
  const current=this.getConfig(),v={...current.voice};
  if(patch.inputDevice!==undefined){
   const id=patch.inputDevice;
   if(typeof id!=='string')throw Error('Choose a valid microphone.');
   if(id==='even-glasses'){if(!enabled(current,'even-realities'))throw Error('Enable Even Realities glasses first.');}
   else if(id && (!id.startsWith('local:')||!(await this.listDevices()).some(d=>d.input&&d.uid===id.slice(6))))throw Error('That microphone is not available.');
   v.inputDevice=id;
  }
  if(patch.muted!==undefined)v.inputMuted=patch.muted;
  if(!v.inputMuted&&!v.inputDevice)throw Error('Choose a microphone before unmuting.');
  this.saveConfig({...current,voice:v});this.sync({restart:patch.restart===true});
  return this.state();
 }
}
