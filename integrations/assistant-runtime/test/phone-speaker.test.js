import test from 'node:test';
import assert from 'node:assert/strict';
import {PhoneSpeaker} from '../server/phone-speaker.js';
import {VoiceOutput} from '../server/voice-output.js';

test('phone output requires a ready receiver and actual playback acknowledgement', async () => {
  const phone = new PhoneSpeaker();
  assert.equal((await phone.speak('test')).success,false);
  await phone.poll('phone_test1',true,false);
  const speech = phone.speak('Full reply');
  const command = await phone.poll('phone_test1',true,false);
  assert.equal(command.text,'Full reply');
  assert.equal(phone.acknowledge('other_phone',command.id,true),false);
  assert.equal(phone.acknowledge('phone_test1','wrong',true),false);
  assert.equal(phone.acknowledge('phone_test1',command.id,true),true);
  assert.deepEqual(await speech,{success:true,target:'iphone',streamFinished:true});
  assert.equal(phone.state().pending,false);
});
test('a stale heartbeat cannot redirect an in-flight reply to a second phone', async () => {
  let now=1;
  const phone=new PhoneSpeaker({now:()=>now});
  await phone.poll('phone_test1',true,false);
  const speech=phone.speak('For the original phone');
  now+=40_000;
  assert.equal(await phone.poll('phone_test2',true,false),null);
  const command=await phone.poll('phone_test1',true,false);
  phone.acknowledge('phone_test1',command.id,false);
  assert.equal((await speech).success,false);
});
test('disabling a phone resolves pending speech as failed rather than silently accepted', async () => {
  const phone=new PhoneSpeaker();
  await phone.poll('phone_test1',true,false);
  const speech=phone.speak('test');
  await phone.poll('phone_test1',false,false);
  assert.equal((await speech).success,false);
});
test('phone-only route does not call Home Assistant or physical speakers', async () => {
  const spoken=[];
  const output=new VoiceOutput({getConfig:()=>({speech:{autoReplies:true,outputMode:'phone_only'}}),ha:{callService:()=>assert.fail('HA must not play')},physicalCarvis:{enqueueSpeak:()=>assert.fail('core must not play')},phoneSpeaker:{speak:async text=>{spoken.push(text);return {success:true,target:'iphone',streamFinished:true};}},sleep:()=>assert.fail('no extra estimate after playback')});
  assert.equal((await output.speakReply({kind:'reply',text:'Hello from Carvis.'})).success,true);
  assert.deepEqual(spoken,['Hello from Carvis.']);
});
