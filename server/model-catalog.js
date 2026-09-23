import {endpoint,text} from './validation.js';
export async function discoverModels(input,saved,fetcher=fetch,sharedKeys={}){
 const provider=input.provider || saved.provider;
 if(!['openai','compatible','ollama'].includes(provider))throw Error('Choose a supported provider.');
 const baseUrl=endpoint(provider==='openai'?'https://api.openai.com/v1':input.baseUrl || saved.baseUrl);
 const same=provider===saved.provider && baseUrl===endpoint(saved.baseUrl);
 const enteredKey=text(input.apiKey ?? '',1000);
 const apiKey=input.clearApiKey?'':enteredKey || (provider==='openai'?sharedKeys.openai:'') || (same?saved.apiKey:'') || '';
 if(provider==='openai'&&!apiKey)throw Error('Enter your OpenAI API key first, then load models.');
 const response=await fetcher(baseUrl+'/models',{headers:apiKey?{Authorization:`Bearer ${apiKey}`}:{},redirect:'error',signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error(response.status===401||response.status===403?'The provider rejected the key or model-list access. Check your API key.':`Could not load models (${response.status}). You can still enter a custom model ID.`);
 const data=await response.json();if(!Array.isArray(data.data))throw Error('This provider does not return a model list. Enter a custom model ID.');
 return {models:[...new Set(data.data.map(m=>m?.id).filter(id=>typeof id==='string'&&id.length>0&&id.length<=120))].sort()};
}
