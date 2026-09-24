import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {Vision,prepareVisionImage,IMAGE_LIMIT} from '../server/vision.js';
import {buildTools} from '../server/tools/index.js';

const frame=await sharp({create:{width:40,height:30,channels:3,background:'#879aaa'}}).jpeg().toBuffer();
function fixture(t,{visibility='found',failed=false}={}){
  process.env.CARVIS_VISION_TEST_KEY='test-only';
  const entities=[{entity_id:'camera.bedroom',domain:'camera',name:'Bedroom view',area:'Bedroom'},{entity_id:'camera.lab',domain:'camera',name:'Lab view',area:'workspace'},{entity_id:'camera.private',domain:'camera',name:'Unselected',area:'Other'}];
  const cfg={entities:{observed:['camera.bedroom','camera.lab'],controlled:[]},models:{providers:[{id:'test',kind:'openai',baseUrl:'https://api.openai.com/v1',apiKeyEnv:'CARVIS_VISION_TEST_KEY'}],roles:{vision:{provider:'test',model:'gpt-5.6-luna'}},pricing:{'gpt-5.6-luna':{input:.2,output:1.2}}}};
  const reads=[],calls=[],records=[];let time=10000;
  const ha={states:new Map(entities.map(e=>[e.entity_id,{state:'idle'}])),listEntities:()=>entities,cameraImage:async id=>{reads.push(id);return {bytes:frame};}};
  const vision=new Vision({ha,getConfig:()=>cfg,now:()=>time,persist:r=>records.push(r),fetchImpl:async(url,options)=>{
    calls.push({url,options,body:JSON.parse(options.body)});
    return {ok:!failed,status:failed?503:200,json:async()=>({status:'completed',model:'gpt-5.6-luna',usage:{input_tokens:150,output_tokens:70},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({visibility,answer:'A cat is visible.',position:'On the couch, left side of frame.',evidence:'Pointed ears and curled tail.',uncertainty:''})}]}]})};
  }});
  t.after(()=>{vision.close();delete process.env.CARVIS_VISION_TEST_KEY;});
  return {vision,cfg,ha,reads,calls,records,advance:()=>{time+=16*60000;}};
}

test('Search checks every selected camera, labels room in code, and records cost without image data',async t=>{
  const h=fixture(t),result=await h.vision.inspect({question:'Where is my cat?'},{invocationId:'owner-turn'});
  assert.equal(result.checked_count,2);assert.deepEqual(h.reads,['camera.bedroom','camera.lab']);
  assert.deepEqual(result.observations.map(o=>o.room),['Bedroom','workspace']);
  assert.equal(result.observations[0].capture_time_verified,false);
  assert.equal(h.calls[0].body.model,'gpt-5.6-luna');assert.equal(h.calls[0].body.store,false);
  assert.equal(h.calls[0].body.tools,undefined);assert.match(h.calls[0].body.instructions,/untrusted/);
  assert.match(h.calls[0].body.input[0].content[1].image_url,/^data:image\/jpeg;base64,/);
  assert.equal(h.records.length,2);assert.ok(h.records[0].costUsd>0);
  assert.doesNotMatch(JSON.stringify(h.records),/data:image|Where is my cat|test-only/);
});

test('Unselected cameras and arbitrary URLs cannot cause reads or model calls',async t=>{
  const h=fixture(t);
  for(const id of ['camera.private','https://example.com/picture','file:///private'])await assert.rejects(()=>h.vision.inspect({question:'Look',camera_ids:[id]}),/not available/);
  assert.equal(h.reads.length,0);assert.equal(h.calls.length,0);
});

test('Revoking a camera during retrieval or analysis stops the observation from being returned',async t=>{
  const duringRead=fixture(t);
  duringRead.ha.cameraImage=async id=>{
    duringRead.reads.push(id);
    duringRead.cfg.entities.observed=[];
    return {bytes:frame};
  };
  const unread=await duringRead.vision.inspect({question:'What is visible?',camera_ids:['camera.bedroom']});
  assert.equal(unread.success,false);
  assert.equal(unread.observations[0].status,'unavailable');
  assert.match(unread.observations[0].error,/no longer selected/);
  assert.equal(duringRead.calls.length,0);

  const duringModel=fixture(t),modelFetch=duringModel.vision.fetch;
  duringModel.vision.fetch=async(...args)=>{
    const response=await modelFetch(...args);
    duringModel.cfg.entities.observed=[];
    return response;
  };
  const revoked=await duringModel.vision.inspect({question:'What is visible?',camera_ids:['camera.bedroom']});
  assert.equal(duringModel.calls.length,1);
  assert.equal(revoked.success,false);
  assert.equal(revoked.observations[0].status,'unavailable');
  assert.equal(revoked.observations[0].answer,undefined);
});

test('Unavailable camera is explicitly reported without erasing a good sighting',async t=>{
  const h=fixture(t);h.ha.states.set('camera.lab',{state:'unavailable'});
  const r=await h.vision.inspect({question:'Find cat'});
  assert.equal(r.success,true);assert.equal(r.requested_count,2);assert.equal(r.checked_count,1);assert.equal(r.unavailable_count,1);
  assert.equal(r.observations[1].status,'unavailable');assert.equal(h.calls.length,1);
});

