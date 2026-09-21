import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
const turns=new AsyncLocalStorage();
export function voiceReply(entry){
 const turn=turns.getStore();
 if(turn && (['reply','error','action'].includes(entry.kind)||entry.source==='confirmation'))process.send?.({type:'voice_history',...turn,role:'assistant',text:entry.text});
}
export async function voiceTurn(text,source,run){
 const turn={turnId:randomUUID(),source};
 return turns.run(turn,async()=>{
  process.send?.({type:'voice_history',...turn,role:'user',text:String(text || '')});
  try{const result=await run();process.send?.({type:'voice_history',...turn,role:'status',text:result?.reason || result?.outcome || 'Processed'});return result;}
  catch(error){process.send?.({type:'voice_history',...turn,role:'status',text:`Failed: ${error.message}`});throw error;}
 });
}
