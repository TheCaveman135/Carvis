import {randomUUID} from 'node:crypto';

/** Parent-owned integrations remain the sole authority for their own tools. */
export class IntegrationBridge {
  constructor({gateway,send,onConfirmation=()=>{},timeoutMs=120000}) {
    this.gateway=gateway;this.send=send;this.onConfirmation=onConfirmation;this.timeoutMs=timeoutMs;
    this.names=new Set();this.pending=new Map();this.context='';this.externalConfirmation=null;
  }
  replace({tools=[],context=''}={}) {
    for(const name of this.names)this.gateway.tools.delete(name);
    this.names.clear();this.clearConfirmation();
    this.context=String(context).slice(0,50000);
    for(const tool of tools.slice(0,150)) {
      if(!tool || typeof tool.name!=='string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(tool.name))continue;
      const name=`integration.${tool.name}`;
      if(this.names.has(name))continue;
      this.names.add(name);
      this.gateway.register({name,description:String(tool.description || '').slice(0,4000),schema:tool.schema || {type:'object',properties:{},additionalProperties:false},risk:tool.readOnly===true?0:1,
        execute:(args,context)=>this.invoke(tool.name,args,context)});
    }
    return {tools:[...this.names]};
  }
  invoke(name,args,context={}) {
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Integration response timed out. Check its trace before retrying.'));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer,context});
      try{this.send({type:'integration_call',id,name,args,context});}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  receive(message) {
    if(message?.type!=='integration_result')return false;
    const pending=this.pending.get(message.id);if(!pending)return true;
    this.pending.delete(message.id);clearTimeout(pending.timer);
    if(message.error){pending.reject(Error(String(message.error)));return true;}
    const result=message.result;
    if(result?.requiresConfirmation && result.confirmation?.id) {
      const confirmation=result.confirmation;
      this.externalConfirmation={...confirmation,prompt:confirmation.prompt || confirmation.summary || 'Confirm this integration action?',source:['glasses','device','physical'].includes(pending.context.source) || pending.context.triggerType==='user_voice'?'device':'owner'};
      this.onConfirmation(this.externalConfirmation);
    }
    pending.resolve(result);return true;
  }
  confirmation() {
    if(this.externalConfirmation?.expiresAt && this.externalConfirmation.expiresAt<=Date.now())this.clearConfirmation();
    return this.externalConfirmation;
  }
  clearConfirmation(id) {
    if(!id || this.externalConfirmation?.id===id)this.externalConfirmation=null;
    return {ok:true};
  }
  close() {
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('Assistant worker stopped.'));}
    this.pending.clear();this.clearConfirmation();
  }
}
