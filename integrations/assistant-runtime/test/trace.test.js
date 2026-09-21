import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTraceView, safeTraceValue } from '../server/trace.js';
import { Carvis, shouldDisplayFinalReply, toolFailureReply } from '../server/carvis.js';

test('owner trace includes its matching transcript but strips other private text and secrets', () => {
  const trace = buildTraceView({
    invocations: [
      {
        id: 'inv_1',
        ts: 1_700_000_000_000,
        trigger_type: 'user_text',
        trigger: {
          type: 'user_text',
          source: 'web',
          wake_word: false,
          transcript: 'Turn on the bedroom lights',
          reason: 'Turn on the secret bedroom mode',
          original_reason: 'Private original request',
        },
        role: 'carvis',
        provider: 'openai',
        model: 'gpt-test',
        prompt_version: 'v1',
        rounds: 1,
        input_tokens: 100,
        cached_tokens: 30,
        output_tokens: 20,
        cost_usd: 0.0123,
        ms: 850,
        outcome: 'ok',
      },
    ],
    steps: [
      {
        id: 'step_1',
        invocation_id: 'inv_1',
        step: 1,
        round: 1,
        ts: 1_700_000_000_050,
        kind: 'model',
        role: 'carvis',
        provider: 'openai',
        model: 'gpt-test',
        duration_ms: 420,
        tool_count: 1,
        outcome: 'tool_calls',
        detail: 'normal',
      },
    ],
    toolCalls: [
      {
        id: 'call_1',
        invocation_id: 'inv_1',
        ts: 1_700_000_000_500,
        round: 1,
        tool: 'ha.entity.command',
        arguments: {
          entity_id: 'light.bedroom',
          text: 'A full private command must not appear here',
          then: 'Run the private follow-up after the lock changes',
          command: 'run a private Mac shortcut',
          detail: 'hidden diagnostic detail',
          target: 'owner-defined target',
          title: 'Owner label',
          value: 'Owner value',
          token: 'super-secret-token',
        },
        risk: 1,
        authorization: 'allowed',
        result: { success: true, message: 'Completed', authorization: 'Bearer abcdefghijklmnop' },
        ok: true,
        ms: 33,
      },
    ],
  });

  const invocation = trace.invocations[0];
  assert.deepEqual(invocation.trigger, {
    type: 'user_text', source: 'web', wake_word: false, transcript: 'Turn on the bedroom lights',
  });
  assert.equal(invocation.modelRounds, 1);
  assert.equal(invocation.steps[0].toolCount, 1);
  assert.equal(invocation.toolCalls[0].arguments.entity_id, 'light.bedroom');
  assert.equal(invocation.toolCalls[0].arguments.text, '[private text omitted]');
  assert.equal(invocation.toolCalls[0].arguments.then, '[private text omitted]');
  assert.equal(invocation.toolCalls[0].arguments.command, '[private text omitted]');
  assert.equal(invocation.toolCalls[0].arguments.detail, '[private text omitted]');
  assert.equal(invocation.toolCalls[0].arguments.target, '[private text omitted]');
  assert.equal(invocation.toolCalls[0].arguments.title, '[private text omitted]');
  assert.equal(invocation.toolCalls[0].arguments.value, '[private text omitted]');
  assert.equal(invocation.toolCalls[0].arguments.token, '[redacted]');
  assert.equal(invocation.toolCalls[0].result.authorization, '[redacted]');

  const serialised = JSON.stringify(trace);
  assert.match(serialised, /Turn on the bedroom lights/);
  assert.doesNotMatch(serialised, /secret bedroom mode|Private original request|super-secret-token|full private command|private follow-up|private Mac shortcut|hidden diagnostic|owner-defined target|Owner label|Owner value/i);
});

test('trace redacts credentials embedded in plain error text', () => {
  const value = safeTraceValue('OpenAI HTTP 401: Bearer sk-abcdefghijklmnop?token=supersecret; {"password":"also-secret"}');
  assert.doesNotMatch(value, /abcdefghijklmnop|supersecret|also-secret/);
  assert.match(value, /\[redacted\]/);
});

test('durable SQLite round_number is exported as the model round', () => {
  const trace = buildTraceView({
    invocations: [{ id: 'inv_round', ts: 1, trigger_type: 'user_text', rounds: 2, outcome: 'ok' }],
    steps: [{
      id: 'step_round', invocation_id: 'inv_round', step: 1, round_number: 2, ts: 2,
      kind: 'model', role: 'carvis', outcome: 'reply', tool_count: 0,
    }],
  });
  assert.equal(trace.invocations[0].steps[0].round, 2);
});

test('Carvis status does not leak raw invocation text or tool arguments', () => {
  const carvis = new Carvis({
    getConfig: () => ({}), gateway: {}, worldState: {}, atlas: {}, feed: {}, mac: {}, hud: {}, sessions: {},
  });
  carvis.lastInvocation = {
    id: 'inv_safe',
    ts: 123,
    trigger: { transcript: 'private owner request' },
    rounds: 2,
    calls: [{ arguments: { token: 'private-token' } }],
    reply: 'private reply',
    model: 'gpt-test',
    costUsd: 0.1,
    ms: 300,
  };

  const state = carvis.state();
  assert.deepEqual(state.last, {
    id: 'inv_safe', ts: 123, rounds: 2, toolCalls: 1, model: 'gpt-test', costUsd: 0.1, ms: 300,
  });
  assert.doesNotMatch(JSON.stringify(state), /private owner request|private-token|private reply/);
});

