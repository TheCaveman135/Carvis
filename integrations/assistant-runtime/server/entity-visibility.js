// Final model-input boundary: includes recalled conversation and tool results.
export function visibleModelInput(value,cfg,ha) {
  const toolNames=new Set((value?.tools || []).map(t=>t.name).filter(Boolean));
  const allowed=new Set([...(cfg.entities?.observed || []),...(cfg.entities?.controlled || [])]);
  const entities=ha?.listEntities?.() || [];
  const knownIds=new Set(entities.map(e=>e.entity_id));
  const selectedNames=new Set(entities.filter(e=>allowed.has(e.entity_id)).map(e=>e.name?.toLowerCase()));
  const hiddenNames=[...new Set(entities.filter(e=>!allowed.has(e.entity_id) && e.name && !selectedNames.has(e.name.toLowerCase())).map(e=>e.name))].sort((a,b)=>b.length-a.length);
  const namesPattern=hiddenNames.filter(name=>name.length>=4).map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const namesRegex=namesPattern?new RegExp(`(?<![\\p{L}\\p{N}.])(?:${namesPattern})(?![\\p{L}\\p{N}.])`,'giu'):null;
  const scrub=(text,names=true)=>{
    let result=text.replace(/\b[a-z_]+(?:\.[a-z0-9_]+)+\b/g,id=>{
      if(toolNames.has(id))return id;
      const domain=id.split('.')[0];
      return (knownIds.has(id) || ['remote','media_player','camera','light','switch','sensor','binary_sensor','lock','climate','cover','automation','script','scene','button','number','select','input_boolean'].includes(domain)) && !allowed.has(id)?'[unavailable]':id;
    });
    if(names && namesRegex)result=result.replace(namesRegex,'[unavailable]');
    return result;
  };
  const structural=new Set(['name','type','role','enum','required','tool_choice']);
  const walk=(v,key='')=>typeof v==='string'?scrub(v,!structural.has(key)):Array.isArray(v)?v.map(x=>walk(x,key)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='name' && (v.schema || v.parameters || v.type==='function' || Object.hasOwn(v,'arguments'))?x:walk(x,k)])):v;
  return walk(value);
}