test('Ambiguous candidates never gain a definite position',async t=>{
  const h=fixture(t,{visibility:'uncertain'});const r=await h.vision.inspect({question:'Find cat'});
  assert.equal(r.observations[0].visibility,'uncertain');assert.equal(r.observations[0].position,'');
});

test('Provider failure is not reported as a negative sighting',async t=>{
  const h=fixture(t,{failed:true});const r=await h.vision.inspect({question:'Find cat'});
  assert.equal(r.success,false);assert.equal(r.checked_count,0);assert.equal(r.unavailable_count,2);
  assert.equal(r.observations[0].visibility,undefined);assert.equal(h.records[0].outcome,'error');
});

test('Uploaded image inspection uses temporary IDs, no camera read, no invented room, expires',async t=>{
  const h=fixture(t),image=await h.vision.upload(frame);
  const r=await h.vision.inspect({question:'What is this?',image_ids:[image.id]});
  assert.equal(h.reads.length,0);assert.equal(r.checked_count,1);assert.equal(r.observations[0].room,null);
  assert.equal(r.observations[0].source,'image');
  h.advance();await assert.rejects(()=>h.vision.inspect({question:'What is this?',image_ids:[image.id]}),/expired/);
  assert.equal(h.vision.images.size,0);
});

test('Decoder bounds input, rejects SVG/corrupt files, strips metadata and resizes',async()=>{
  await assert.rejects(()=>prepareVisionImage(Buffer.from('<svg></svg>')),/JPEG/);
  await assert.rejects(()=>prepareVisionImage(Buffer.alloc(IMAGE_LIMIT+1)),/6 MB/);
  await assert.rejects(()=>prepareVisionImage(Buffer.from([255,216,255,1])),/could not be read/);
  const large=await sharp({create:{width:1800,height:900,channels:3,background:'white'}}).withMetadata().jpeg().toBuffer();
  const normalized=await prepareVisionImage(large),meta=await sharp(normalized).metadata();
  assert.equal(meta.width,1600);assert.equal(meta.height,800);assert.equal(meta.exif,undefined);
});

test('Background triggers cannot invoke the observer',async t=>{
  const h=fixture(t);const tool=buildTools({vision:h.vision,getConfig:()=>h.cfg}).find(t=>t.name==='vision.inspect');
  const result=await tool.execute({question:'Find cat'},{triggerType:'home_event'});
  assert.equal(result.success,false);assert.equal(h.calls.length,0);assert.equal(h.reads.length,0);
});

test('Malformed and incomplete model results fail without inventing a sighting',async t=>{
  const h=fixture(t);h.vision.fetch=async()=>({ok:true,json:async()=>({status:'incomplete',usage:{input_tokens:10},output:[]})});
  const r=await h.vision.inspect({question:'Find cat',camera_ids:['camera.bedroom']});
  assert.equal(r.success,false);assert.equal(r.observations[0].status,'unavailable');
  assert.equal(h.records[0].outcome,'error');
});

test('Focused general inspection receives bounded relevant memory and room context',async t=>{
  const h=fixture(t),queries=[],used=[];
  h.vision.getMemory=()=>({search:(query,limit,kinds)=>{queries.push({query,limit,kinds});return [{id:'fact-1',text:'The red table in the study is a workbench.'}];},markUsed:ids=>used.push(...ids)});
  const r=await h.vision.inspect({question:'What is beside the lamp?',objective:'Identify only the seat beside the lamp.',context:'The owner calls the red table a workbench.',camera_ids:['camera.bedroom']});
  const brief=JSON.parse(h.calls[0].body.input[0].content[0].text);
  assert.equal(brief.objective,r.objective);assert.equal(brief.source.room,'Bedroom');
  assert.match(brief.context,/workbench/);assert.match(brief.remembered_facts[0],/workbench/);
  assert.match(queries[0].query,/Bedroom/);assert.equal(queries[0].limit,4);assert.deepEqual(queries[0].kinds,['fact']);
  assert.deepEqual(used,['fact-1']);assert.equal(h.calls.length,1);
  assert.match(h.calls[0].body.instructions,/do not inventory unrelated/);
  assert.match(h.calls[0].body.instructions,/cannot prove a subject is present/);
});

test('Older callers get a question-based objective; invalid briefs fail before camera access',async t=>{
  const h=fixture(t);
  await assert.rejects(()=>h.vision.inspect({question:'Read display',objective:'a'.repeat(1001)}),/objective/);
  await assert.rejects(()=>h.vision.inspect({question:'Read display',context:{}}),/context/);
  assert.equal(h.reads.length,0);
  await h.vision.inspect({question:'Read only the printer error',camera_ids:['camera.lab']});
  const brief=JSON.parse(h.calls[0].body.input[0].content[0].text);
  assert.equal(brief.objective,'Read only the printer error');assert.deepEqual(brief.remembered_facts,[]);
});
