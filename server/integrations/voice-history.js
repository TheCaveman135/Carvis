/** Persist voice-only turns separately from typed conversations. */
export function recordVoiceEvent(store,event){
 if(!['user','assistant','status'].includes(event.role)||!event.turnId)return;
 const text=String(event.text || '').trim().slice(0,16000);if(!text)return;
 let conversation=store.data.conversations.find(c=>c.channel==='voice'&&c.messages.some(m=>m.turnId===event.turnId));
 if(!conversation){
  if(event.role!=='user')return;
  conversation=store.data.conversations.find(c=>c.channel==='voice'&&c.source===event.source&&Date.now()-c.updatedAt<10*60*1000);
  if(!conversation){conversation=store.createConversation();conversation.channel='voice';conversation.source=String(event.source || 'microphone');}
 }
 if(event.role==='status'){
  const message=conversation.messages.find(m=>m.turnId===event.turnId&&m.role==='user');
  if(message)message.voiceStatus=text;store.saveData();return;
 }
 store.append(conversation.id,event.role,text,{turnId:event.turnId,source:conversation.source});
}
