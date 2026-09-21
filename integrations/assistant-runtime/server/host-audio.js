import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,access,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);let building;
const playbackProcesses=new Set();
export function stopLocalPlayback(){for(const child of playbackProcesses)child.kill('SIGTERM');playbackProcesses.clear();}
export async function audioHelper(){
 if(process.platform!=='darwin')throw Error('Local audio devices currently require macOS. Glasses and HA speakers still work.');
 return building ||= (async()=>{
   const source=fileURLToPath(new URL('../native/audio.swift',import.meta.url));
   const plist=fileURLToPath(new URL('../native/Info.plist',import.meta.url));
   const hash=createHash('sha256').update(await readFile(source)).update(await readFile(plist)).digest('hex').slice(0,16);
   const directory=join(homedir(),'.cache','carvis','audio');await mkdir(directory,{recursive:true,mode:0o700});
   const binary=join(directory,`audio-${hash}`);
   try{await access(binary);return binary;}catch{}
   const temporary=`${binary}-${process.pid}`;
   await exec('/usr/bin/swiftc',[source,'-o',temporary,'-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',plist],{timeout:120000,maxBuffer:100000});
   await rename(temporary,binary);return binary;
 })().catch(error=>{building=null;throw Error(`Local audio setup failed: ${error.code==='ENOENT'?'install Apple Command Line Tools':error.message.slice(0,180)}`);});
}
export async function listHostAudio(){const binary=await audioHelper();const {stdout}=await exec(binary,['list'],{timeout:10000,maxBuffer:100000});return JSON.parse(stdout);}
export class PcmSentences {
 constructor(){this.reset();}
 reset(){this.chunks=[];this.pre=[];this.preBytes=0;this.bytes=0;this.quiet=0;this.voiced=0;this.speaking=false;}
 push(chunk){
  let sum=0;for(let i=0;i+1<chunk.length;i+=2){const sample=chunk.readInt16LE(i);sum+=sample*sample;}
  const loud=Math.sqrt(sum/(chunk.length/2 || 1))>450,ms=chunk.length/32;
  if(!this.speaking){this.pre.push(chunk);this.preBytes+=chunk.length;while(this.preBytes>9600&&this.pre.length>1)this.preBytes-=this.pre.shift().length;if(!loud)return null;this.speaking=true;this.chunks=this.pre;this.bytes=this.preBytes;this.pre=[];this.preBytes=0;this.voiced=ms;return null;}
  this.chunks.push(chunk);this.bytes+=chunk.length;this.quiet=loud?0:this.quiet+ms;if(loud)this.voiced+=ms;
  if(this.quiet<800&&this.bytes<928000)return null;
  const result=this.voiced>=200?Buffer.concat(this.chunks):null;this.reset();return result;
 }
}
export class HostMicrophone {
 constructor({onAudio,list=listHostAudio,helper=audioHelper,spawnImpl=spawn}){this.onAudio=onAudio;this.list=list;this.helper=helper;this.spawn=spawnImpl;this.process=null;this.error='';this.generation=0;this.busy=false;this.speakingOutput=false;this.detector=new PcmSentences();this.active='';}
 async start(uid){
  this.stop();const generation=this.generation;this.error='';
  try{const binary=await this.helper();if(generation!==this.generation)return;
   if(!(await this.list()).some(d=>d.uid===uid&&d.input))throw Error('Selected microphone is disconnected.');if(generation!==this.generation)return;
   const child=this.spawn(binary,['capture',uid],{stdio:['ignore','pipe','pipe']});this.process=child;this.active=uid;let remainder=Buffer.alloc(0),stderr='';
   child.stderr.on('data',c=>{stderr=(stderr+c).slice(-1500);});
   child.stdout.on('data',chunk=>{if(generation!==this.generation)return;remainder=Buffer.concat([remainder,chunk]);while(remainder.length>=640){const frame=remainder.subarray(0,640);remainder=remainder.subarray(640);if(this.busy||this.speakingOutput){this.detector.reset();continue;}const audio=this.detector.push(frame);if(audio){this.busy=true;Promise.resolve(this.onAudio(audio)).catch(e=>{this.error=e.message;}).finally(()=>{this.busy=false;});}}});
   child.on('error',e=>{if(generation===this.generation)this.error=e.message;});
   child.on('exit',()=>{if(generation!==this.generation)return;this.process=null;this.active='';this.error=stderr.trim()||'Microphone stopped. Check its connection and unmute again.';});
  }catch(error){if(generation===this.generation)this.error=error.message;}
 }
 stop(){this.generation++;this.process?.kill('SIGTERM');this.process=null;this.active='';this.detector.reset();}
 state(){return {listening:Boolean(this.process),device:this.active,error:this.error};}
}
export async function speakLocal(text,uid,{onStart=()=>{},onEnd=()=>{}}={}){
 const device=(await listHostAudio()).find(d=>d.uid===uid&&d.output);if(!device)return {success:false,error:'Selected local speaker is unavailable'};
 onStart();try{await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/say',['-a',String(device.id)],{stdio:['pipe','ignore','pipe']});playbackProcesses.add(child);let error='';const timer=setTimeout(()=>{child.kill();reject(Error('Local speech timed out'));},120000);child.stderr.on('data',d=>{error=(error+d).slice(-1000);});child.on('error',reject);child.on('close',code=>{playbackProcesses.delete(child);clearTimeout(timer);code===0?resolve():reject(Error(error||'Local speech failed'));});child.stdin.on('error',()=>{});child.stdin.end(text);});return {success:true,target:'local_speaker',streamFinished:true};}catch(e){return {success:false,error:e.message};}finally{onEnd();}
}
