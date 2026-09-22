import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DMRStore} from '../../continuity-memory/src/dmr-store.js';
import {CarvisDmrAdapter} from '../../continuity-memory/src/carvis-adapter.js';
import {PatternLearner} from './patterns.js';
export class ContinuityMemory extends CarvisDmrAdapter {
 constructor({directory,legacy}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  super({dmr:new DMRStore({dbPath:path.join(directory,'continuity.db')}),mode:'dmr'});
  this.directory=directory;
  const marker=path.join(directory,'legacy-imported.json');
  if(!fs.existsSync(marker)){
   if(legacy.state?.().available===false)throw Error('Existing memories could not be read; migration was not completed.');
   for(const item of legacy.all()){
    if(this.dmr.getByLegacyId(item.id))continue;
    this.dmr.remember({text:item.text,kind:item.kind,source:item.source==='owner'?'owner':'carvis',pinned:item.pinned,legacyId:item.id,occurredAt:item.updated_at || item.ts,validFrom:item.ts});
   }
   fs.writeFileSync(marker,JSON.stringify({at:Date.now()}),{mode:0o600});
  }
  this.dmr.consolidate();
  this.timer=setInterval(()=>{try{this.dmr.consolidate();}catch(error){this.error=error.message;}},15*60*1000);this.timer.unref();
 }
 promptSections(probe=''){
  try{return this.dmr.assembleContext({query:probe,patternFilter:this.patternFilter});}
  catch(error){this.error=error.message;return {rules:'',preferences:'',facts:'',usedIds:[]};}
 }
 all(){return this.dmr.all({includeHistory:true});}
 close(){clearInterval(this.timer);this.dmr.close();}
 state(){const {dbPath,...state}=super.state();return {...state,name:'Continuity Memory'};}
}
/** Preserve the old guard filter; delegate retention and pattern analysis to Continuity. */
export class ContinuityPatterns extends PatternLearner {
 constructor(options){super(options);this.dmr=options.memory.dmr;options.memory.patternFilter=pattern=>this.allowed(pattern);}
 allowed(pattern){
  try{const action=JSON.parse(pattern.actionKey);return Boolean(this.action({ok:true,name:action.tool,arguments:{...action.arguments,entity_id:action.target}}));}
  catch{return false;}
 }
 observe({trigger,calls}){
  if(!['user_voice','user_text'].includes(trigger?.type))return;
  for(const call of calls || []){
   const action=this.action(call);if(!action)continue;
   this.dmr.observeAction({action:{tool:action.tool,target:action.entity,verb:action.data.action || action.data.state,arguments:action.data},source:'owner',outcome:true});
  }
 }
 list(){return this.dmr.listPatterns().filter(p=>p.state==='tentative' && this.allowed(p)).map(p=>({...p,status:p.state,description:p.narrative}));}
 context(){return ''; /* Continuity supplies relevant patterns in the recalled context. */}
 dismiss(id){const result=this.dmr.dismissPattern(id);return {...result,success:result.ok};}
 migrate(filename){
  const marker=path.join(this.getConfig().continuityDirectory || path.dirname(filename),'continuity-patterns-imported.json');
  if(fs.existsSync(marker))return;
  try{
   const saved=JSON.parse(fs.readFileSync(filename,'utf8'));
   for(const e of saved.events || []){
    if(!this.getConfig().entities.controlled.includes(e.entity))continue;
    const result=this.dmr.observeAction({action:{tool:e.tool,target:e.entity,verb:e.data?.action || e.data?.state,arguments:e.data || {}},timestamp:e.at,context:{bucket:e.bucket},source:'owner'});
    const legacyId='pattern_'+createHash('sha256').update(e.key+'|'+e.bucket).digest('hex').slice(0,12);
    if(saved.dismissed?.includes(legacyId)&&result.pattern)this.dmr.dismissPattern(result.pattern.id);
   }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  fs.writeFileSync(marker,'{}',{mode:0o600});
 }
}
