import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ContinuityMemory,ContinuityPatterns} from '../integrations/assistant-runtime/server/continuity-memory.js';
test('Continuity imports owner memory once, preserves history, and never resurrects deletion',t=>{
 const directory=mkdtempSync(join(tmpdir(),'continuity-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const legacy={all:()=>[{id:'old',text:'The printer lives in the garage.',source:'owner',kind:'fact',ts:Date.UTC(2025,1,1)}]};
 let memory=new ContinuityMemory({directory,legacy});const imported=memory.all()[0];assert.equal(imported.source,'owner');
 assert.equal(memory.forget(imported.id,{by:'carvis'}).ok,false);
 memory.remember({text:'The printer lives in the studio.',source:'owner',kind:'fact'});
 assert(memory.state().historical>0);assert.match(memory.promptSections('Where is the printer?').facts,/studio/);
 assert(memory.forget(imported.id,{by:'owner'}).ok);memory.close();
 memory=new ContinuityMemory({directory,legacy});assert(!memory.all().some(m=>m.text.includes('garage')));memory.close();
});
test('Continuity patterns preserve successful-owner-action and entity access filtering',t=>{
 const directory=mkdtempSync(join(tmpdir(),'continuity-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const memory=new ContinuityMemory({directory,legacy:{all:()=>[]}});t.after(()=>memory.close());
 const config={entities:{controlled:['light.desk'],guards:{}},agent:{}};
 const patterns=new ContinuityPatterns({memory,getConfig:()=>config,ha:{states:new Map([['light.desk',{entity_id:'light.desk',attributes:{}}]])},feed:{},worldState:{}});
 const calls=[{ok:true,name:'ha.light.set',arguments:{entity_id:'light.desk',state:'on'}}];
 patterns.observe({trigger:{type:'background'},calls});assert.equal(memory.dmr.listPatterns().length,0);
 for(let i=0;i<4;i++)memory.dmr.observeAction({action:{tool:'ha.light.set',target:'light.desk',verb:'on',arguments:{state:'on'}},timestamp:Date.UTC(2026,8,1+i,18)});
 assert.equal(patterns.list().length,1);assert.equal(memory.promptSections('desk').trace.patterns.length,1);config.entities.controlled=[];assert.equal(patterns.list().length,0);assert.equal(memory.promptSections('desk').trace.patterns.length,0);
});
