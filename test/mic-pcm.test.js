import test from 'node:test';
import assert from 'node:assert/strict';
import {encodePcm} from '../integrations/assistant-runtime/web/mic-pcm.js';
test('browser microphone converts samples to little-endian 16 kHz PCM',()=>{
 const buffer=encodePcm([new Float32Array([-1,0,1])],16000);const v=new DataView(buffer);
 assert.equal(v.getInt16(0,true),-32768);assert.equal(v.getInt16(2,true),0);assert.equal(v.getInt16(4,true),32767);
 assert.equal(encodePcm([new Float32Array(48000)],48000).byteLength,32000);
});