test('acknowledgements never suppress the verified final answer', () => {
  const base = {
    reply: 'Done.', triggerType: 'user_text', showed: false, confirmationNeeded: false, acknowledged: true,
  };
  assert.equal(shouldDisplayFinalReply({ ...base, calls: [{ ok: true }] }), true);
  assert.equal(shouldDisplayFinalReply({ ...base, calls: [{ ok: false }] }), true);
  assert.equal(shouldDisplayFinalReply({ ...base, calls: [] }), true);
  assert.equal(shouldDisplayFinalReply({ ...base, acknowledged: false, calls: [{ ok: true }] }), true);
});

test('a failed tool has a truthful fallback when its model follow-up is absent', () => {
  assert.equal(
    toolFailureReply([{ name: 'ha.entity.command', ok: false, failure: 'Home Assistant is unavailable' }]),
    'I could not complete ha.entity.command: Home Assistant is unavailable.',
  );
});

test('trace counts reads, failures, queued commands and accepted speech without claiming completion', () => {
  const calls = [
    { tool: 'ha.get_state', risk: 0, ok: true, result: { state: 'off', age_seconds: 12 } },
    { tool: 'ha.light.set', risk: 1, ok: false, result: { success: false, error: 'HA 503 private device name' } },
    { tool: 'mac.command', risk: 2, ok: true, result: { status: 'pending' } },
    { tool: 'speech.say', risk: 1, ok: true, result: { success: true } },
    { tool: 'ha.light.set', risk: 1, ok: true, authorization: 'deduplicated' },
    { tool: 'ha.light.set', risk: 1, ok: true, result: { dry_run: true } },
  ].map((call, i) => ({ id: `call_${i}`, invocation_id: 'inv', ts: 1100 + i, ...call }));
  const row = buildTraceView({ invocations: [{ id: 'inv', ts: 1000, outcome: 'ok' }], toolCalls: calls }).invocations[0];
  assert.deepEqual(row.summary, { read: 1, succeeded: 0, failed: 1, queued: 1, accepted: 1, deduplicated: 1, dry_run: 1 });
  assert.equal(row.toolCalls[0].offsetMs, 100);
  assert.deepEqual(row.toolCalls[0].facts, [{ label: 'Returned state', value: 'off' }, { label: 'State age (seconds)', value: '12' }]);
  assert.match(row.toolCalls[1].diagnostic, /server error/);
  assert.doesNotMatch(JSON.stringify(row), /private device name/);
});

test('background trace exposes a bounded state transition and classifier score without private reasons', () => {
  const row = buildTraceView({ invocations: [{ id: 'inv', trigger_type: 'home_event', trigger: {
    type: 'home_event', importance: 0.8, reason: 'private narrative',
    event_data: { entity_id: 'binary_sensor.motion', from: 'on', to: 'off', name: 'private room label' },
  } }] }).invocations[0];
  assert.equal(row.trigger.transition, 'on → off');
  assert.equal(row.trigger.importance, 0.8);
  assert.doesNotMatch(JSON.stringify(row), /private narrative|private room label/);
});

test('new diagnostics and facts never echo credential-bearing errors or private tool text', () => {
  const row = buildTraceView({ invocations: [{ id: 'inv', error: 'timeout Bearer hidden-secret' }], toolCalls: [{
    invocation_id: 'inv', tool: 'speech.say', ok: false, authorization: 'denied_risk',
    error: 'do a private thing', arguments: { text: 'private spoken text', state: 'Bearer hidden-token', brightness: 50 },
  }] }).invocations[0];
  assert.match(row.diagnostic, /deadline/);
  assert.match(row.toolCalls[0].diagnostic, /risk policy/);
  assert.doesNotMatch(JSON.stringify(row), /hidden-secret|hidden-token|private spoken text|do a private thing/);
});

test('TV traces distinguish invalid lighting fields, playback acceptance, and verified power',()=>{
 const calls=[{tool:'ha.entity.command',arguments:{entity_id:'media_player.apple_tv',service:'turn_on',rgb_color:[0,0,0]},ok:false,result:{success:false,error:'Light settings require light.turn_on'}},{tool:'ha.media.control',arguments:{entity_id:'media_player.apple_tv',action:'play'},ok:true,result:{success:true,service:'media_play'}},{tool:'ha.media.power',arguments:{entity_id:'media_player.apple_tv',state:'on'},ok:true,result:{success:true,verified:true,actual_state:'paused'}}].map((c,i)=>({...c,id:String(i),invocation_id:'tv',risk:1}));
 const trace=buildTraceView({invocations:[{id:'tv'}],toolCalls:calls}).invocations[0].toolCalls;
 assert.match(trace[0].diagnostic,/No device command was sent/);assert.ok(trace[0].facts.some(f=>f.value==='rgb_color'));
 assert.equal(trace[1].outcome,'accepted');assert.ok(trace[1].facts.some(f=>/not power on/.test(f.value)));
 assert.equal(trace[2].outcome,'succeeded');assert.ok(trace[2].facts.some(f=>f.label==='Observed device state'&&f.value==='paused'));
});
