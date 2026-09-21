import test from 'node:test';import assert from 'node:assert/strict';
import {invokeWithTools} from '../server/providers/openai.js';
test('Responses tools preserve optional fields instead of demanding invented defaults',async t=>{
 let sent;t.mock.method(globalThis,'fetch',async(_url,opts)=>{sent=JSON.parse(opts.body);return new Response(JSON.stringify({output:[],usage:{}}));});
 await invokeWithTools({baseUrl:'https://example.test/v1',api:'responses'},{model:'test',messages:[],tools:[{name:'ha.entity.command',schema:{type:'object',properties:{entity_id:{type:'string'},brightness_pct:{type:'integer'}},required:['entity_id']}}]});
 assert.equal(sent.tools[0].strict,false);assert.deepEqual(sent.tools[0].parameters.required,['entity_id']);
});
