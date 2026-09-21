import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {PatternLearner} from '../server/patterns.js';
function setup(file=null){let now=new Date(2026,8,1,19).getTime();const feed=[];const cfg={entities:{controlled:['media_player.spotify','light.desk','lock.door']},classifier:{enabled:true,proactivity:2}};const learner=new PatternLearner({path:file,getConfig:()=>cfg,now:()=>now,ha:{states:new Map(cfg.entities.controlled.map(id=>[id,{state:'on',attributes:{}}])),friendlyName:id=>id},feed:{push:(...args)=>{feed.push(args);return {};}}});return {learner,feed,cfg,day:n=>{now=new Date(2026,8,n,19).getTime();},advance:n=>now+=n};}
const call={name:'ha.media.control',arguments:{entity_id:'media_player.spotify',action:'play'},ok:true};
const observe=(l,c=call,type='user_voice')=>l.observe({trigger:{type},calls:[c]});
test('three separate days qualify; retries do not, and suggestion only happens once',()=>{
 const {learner:l,day,feed}=setup();observe(l);observe(l);assert.equal(l.events.length,1);day(2);observe(l);assert.equal(l.list().length,0);day(3);observe(l);assert.equal(l.list()[0].days,3);l.suggest();assert.equal(feed.length,1);day(4);l.suggest();assert.equal(feed.length,1);assert.equal(l.dismiss(l.list()[0].id).success,true);assert.equal(l.list().length,0);
});
test('conflicting commands reduce support instead of becoming two confident habits',()=>{
 const {learner:l,day}=setup();for(let i=1;i<=3;i++){day(i);observe(l);observe(l,{...call,arguments:{...call.arguments,action:'pause'}});}assert.equal(l.list().length,0);
});
test('failed, dry-run, automatic, protected, and unselected actions are excluded',()=>{
 const {learner:l}=setup();observe(l,{...call,ok:false});observe(l,{...call,dryRun:true});observe(l,call,'home_event');observe(l,{...call,arguments:{...call.arguments,entity_id:'media_player.hidden'}});observe(l,{name:'ha.entity.command',arguments:{entity_id:'lock.door',service:'unlock'},ok:true});assert.equal(l.events.length,0);
});
test('evidence and dismissals persist; removed devices and old evidence disappear',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'carvis-patterns-'));try{const file=path.join(dir,'patterns.json');const a=setup(file);for(let i=1;i<=3;i++){a.day(i);observe(a.learner);}const b=setup(file);b.day(3);assert.equal(b.learner.list().length,1);b.cfg.entities.controlled=[];assert.equal(b.learner.list().length,0);a.advance(61*86400000);assert.equal(a.learner.list().length,0);assert.equal(fs.statSync(file).mode&0o777,0o600);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('different light colors conflict and newly protected devices stop contributing',()=>{
 const {learner:l,day,cfg}=setup();const light=rgb=>({name:'ha.light.set',arguments:{target:'light.desk',state:'on',rgb_color:rgb},ok:true});
 for(let i=1;i<=3;i++){day(i);observe(l,light([255,0,0]));observe(l,light([0,0,255]));}
 assert.equal(l.list().length,0);
 const other=setup();for(let i=1;i<=3;i++){other.day(i);observe(other.learner);}
 assert.equal(other.learner.list().length,1);other.cfg.entities.guards={'media_player.spotify':'protected'};assert.equal(other.learner.list().length,0);
});
