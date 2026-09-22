import {projectRuntimeConfig,runtimeEnvironment} from './assistant-config.js';
import {endpoint} from './validation.js';
export async function integrationModels(input,store,registry,fetcher=fetch){
 const module=registry.modules.get(input.integrationId);
 if(!module?.fields.some(f=>f.key===input.field && (f.key==='model'||f.key.endsWith('__model'))))throw Error('Unknown integration model field.');
 const cfg=projectRuntimeConfig(store),env=runtimeEnvironment(store);
 let url,headers={},kind='openai';
 if(input.field.startsWith('models__roles__')){
   const role=input.field.split('__')[2];
   const provider=cfg.models.providers.find(p=>p.id===(input.providerId || cfg.models.roles[role]?.provider));
   if(!provider)throw Error('Choose a model provider first.');
   kind=provider.kind;
   const base=provider.baseUrl || (provider.id==='openai'?'https://api.openai.com/v1':provider.id==='anthropic'?'https://api.anthropic.com/v1':'');
   if(!base)throw Error('Set this provider’s connection address first.');
   url=endpoint(base)+(kind==='ollama'?'/api/tags':'/models');
   const key=env[provider.apiKeyEnv] || '';
   if(kind==='anthropic')headers={'x-api-key':key,'anthropic-version':'2023-06-01'};
   else if(key)headers.Authorization=`Bearer ${key}`;
 }else if(input.field==='ollama__model'){
   const base=cfg.ollama.baseUrl || cfg.models.providers.find(p=>p.id==='ollama')?.baseUrl;
   if(!base)throw Error('Set your Ollama server address first.');
   kind='ollama';url=endpoint(base)+'/api/tags';
 }else if(input.field==='search__model'){
   kind='gemini';url='https://generativelanguage.googleapis.com/v1beta/models';headers={'x-goog-api-key':cfg.search.geminiKey || ''};
 }else if(input.field==='stt__model'){
   if(cfg.stt.engine==='assemblyai')return {models:['universal-3-5-pro'],note:'Models supported by Carvis’s AssemblyAI audio endpoint.'};
   kind='deepgram';url='https://api.deepgram.com/v1/models';headers={Authorization:`Token ${cfg.stt.deepgramKey || ''}`};
 }else throw Error('Model discovery is not configured for this field.');
 const models=[];const seen=new Set();
 for(let page=0;url&&page<20;page++){
   if(seen.has(url))break;seen.add(url);
   const response=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(12000)});
   if(!response.ok)throw Error(`Could not list models (${response.status}). Check the saved provider connection and API key.`);
   const data=await response.json();
   const rows=kind==='gemini'?data.models:kind==='deepgram'?data.stt:kind==='ollama'?data.models:data.data;
   if(!Array.isArray(rows))throw Error('This service did not return a model list.');
   models.push(...rows.filter(m=>kind!=='deepgram'||m.batch!==false).filter(m=>kind!=='gemini'||m.supportedGenerationMethods?.includes('generateContent')).map(m=>kind==='gemini'?m.name?.replace(/^models\//,''):kind==='deepgram'?m.canonical_name||m.name:kind==='ollama'?m.name:m.id));
   const next=new URL(url);
   if(kind==='gemini'&&data.nextPageToken){next.searchParams.set('pageToken',data.nextPageToken);url=next.href;}
   else if(kind==='anthropic'&&data.has_more&&data.last_id){next.searchParams.set('after_id',data.last_id);url=next.href;}
   else url=null;
 }
 return {models:[...new Set(models.filter(id=>typeof id==='string'&&id.length&&id.length<=120))].sort()};
}
