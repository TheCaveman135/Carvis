import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationStyle,CONVERSATION_STYLE} from '../server/personality.js';
import {Carvis} from '../server/carvis.js';
import {DEFAULTS} from '../defaults.js';

test('default TV personality keeps silent navigation and one short playback result',()=>{
 assert.equal(CONVERSATION_STYLE,conversationStyle());
 assert.match(CONVERSATION_STYLE,/Simple TV navigation stays silent on success/);
 assert.match(CONVERSATION_STYLE,/TV power and playback need one short result/);
});

test('main engine prompt honors both explicit TV reply preferences without conflicting defaults',()=>{
 const cfg=structuredClone(DEFAULTS);cfg.appleTv.silentNavigation=false;cfg.appleTv.shortReplies=false;
 const carvis=new Carvis({getConfig:()=>cfg,gateway:{},worldState:{ha:{states:new Map(),listEntities:()=>[]},summary:()=>''},atlas:{retrievalLines:()=>'',contextLines:()=>'',state:()=>({enabled:false})},feed:{}});
 const prompt=carvis.context();
 assert.match(prompt,/After successful TV navigation, give one brief acknowledgement/);
 assert.match(prompt,/For TV power and playback, use the normal conversational reply style/);
 assert.doesNotMatch(prompt,/Simple TV navigation stays silent|TV power and playback need one short result/);
 assert.match(prompt,/Always surface failures and required confirmations/);
});
