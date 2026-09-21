import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {requiresLiveOwner} from './guards.js';
const DAY=86400000;
const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
export class PatternLearner {
  constructor({getConfig,ha,worldState,feed,path=null,now=Date.now}) {
    Object.assign(this,{getConfig,ha,worldState,feed,path,now});this.events=[];this.dismissed=[];this.suggested=[];this.lastSuggestion=0;
    if(path)try{const saved=JSON.parse(fs.readFileSync(path,'utf8'));this.events=Array.isArray(saved.events)?saved.events.slice(-500):[];this.dismissed=Array.isArray(saved.dismissed)?saved.dismissed.slice(-200):[];this.suggested=Array.isArray(saved.suggested)?saved.suggested.slice(-200):[];this.lastSuggestion=Number(saved.lastSuggestion)||0;}catch{}
  }
  save(){if(!this.path)return;fs.writeFileSync(this.path+'.tmp',JSON.stringify({events:this.events,dismissed:this.dismissed,suggested:this.suggested,lastSuggestion:this.lastSuggestion}),{mode:0o600});fs.renameSync(this.path+'.tmp',this.path);}
  action(call) {
    if(!call.ok || call.dryRun)return null;
    const args=call.arguments || {};const id=args.entity_id || args.target;
    if(typeof id!=='string' || !this.getConfig().entities.controlled.includes(id))return null;
    const state=this.ha.states.get(id);if(!state || requiresLiveOwner(id,state,this.getConfig()))return null;
    let data;
    if(call.name==='ha.media.control' && ['play','pause','stop','select_source','play_media'].includes(args.action)){
      data={action:args.action};for(const key of ['source','media_content_id','media_content_type'])if(args[key]!==undefined)data[key]=args[key];
    }else if(call.name==='ha.light.set' && id.startsWith('light.') && ['on','off'].includes(args.state)){
      data={state:args.state};for (const key of ['brightness','rgb_color','color_temp_kelvin']) if(args[key]!==undefined)data[key]=args[key];
    }else return null;
    return {entity:id,tool:call.name,data};
  }
  observe({trigger,calls}) {
    if(!['user_voice','user_text'].includes(trigger?.type))return;
    const now=this.now();this.events=this.events.filter(e=>e.at<=now && now-e.at<60*DAY);
    const date=new Date(now);const day=`${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
    const bucket=Math.floor(date.getHours()/3);
    for(const call of calls){
      const action=this.action(call);if(!action)continue;
      const key=stable(action);
      if(this.events.some(e=>e.key===key && now-e.at<10*60000))continue;
      this.events.push({at:now,day,bucket,key,...action});
    }
    this.events=this.events.slice(-500);this.save();
  }
  list() {
    const cfg=this.getConfig();const allowed=new Set(cfg.entities.controlled);const now=this.now();
    const events=this.events.filter(e=>e.at<=now && now-e.at<60*DAY && allowed.has(e.entity) && this.ha.states.has(e.entity) && !requiresLiveOwner(e.entity,this.ha.states.get(e.entity),cfg));
    const groups=new Map();
    for(const event of events){const key=event.key+'|'+event.bucket;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(event);}
    const patterns=[];
    for(const [key,items] of groups){
      const e=items.at(-1);const days=[...new Set(items.map(x=>x.day))];
      const competing=events.filter(x=>x.entity===e.entity && x.tool===e.tool && x.bucket===e.bucket);
      const support=items.length/competing.length;
      if(days.length<3 || support<0.75)continue;
      const id='pattern_'+createHash('sha256').update(key).digest('hex').slice(0,12);
      if(this.dismissed.includes(id))continue;
      const name=this.ha.friendlyName(e.entity);
      const lightDetails=[e.data.brightness!==undefined ? `${e.data.brightness}% brightness` : '',e.data.rgb_color ? `RGB ${e.data.rgb_color.join(', ')}` : '',e.data.color_temp_kelvin ? `${e.data.color_temp_kelvin} K` : ''].filter(Boolean).join(', ');
      const action=({play:'resume music',pause:'pause music',stop:'stop music',select_source:'choose a playback device',play_media:`play a specific ${e.data.media_content_type || 'selection'}`})[e.data.action] || `lights ${e.data.state}${lightDetails ? ", " + lightDetails : ""}`;
      const window=`${String(e.bucket*3).padStart(2,'0')}:00–${String(e.bucket*3+3).padStart(2,'0')}:00`;
      patterns.push({id,status:'tentative',entity_id:e.entity,tool:e.tool,arguments:e.data,days:days.length,observations:items.length,support:Math.round(support*100),window,lastSeen:e.at,description:`${name}: ${action}${e.data.source?' on '+e.data.source:''}, between ${window}, on ${days.length} separate days.`});
    }
    return patterns.sort((a,b)=>b.lastSeen-a.lastSeen).slice(0,20);
  }
  suggest() {
    const cfg=this.getConfig();if(!cfg.classifier?.enabled || (cfg.classifier.proactivity ?? 2)<2 || this.now()-this.lastSuggestion<DAY)return;
    const pattern=this.list().find(p=>!this.suggested.includes(p.id));if(!pattern)return;
    const entry=this.feed.push('reply',`I've noticed a possible routine: ${pattern.description} You can ask me to turn that into a routine.`,{proactive:true,source:'patterns'});
    if(entry){this.suggested.push(pattern.id);this.suggested=this.suggested.slice(-200);this.lastSuggestion=this.now();this.save();}
  }
  dismiss(id){if(!this.list().some(p=>p.id===id))return {success:false,error:'Pattern not found'};this.dismissed.push(id);this.dismissed=this.dismissed.slice(-200);this.save();return {success:true};}
  context(){const items=this.list().slice(0,5);return items.length?'Tentative observed request patterns; not preferences or authorization. Offer a suggestion, never install or execute a routine from these alone. Ask for the exact desired schedule/actions before saving.\n'+items.map(p=>p.id+': '+p.description).join('\n'):'';}
}
