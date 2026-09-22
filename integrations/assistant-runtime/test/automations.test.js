import test from 'node:test';
import assert from 'node:assert/strict';

import { AutomationEngine } from '../server/automations.js';

const literal = (value) => ({ literal: value });
const ref = (value) => ({ ref: value });

function rule({
  id = 'rule_test',
  name = 'Test automation',
  enabled = true,
  when = { op: 'equals', left: literal(true), right: literal(true) },
  then = [{ type: 'tool.call', tool: 'safe.write', arguments: { value: 'done' } }],
  ...rest
} = {}) {
  return { version: 1, id, name, enabled, when, then, ...rest };
}

function changedTo(entityId, value) {
  return {
    op: 'changed_to',
    left: ref(`ha.${entityId}.state`),
    right: literal(value),
  };
}

function stateEquals(entityId, value) {
  return {
    op: 'equals',
    left: ref(`ha.${entityId}.state`),
    right: literal(value),
  };
}

function makeHarness({ now = 1_800_000_000_000, onWake, tools, gatewayCall, isHaReady, isAtlasReady, atlas, memory } = {}) {
  let clock = now;
  const store = makeStore(() => clock);
  const bus = makeBus(store, () => clock);
  const gateway = makeGateway({ tools, call: gatewayCall });
  const ha = makeHa();
  const feedEntries = [];
  const changes = [];
  const wakes = [];
  const wake = onWake || (async ({ trigger }) => {
    wakes.push(structuredClone(trigger));
    return { outcome: 'ok' };
  });

  const dependencies = {
    bus,
    gateway,
    ha,
    atlas: atlas || { status: 'ok', snapshot: { projects: [], tasks: [], fetchedAt: now } },
    memory: memory || { state: () => ({ total: 0, facts: 0, preferences: 0 }) },
    hud: {},
    feed: {
      push(type, text, meta) {
        const entry = { type, text, meta: structuredClone(meta || {}) };
        feedEntries.push(entry);
        return entry;
      },
    },
    getCarvisState: () => ({ busy: false, glassesConnected: true }),
    getVoiceState: () => ({ enabled: true }),
    // The harness is a fully owner-selected test home. Individual visibility
    // boundary tests provide a narrower inventory explicitly.
    getConfig: () => ({ entities: { observed: [...ha.states.keys()], controlled: [...ha.states.keys()] } }),
    isHaReady: isHaReady || (() => true),
    isAtlasReady: isAtlasReady || (() => true),
    onWake: async (input) => {
      if (onWake) wakes.push(structuredClone(input.trigger));
      return wake(input);
    },
    onChange: (event) => changes.push(structuredClone(event)),
    store,
    now: () => clock,
  };

  return {
    store,
    bus,
    gateway,
    ha,
    feedEntries,
    changes,
    wakes,
    engine: () => new AutomationEngine(dependencies),
    now: () => clock,
    setNow(value) { clock = value; },
    advance(milliseconds) { clock += milliseconds; return clock; },
    async changeHa(engine, entityId, to, attributes = {}) {
      const oldState = ha.states.get(entityId);
      const newState = {
        entity_id: entityId,
        state: to,
        attributes: { ...(oldState?.attributes || {}), ...attributes },
        last_changed: new Date(clock).toISOString(),
      };
      ha.states.set(entityId, newState);
      await engine.handleHaChange(entityId, newState, oldState);
      await drain(engine);
      return { oldState, newState };
    },
  };
}

async function drain(engine) {
  // Publishing a timer event can enqueue another evaluation while the current
  // promise is resolving. Follow the moving tail until it is genuinely idle.
  for (;;) {
    const tail = engine.queue;
    await tail;
    if (tail === engine.queue) return;
  }
}

test('Carvis must copy verified device states and event names before saving protocols', async (t) => {
  const h = makeHarness();
  h.ha.states.set('sensor.printer', { ...haState('sensor.printer', 'running', h.now()), attributes: { options: ['running', 'finish', 'idle'] } });
  const engine = h.engine();
  t.after(() => engine.stop());
  engine.start();
  const bad = rule({ when: changedTo('sensor.printer', 'finished'), metadata: { createdBy: 'owner' } });
  assert.throws(() => engine.save(bad, { createdBy: 'carvis' }), /Exact known values:.*finish/);
  assert.equal(engine.get(bad.id), null);
  const entity = engine.catalog().options.entities.find((item) => item.entity_id === 'sensor.printer');
  assert.ok(entity.known_states.includes('finish'));
  engine.save({ ...bad, when: changedTo('sensor.printer', 'finish') }, { createdBy: 'carvis' });
  await h.changeHa(engine, 'sensor.printer', 'finish');
  assert.equal(h.gateway.calls.length, 1);
  assert.throws(() => engine.save(rule({ id: 'bad_event', when: { op: 'changed_to', left: ref('event.type'), right: literal('timer.completed') } }), { createdBy: 'carvis' }), /timer.finished/);
  engine.save(rule({ id: 'good_event', when: { op: 'changed_to', left: ref('event.type'), right: literal('timer.finished') } }), { createdBy: 'carvis' });
});

test('state discovery includes historical values and permits numeric sensor thresholds', async (t) => {
  const h = makeHarness();
  h.ha.states.set('sensor.printer', haState('sensor.printer', 'finish', h.now()));
  const engine = h.engine();
  t.after(() => engine.stop());
  engine.start();
  engine.save(rule({ when: changedTo('sensor.printer', 'finish') }));
  await h.changeHa(engine, 'sensor.printer', 'running');
  assert.ok(engine.catalog().options.entities.find((item) => item.entity_id === 'sensor.printer').known_states.includes('finish'));
  engine.save(rule({ id: 'history_verified', when: changedTo('sensor.printer', 'finish') }), { createdBy: 'carvis' });
  h.ha.states.set('sensor.temperature', haState('sensor.temperature', '20', h.now()));
  engine.save(rule({ id: 'number', when: stateEquals('sensor.temperature', '25') }), { createdBy: 'carvis' });
});

test('save normalizes and persists valid programs while rejecting invalid tools', () => {
  const h = makeHarness();
  const engine = h.engine();
  const saved = engine.save(rule({ id: 'rule_save', name: 'Save contract' }));

  assert.equal(saved.id, 'rule_save');
  assert.equal(saved.name, 'Save contract');
  assert.equal(saved.enabled, true);
  assert.equal(saved.revision, 1);
  assert.match(saved.summary, /WHEN/);
  assert.equal(engine.get('rule_save').id, 'rule_save');
  assert.equal(engine.list().length, 1);
  assert.equal(h.changes.at(-1).type, 'automation.changed');

  assert.throws(
    () => engine.save(rule({
      id: 'rule_invalid',
      then: [{ type: 'tool.call', tool: 'not.a.real.tool', arguments: {} }],
    })),
    (error) => error.code === 'invalid_rule' && /No tool named/.test(error.message),
  );
  assert.equal(engine.get('rule_invalid'), null);
});

test('startup establishes a true-state baseline and never fires merely because state was restored', async (t) => {
  const h = makeHarness();
  h.ha.states.set('light.kitchen', haState('light.kitchen', 'on', h.now()));
  const author = h.engine();
  author.save(rule({
    id: 'rule_restart_baseline',
    when: stateEquals('light.kitchen', 'on'),
  }));

  // Simulate a persisted rule from before a clean evaluation was recorded.
  h.store._rules.get('rule_restart_baseline').last_match = null;
  h.gateway.calls.length = 0;

  const firstRestart = h.engine();
  t.after(() => firstRestart.stop());
  firstRestart.start();
  await drain(firstRestart);
  assert.equal(h.gateway.calls.length, 0);
  assert.equal(h.store.getRule('rule_restart_baseline').last_match, true);

  firstRestart.stop();
  const secondRestart = h.engine();
  t.after(() => secondRestart.stop());
  secondRestart.start();
  await drain(secondRestart);
  assert.equal(h.gateway.calls.length, 0);
  assert.equal(h.store._runs.length, 0);
});

test('changed_to reacts to one real HA transition exactly once', async () => {
  const h = makeHarness();
  h.ha.states.set('light.kitchen', haState('light.kitchen', 'off', h.now()));
  const engine = h.engine();
  engine.save(rule({ id: 'rule_changed_to', when: changedTo('light.kitchen', 'on') }));

  await h.changeHa(engine, 'light.kitchen', 'on');
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
  assert.equal(h.store._runs.length, 1);

  // A same-state callback and unrelated clock evaluations are not new edges.
  const current = h.ha.states.get('light.kitchen');
  assert.equal(engine.handleHaChange('light.kitchen', current, current), undefined);
  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  await drain(engine);
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
  assert.equal(h.store._runs.length, 1);
});

test('ordinary state conditions fire on the false-to-true edge, not every clock tick', async () => {
  const h = makeHarness();
  h.ha.states.set('light.kitchen', haState('light.kitchen', 'off', h.now()));
  const engine = h.engine();
  engine.save(rule({ id: 'rule_state_edge', when: stateEquals('light.kitchen', 'on') }));

  await h.changeHa(engine, 'light.kitchen', 'on');
  await engine.enqueue({ kind: 'clock', now: h.advance(5_000) });
  await engine.enqueue({ kind: 'clock', now: h.advance(5_000) });
  assert.equal(h.store._runs.length, 1);

  await h.changeHa(engine, 'light.kitchen', 'off');
  await h.changeHa(engine, 'light.kitchen', 'on');
  assert.equal(h.store._runs.length, 2);
});

test('WHILE iteration caps survive a process restart', async () => {
  const h = makeHarness();
  h.ha.states.set('light.kitchen', haState('light.kitchen', 'off', h.now()));
  const first = h.engine();
  first.save(rule({
    id: 'rule_while_restart_cap',
    when: stateEquals('light.kitchen', 'on'),
    while: stateEquals('light.kitchen', 'on'),
    metadata: { repeatEveryMs: 1_000, maxIterations: 1 },
  }));
  await first.baseline();
  await drain(first);
  await h.changeHa(first, 'light.kitchen', 'on');
  assert.equal(h.store._runs.length, 1);
  assert.equal(h.store.getRule('rule_while_restart_cap').while_iterations, 1);

  const restarted = h.engine();
  await restarted.enqueue({ kind: 'clock', now: h.advance(1_000) });
  await drain(restarted);
  assert.equal(h.store._runs.length, 1, 'the max cap is durable, not reset by restart');
});

test('mixed event/state WHEN trees run only for the boolean branch that actually activated', async () => {
  const h = makeHarness();
  h.ha.states.set('light.kitchen', haState('light.kitchen', 'off', h.now()));
  h.ha.states.set('binary_sensor.door', haState('binary_sensor.door', 'open', h.now()));
  const engine = h.engine();
  engine.save(rule({
    id: 'rule_branch_edge',
    when: {
      any: [
        { all: [changedTo('light.kitchen', 'on'), { op: 'equals', left: ref('time.hour'), right: literal(99) }] },
        stateEquals('binary_sensor.door', 'open'),
      ],
    },
  }));

  await h.changeHa(engine, 'light.kitchen', 'on');
  assert.equal(h.store._runs.length, 0, 'an unsatisfied edge branch cannot borrow truth from another OR branch');
  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  assert.equal(h.store._runs.length, 0, 'a stable true branch does not repeat on clocks');
});

test('classifier claims only an event that would actually start a rule run', async () => {
  const h = makeHarness();
  h.ha.states.set('light.kitchen', haState('light.kitchen', 'on', h.now()));
  const engine = h.engine();
  engine.save(rule({ id: 'rule_claim_exact', when: stateEquals('light.kitchen', 'on') }));
  assert.equal(engine.claimsEvent({ type: 'printer.test.completed', source: 'simulated', timestamp: h.now(), data: {} }), false);

  h.ha.states.set('light.kitchen', haState('light.kitchen', 'off', h.now()));
  const edgeEngine = h.engine();
  edgeEngine.save(rule({ id: 'rule_claim_edge', when: changedTo('light.kitchen', 'on') }));
  const event = {
    type: 'home.light.changed', source: 'home_assistant', timestamp: h.now(),
    data: { entity_id: 'light.kitchen', from: 'off', to: 'on' },
  };
  assert.equal(edgeEngine.claimsEvent(event), true);
});

test('unsupported temporal histories and event edges under NOT/WHILE fail at save time', () => {
  const h = makeHarness();
  const engine = h.engine();
  for (const [id, when, extra, pattern] of [
    ['time_edge', { op: 'changed_to', left: ref('time.hour'), right: literal(20) }, {}, /not supported/],
    ['timer_state_alias', { op: 'changed_to', left: ref('timer.tea.state'), right: literal('fired') }, {}, /not supported/],
    ['event_from', { op: 'changed_from', left: ref('event.type'), right: literal('timer.tea.finished') }, {}, /not meaningful for an event/],
    ['event_equals', { op: 'equals', left: ref('event.type'), right: literal('timer.finished') }, {}, /must use CHANGED TO/],
    ['history_cap', { op: 'within', left: ref('event.type'), right: literal('timer.tea.finished'), withinMs: 31 * 86_400_000 }, {}, /limited to 30 days/],
    ['not_edge', { not: changedTo('light.kitchen', 'on') }, {}, /cannot sit inside NOT/],
    ['edge_while', changedTo('light.kitchen', 'on'), { while: stateEquals('light.kitchen', 'on') }, /persistent WHEN/],
  ]) {
    assert.throws(() => engine.save(rule({ id: `rule_${id}`, when, ...extra })), pattern);
  }
});

test('a known timer exposes one stable finished event for a protocol', async (t) => {
  const h = makeHarness();
  const engine = h.engine();
  t.after(() => engine.stop());
  const timer = engine.startTimer({ name: 'Ten minute timer', durationMs: 1_000, payload: { notify: false } });
  engine.save(rule({
    id: 'rule_known_timer_finished',
    when: { op: 'changed_to', left: ref('event.type'), right: literal('timer.finished') },
    if: { op: 'equals', left: ref('event.data.timer_id'), right: literal(timer.id) },
  }));
  engine.start();
  await drain(engine);
  h.gateway.calls.length = 0;
  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  await drain(engine);
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
  assert.equal(h.bus.events.filter((event) => event.type === 'timer.finished').length, 1);
});

test('every unattended tool action crosses the gateway with auditable automation context', async () => {
  const h = makeHarness();
  const engine = h.engine();
  engine.save(rule({
    id: 'rule_gateway_context',
    name: 'Context proof',
    when: { op: 'equals', left: literal(false), right: literal(true) },
    then: [{ type: 'tool.call', tool: 'medium.write', arguments: { value: 42 } }],
  }));

  const result = await engine.runNow('rule_gateway_context');
  assert.equal(result.ok, true);
  const call = h.gateway.calls.find((entry) => entry.name === 'medium.write');
  assert.deepEqual(call.args, { value: 42 });
  assert.equal(call.ctx.triggerType, 'automation');
  assert.equal(call.ctx.reason, 'automation "Context proof"');
  assert.equal(call.ctx.ruleId, 'rule_gateway_context');
  assert.match(call.ctx.automationRunId, /^run_/);
  assert.match(call.ctx.idempotencyPrefix, new RegExp(`^${call.ctx.automationRunId}:0$`));
});

test('sensitive and indirect capabilities are rejected from persistent unattended rules and timers', async () => {
  const h = makeHarness({
    tools: {
      'memory.forget': { risk: 2 },
      'strict.write': {
        risk: 1,
        schema: {
          type: 'object', additionalProperties: false,
          properties: { value: { type: 'integer', minimum: 1 } }, required: ['value'],
        },
      },
    },
  });
  const engine = h.engine();
  for (const [id, tool, args, pattern] of [
    ['sensitive', 'secure.unlock', {}, /sensitive and cannot run unattended/],
    ['mac', 'mac.command', { command: 'open Safari' }, /not available inside a persistent rule/],
    ['automation', 'automation.update', {}, /not available inside a persistent rule/],
    ['indirect', 'ha.entity.command', { entity_id: 'script.open_everything', service: 'turn_on' }, /indirect and cannot run unattended/],
    ['wellbeing', 'ha.entity.command', { entity_id: 'switch.cpap_power', service: 'turn_off' }, /protected or indirect and cannot run unattended/],
    ['destructive_memory', 'memory.forget', { id: 'mem_1' }, /destructive and cannot run unattended/],
    ['bad_schema', 'strict.write', { value: 0 }, /invalid arguments.*at least 1/],
  ]) {
    assert.throws(
      () => engine.save(rule({ id: `rule_${id}`, then: [{ type: 'tool.call', tool, arguments: args }] })),
      pattern,
    );
  }

  assert.throws(
    () => engine.save(rule({
      id: 'rule_nested_sensitive',
      then: [{
        type: 'timer.start', timer: 'unsafe_later', durationMs: literal(60_000),
        payload: { actions: [{ type: 'tool.call', tool: 'secure.unlock', arguments: {} }] },
      }],
    })),
    /finish action 1.*sensitive and cannot run unattended/,
  );
  assert.throws(
    () => engine.save(rule({ id: 'rule_unknown_hud', then: [{ type: 'hud.teleport', payload: {} }] })),
    /No automatable HUD action/,
  );

  engine.startTimer({
    name: 'unsafe_payload',
    durationMs: 1_000,
    payload: {
      notify: false,
      actions: [{ type: 'tool.call', tool: 'secure.unlock', arguments: { entity_id: 'lock.front' } }],
    },
  });
  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  assert.equal(h.gateway.calls.some((call) => call.name === 'secure.unlock'), false);
  assert.equal(h.store.getTimer('unsafe_payload').status, 'fired');
  const event = h.bus.events.find((entry) => entry.type === 'timer.unsafe_payload.finished');
  assert.deepEqual(event.data.actions, [{ success: false }]);
});

test('updates require an exact revision and runtime metadata is range checked', () => {
  const h = makeHarness();
  const engine = h.engine();
  const first = engine.save(rule({ id: 'rule_revisioned' }));
  assert.equal(first.revision, 1);
  assert.throws(() => engine.save(rule({ id: first.id, name: 'Blind overwrite' })), /already exists.*revision 1/);
  const updated = engine.save(rule({ id: first.id, name: 'Intentional update' }), { expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.throws(
    () => engine.save(rule({ id: 'rule_bad_while', while: stateEquals('light.kitchen', 'on'), metadata: { maxIterations: 1001 } })),
    /maxIterations must be an integer from 1 to 1000/,
  );
});

test('persistent variables support direct operations and typed rule materialization', async () => {
  const h = makeHarness();
  const engine = h.engine();

  assert.equal(engine.setVariable('visits', 2).value, 2);
  assert.equal(engine.incrementVariable('visits', 3).value, 5);
  assert.equal(engine.resolve('variable.visits'), 5);

  engine.save(rule({
    id: 'rule_variable_write',
    // Event identity is an edge, not durable state. Expressing it as
    // changed_to also gives the runtime an explicit false baseline at save.
    when: { op: 'changed_to', left: ref('event.type'), right: literal('test.variable') },
    then: [{ type: 'variable.set', name: 'last_payload', value: ref('event.data.payload') }],
  }));
  await engine.enqueue({
    kind: 'event',
    now: h.now(),
    event: { id: 'evt_variable', type: 'test.variable', source: 'test', timestamp: h.now(), data: { payload: { answer: 42 } } },
  });
  assert.deepEqual(engine.variable('last_payload').value, { answer: 42 });
  assert.equal(engine.variable('last_payload').updated_by, 'rule:rule_variable_write');
  assert.equal(engine.unsetVariable('last_payload'), true);
  assert.equal(engine.variable('last_payload'), null);
  assert.equal(h.changes.filter((event) => event.type === 'variable.changed').length >= 4, true);
});

test('timers persist across engine instances and fire their actions, notification, and event once', async (t) => {
  const h = makeHarness();
  const creator = h.engine();
  const timer = creator.startTimer({
    name: 'pasta',
    durationMs: 5_000,
    payload: {
      message: 'Pasta is ready',
      actions: [{ type: 'tool.call', tool: 'safe.write', arguments: { meal: 'pasta' } }],
    },
  });
  assert.equal(timer.status, 'active');
  assert.equal(timer.remainingMs, 5_000);

  h.advance(6_000);
  const restored = h.engine();
  t.after(() => restored.stop());
  restored.start();
  await drain(restored);

  assert.equal(h.store.getTimer(timer.id).status, 'fired');
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
  assert.equal(h.gateway.calls.filter((call) => call.name === 'hud.show_notification').length, 1);
  // Default delivery goes through hud.show_notification. The production HUD
  // tool owns its corresponding feed entry; this recording gateway does not
  // pretend to execute another tool's side effects.
  assert.equal(h.feedEntries.length, 0);
  assert.equal(h.bus.events.filter((event) => event.type === 'timer.pasta.finished').length, 1);

  await restored.enqueue({ kind: 'clock', now: h.advance(5_000) });
  await drain(restored);
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
});

test('timer and alarm operations are type-strict', () => {
  const h = makeHarness();
  const engine = h.engine();
  const timer = engine.startTimer({ name: 'tea', durationMs: 60_000, kind: 'timer' });
  const alarm = engine.startTimer({ name: 'morning', durationMs: 120_000, kind: 'alarm' });

  assert.deepEqual(engine.listTimers({ kind: 'timer' }).map((item) => item.id), [timer.id]);
  assert.deepEqual(engine.listTimers({ kind: 'alarm' }).map((item) => item.id), [alarm.id]);
  assert.equal(engine.resolve('timer.tea.status'), 'active');
  assert.equal(engine.resolve('alarm.tea.status'), undefined);
  assert.equal(engine.resolve('alarm.morning.status'), 'active');
  assert.equal(engine.cancelTimerKind(timer.id, 'alarm'), 0);
  assert.equal(engine.cancelTimerKind(alarm.id, 'timer'), 0);
  assert.equal(engine.snoozeAlarm(timer.id, 30_000), null);

  h.advance(10_000);
  const paused = engine.pauseTimer(timer.id);
  assert.equal(paused.kind, 'timer');
  assert.equal(paused.status, 'paused');
  h.advance(20_000);
  const resumed = engine.resumeTimer(timer.id);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.remainingMs, 50_000);

  const snoozed = engine.snoozeAlarm(alarm.id, 30_000);
  assert.equal(snoozed.kind, 'alarm');
  assert.equal(snoozed.remainingMs, 30_000);
  assert.equal(engine.cancelTimerKind(timer.id, 'timer'), 1);
  assert.equal(engine.cancelTimerKind(alarm.id, 'alarm'), 1);
});

test('a paused timer exposes a frozen remaining_seconds value until it resumes', () => {
  const h = makeHarness();
  const engine = h.engine();
  const timer = engine.startTimer({ name: 'focus_break', durationMs: 90_000 });

  h.advance(15_000);
  const paused = engine.pauseTimer(timer.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.remainingMs, 75_000);
  assert.equal(engine.resolve('timer.focus_break.remaining_seconds'), 75);

  h.advance(60_000);
  assert.equal(engine.resolve('timer.focus_break.remaining_seconds'), 75);
  assert.equal(engine.getTimer(timer.id).remainingMs, 75_000);

  const resumed = engine.resumeTimer(timer.id);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.remainingMs, 75_000);
  h.advance(5_000);
  assert.equal(engine.resolve('timer.focus_break.remaining_seconds'), 70);
});

test('manual run skips gates but materializes every typed THEN value from one snapshot', async () => {
  const h = makeHarness();
  h.ha.states.set('light.kitchen', haState('light.kitchen', 'off', h.now()));
  const engine = h.engine();
  engine.setVariable('target_level', 37);
  engine.save(rule({
    id: 'rule_manual_materialization',
    when: stateEquals('light.kitchen', 'on'),
    then: [{
      type: 'tool.call',
      tool: 'safe.write',
      arguments: {
        level: ref('variable.target_level'),
        observed_state: ref('ha.light.kitchen.state'),
        nested: { at: ref('time.timestamp') },
      },
    }],
  }));

  const result = await engine.runNow('rule_manual_materialization');
  assert.equal(result.ok, true);
  assert.deepEqual(h.gateway.calls.at(-1).args, {
    level: 37,
    observed_state: 'off',
    nested: { at: h.now() },
  });
  assert.equal(result.run.trigger.kind, 'manual');
  assert.equal(result.run.trigger.forced, true);
  assert.equal(result.run.trigger.branch, 'then');
});

test('dry-run fixtures exercise changed edges and validate materialized tool arguments', () => {
  const h = makeHarness({
    tools: {
      'strict.dynamic': {
        risk: 1,
        schema: {
          type: 'object', additionalProperties: false,
          properties: { amount: { type: 'integer', minimum: 1 } }, required: ['amount'],
        },
      },
    },
  });
  const engine = h.engine();
  const definition = rule({
    id: 'rule_dry_fixture',
    when: changedTo('light.kitchen', 'on'),
    then: [{ type: 'tool.call', tool: 'strict.dynamic', arguments: { amount: ref('variable.amount') } }],
  });

  const withoutFixture = engine.test(definition, { values: { 'variable.amount': 2 } });
  assert.equal(withoutFixture.fixtureRequired, true);
  assert.equal(withoutFixture.when, false);

  const valid = engine.test(definition, {
    values: { 'variable.amount': 2 },
    change: { ref: 'ha.light.kitchen.state', from: 'off', to: 'on' },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.when, true);
  assert.deepEqual(valid.actions[0].arguments, { amount: 2 });

  const invalid = engine.test(definition, {
    values: { 'variable.amount': 0 },
    change: { ref: 'ha.light.kitchen.state', from: 'off', to: 'on' },
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.actionValidationErrors[0].message, /at least 1/);
  assert.equal(h.gateway.calls.length, 0, 'dry runs never execute a tool');
});

test('a busy Carvis wake is persisted, retried, and eventually delivered without duplicating the rule run', async () => {
  let attempts = 0;
  const h = makeHarness({
    onWake: async () => ({ outcome: ++attempts < 3 ? 'busy' : 'ok' }),
  });
  const engine = h.engine();
  engine.setVariable('wake_message', 'Check the workshop');
  engine.save(rule({
    id: 'rule_deferred_wake',
    when: { op: 'equals', left: literal(false), right: literal(true) },
    then: [{ type: 'carvis.wake', prompt: ref('variable.wake_message') }],
  }));

  const first = await engine.runNow('rule_deferred_wake');
  assert.equal(first.ok, true);
  assert.equal(first.actions[0].deferred, true);
  assert.equal(attempts, 1);
  assert.equal(h.store._runs.length, 1);
  assert.equal(engine.listTimers({ activeOnly: true }).length, 1);

  await engine.enqueue({ kind: 'clock', now: h.advance(2_000) });
  await drain(engine);
  assert.equal(attempts, 2);
  assert.equal(engine.listTimers({ activeOnly: true }).length, 1);

  await engine.enqueue({ kind: 'clock', now: h.advance(2_000) });
  await drain(engine);
  assert.equal(attempts, 3);
  assert.equal(engine.listTimers({ activeOnly: true }).length, 0);
  assert.equal(h.wakes.length, 3);
  assert.equal(h.wakes.every((wake) => wake.requested === 'Check the workshop'), true);
  assert.equal(h.store._runs.length, 1);
});

test('each occurrence of a repeating timer receives a distinct idempotency scope', async () => {
  const h = makeHarness();
  const engine = h.engine();
  engine.startTimer({
    name: 'pulse',
    durationMs: 1_000,
    repeatMs: 1_000,
    payload: {
      notify: false,
      actions: [{ type: 'tool.call', tool: 'safe.idempotent', arguments: { pulse: true } }],
    },
  });

  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  await drain(engine);
  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  await drain(engine);

  const calls = h.gateway.calls.filter((call) => call.name === 'safe.idempotent');
  assert.equal(calls.length, 2);
  assert.notEqual(
    calls[0].ctx.idempotencyPrefix,
    calls[1].ctx.idempotencyPrefix,
    'a recurring timer must not be deduplicated against its previous occurrence',
  );
});

test('variable changed_to is evaluated from the real queued variable transition exactly once', async (t) => {
  const h = makeHarness();
  const engine = h.engine();
  t.after(() => engine.stop());

  engine.setVariable('house_mode', 'idle', 'test');
  engine.save(rule({
    id: 'rule_variable_changed_to',
    when: {
      op: 'changed_to',
      left: ref('variable.house_mode'),
      right: literal('armed'),
    },
  }));
  engine.start();
  await drain(engine);
  h.gateway.calls.length = 0;

  h.advance(1_000);
  engine.setVariable('house_mode', 'armed', 'test');
  await drain(engine);

  assert.deepEqual(h.store.recentValueChanges('variable.house_mode', 10), [{
    ref: 'variable.house_mode',
    from: 'idle',
    to: 'armed',
    ts: h.now(),
  }]);
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
  assert.equal(h.store.listRuns({ ruleId: 'rule_variable_changed_to' }).length, 1);

  // Assigning the already-current value is not a transition and must not
  // synthesize another changed_to edge.
  h.advance(1_000);
  engine.setVariable('house_mode', 'armed', 'test');
  await drain(engine);
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
  assert.equal(h.store.listRuns({ ruleId: 'rule_variable_changed_to' }).length, 1);
});

test('timer status changed_to is evaluated from the queued firing transition exactly once', async (t) => {
  const h = makeHarness();
  const engine = h.engine();
  t.after(() => engine.stop());
  engine.startTimer({
    name: 'green_tea',
    durationMs: 1_000,
    payload: { notify: false },
  });
  engine.save(rule({
    id: 'rule_timer_status_changed_to',
    when: {
      op: 'changed_to',
      left: ref('timer.green_tea.status'),
      right: literal('fired'),
    },
  }));
  engine.start();
  await drain(engine);
  h.gateway.calls.length = 0;

  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  await drain(engine);

  assert.deepEqual(h.store.recentValueChanges('timer.green_tea.status', 10), [{
    ref: 'timer.green_tea.status',
    from: 'active',
    to: 'fired',
    ts: h.now(),
  }]);
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
  assert.equal(h.store.listRuns({ ruleId: 'rule_timer_status_changed_to' }).length, 1);

  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  await drain(engine);
  assert.equal(h.gateway.calls.filter((call) => call.name === 'safe.write').length, 1);
  assert.equal(h.store.listRuns({ ruleId: 'rule_timer_status_changed_to' }).length, 1);
});

test('WITHIN reads a matching transition from the persisted history after a fresh engine starts', async (t) => {
  const h = makeHarness();
  const entityId = 'binary_sensor.workshop_door';
  h.ha.states.set(entityId, haState(entityId, 'off', h.now() - 3_600_000));
  const author = h.engine();
  const definition = rule({
    id: 'rule_within_restart',
    when: {
      op: 'within',
      left: ref(`ha.${entityId}.state`),
      right: literal('on'),
      withinMs: 5 * 60_000,
    },
  });
  author.save(definition);
  await h.changeHa(author, entityId, 'on');
  assert.deepEqual(h.store.recentValueChanges(`ha.${entityId}.state`, 10), [{
    ref: `ha.${entityId}.state`,
    from: 'off',
    to: 'on',
    ts: h.now(),
  }]);

  // Simulate HA itself restarting too: its restored last_changed is new and
  // therefore cannot prove when the real transition occurred.
  h.advance(2 * 60_000);
  h.ha.states.set(entityId, haState(entityId, 'on', h.now()));
  h.gateway.calls.length = 0;
  const restored = h.engine();
  t.after(() => restored.stop());
  restored.start();
  await drain(restored);

  const persisted = restored.test(definition);
  assert.equal(persisted.ok, true);
  assert.equal(persisted.when, true);
  assert.equal(h.gateway.calls.length, 0, 'restart baseline must not replay the prior matching edge');

  h.advance(4 * 60_000);
  assert.equal(restored.test(definition).when, false, 'the persisted occurrence still expires at the original window');
});

test('WITHIN with an expected value does not substitute HA last_changed for a missing matching occurrence', () => {
  const h = makeHarness();
  const entityId = 'binary_sensor.side_gate';
  // HA says only that the current off state changed recently. There is no
  // recorded transition to on, so an explicit expected-value query must be
  // false even though the entity itself has a fresh last_changed timestamp.
  h.ha.states.set(entityId, haState(entityId, 'off', h.now() - 30_000));
  const engine = h.engine();
  const explicit = rule({
    id: 'rule_within_missing_expected',
    when: {
      op: 'within',
      left: ref('ha.' + entityId + '.state'),
      right: literal('on'),
      withinMs: 60_000,
    },
  });

  assert.equal(engine.test(explicit).when, false);
});

test('HAS BEEN and FOR DURATION retain their held-since instant across a fresh engine and HA snapshot', async (t) => {
  const h = makeHarness();
  const entityId = 'binary_sensor.garage_side_door';
  h.ha.states.set(entityId, haState(entityId, 'off', h.now() - 3_600_000));
  const author = h.engine();
  const hasBeenRule = rule({
    id: 'rule_has_been_restart',
    when: {
      op: 'has_been',
      left: ref(`ha.${entityId}.state`),
      right: literal('on'),
      durationMs: 5 * 60_000,
    },
  });
  const forDurationRule = rule({
    id: 'rule_for_duration_restart',
    when: {
      op: 'for_duration',
      left: ref(`ha.${entityId}.state`),
      right: literal('on'),
      durationMs: 5 * 60_000,
    },
  });
  author.save(hasBeenRule);
  author.save(forDurationRule);
  await h.changeHa(author, entityId, 'on');
  assert.equal(h.store._valueHistory.length, 1, 'one physical transition is persisted once even when two rules track it');
  assert.equal(h.store._runs.length, 0, 'duration is not yet satisfied at the transition');

  h.advance(6 * 60_000);
  h.ha.states.set(entityId, haState(entityId, 'on', h.now()));
  const restored = h.engine();
  t.after(() => restored.stop());
  restored.start();
  await drain(restored);

  assert.equal(restored.test(hasBeenRule).when, true);
  assert.equal(restored.test(forDurationRule).when, true);
  assert.equal(h.gateway.calls.length, 0, 'startup reconciles matured duration state without replaying an action');

  await h.changeHa(restored, entityId, 'off');
  assert.equal(restored.test(hasBeenRule).when, false);
  assert.equal(restored.test(forDurationRule).when, false);
});

test('baseline after Home Assistant connects never fires a restored true ordinary state', async (t) => {
  const h = makeHarness();
  const entityId = 'light.restored_lamp';
  h.ha.states.set(entityId, haState(entityId, 'off', h.now()));
  const author = h.engine();
  author.save(rule({
    id: 'rule_ha_connect_baseline',
    when: stateEquals(entityId, 'on'),
  }));
  assert.equal(h.store.getRule('rule_ha_connect_baseline').last_match, false);

  // New process starts before HA has delivered its get_states snapshot.
  h.ha.states.clear();
  const restored = h.engine();
  t.after(() => restored.stop());
  restored.start();
  await drain(restored);
  h.gateway.calls.length = 0;

  // HA then connects already-on. This is current truth, not an off -> on edge.
  h.ha.states.set(entityId, haState(entityId, 'on', h.now()));
  await restored.baseline('home_assistant_connected');
  await drain(restored);
  assert.equal(h.gateway.calls.length, 0);
  assert.equal(h.store._runs.length, 0);
  assert.equal(h.store.getRule('rule_ha_connect_baseline').last_match, true);

  await restored.enqueue({ kind: 'clock', now: h.advance(1_000) });
  assert.equal(h.gateway.calls.length, 0, 'the next clock sees true -> true, not a synthetic activation');
});

test('HA and Atlas references fail closed while their source is unavailable', async () => {
  let haReady = false;
  let atlasReady = false;
  const h = makeHarness({
    isHaReady: () => haReady,
    isAtlasReady: () => atlasReady,
    atlas: { status: 'unreachable', snapshot: { projects: [], tasks: [], fetchedAt: 0 } },
  });
  h.ha.states.set('light.kitchen', haState('light.kitchen', 'on', h.now()));
  const engine = h.engine();
  engine.save(rule({ id: 'rule_stale_ha', when: stateEquals('light.kitchen', 'on') }));
  engine.save(rule({
    id: 'rule_unknown_atlas',
    when: { op: 'equals', left: ref('atlas.projects.count'), right: literal(0) },
  }));

  await engine.enqueue({ kind: 'clock', now: h.advance(1_000) });
  assert.equal(h.store._runs.length, 0);
  assert.match(engine.get('rule_stale_ha').lastError, /not connected/);
  assert.match(engine.get('rule_unknown_atlas').lastError, /current snapshot/);

  haReady = true;
  atlasReady = true;
  await engine.baseline('sources_ready');
  assert.equal(h.store._runs.length, 0, 'source recovery establishes a baseline, never a synthetic edge');
  assert.equal(engine.get('rule_stale_ha').lastError, null);
  assert.equal(engine.get('rule_unknown_atlas').lastError, null);
});

test('an overdue HA-dependent timer waits for connectivity before firing', async () => {
  let ready = false;
  const h = makeHarness({ isHaReady: () => ready });
  const engine = h.engine();
  const timer = engine.startTimer({
    name: 'Connected delivery', durationMs: 1_000,
    payload: { notify: false, actions: [{ type: 'tool.call', tool: 'ha.entity.command', arguments: { entity_id: 'light.kitchen', service: 'turn_on' } }] },
  });
  h.advance(2_000);
  await engine.enqueue({ kind: 'clock', now: h.now() });
  assert.equal(engine.getTimer(timer.id).status, 'active');
  assert.equal(h.gateway.calls.length, 0);

  ready = true;
  await engine.enqueue({ kind: 'clock', now: h.now() });
  assert.equal(engine.getTimer(timer.id).status, 'fired');
  assert.equal(h.gateway.calls.filter((call) => call.name === 'ha.entity.command').length, 1);
});

test('weather status aliases map a real HA transition into queued changed_to evaluation', async () => {
  const h = makeHarness();
  const entityId = 'weather.forecast_home';
  h.ha.states.set(entityId, haState(entityId, 'partlycloudy', h.now(), {
    temperature: 74,
    humidity: 48,
  }));
  // Keep another weather entity present to prove the default alias is the
  // first/default entity while the explicit reference remains unambiguous.
  h.ha.states.set('weather.patio', haState('weather.patio', 'sunny', h.now()));
  const engine = h.engine();
  engine.save(rule({
    id: 'rule_default_weather_changed_to',
    when: {
      op: 'changed_to',
      left: ref('weather.status'),
      right: literal('rainy'),
    },
  }));
  engine.save(rule({
    id: 'rule_named_weather_changed_to',
    when: {
      op: 'changed_to',
      left: ref('weather.forecast_home.status'),
      right: literal('rainy'),
    },
  }));

  await h.changeHa(engine, entityId, 'rainy');
  await drain(engine);

  assert.equal(engine.resolve('weather.status'), 'rainy');
  assert.equal(engine.resolve('weather.forecast_home.status'), 'rainy');
  assert.equal(h.store.listRuns({ ruleId: 'rule_default_weather_changed_to' }).length, 1);
  assert.equal(h.store.listRuns({ ruleId: 'rule_named_weather_changed_to' }).length, 1);
  assert.deepEqual(
    h.store.recentValueChanges('weather.status', 10).map(({ from, to }) => ({ from, to })),
    [{ from: 'partlycloudy', to: 'rainy' }],
  );
  assert.deepEqual(
    h.store.recentValueChanges('weather.forecast_home.status', 10).map(({ from, to }) => ({ from, to })),
    [{ from: 'partlycloudy', to: 'rainy' }],
  );
});

test('daily alarms preserve wall-clock time across both DST boundaries', async () => {
  for (const scenario of [
    {
      label: 'spring forward',
      first: '2026-03-07T14:00:00.000Z', // 08:00 CST
      next: '2026-03-08T13:00:00.000Z',  // 08:00 CDT, 23 hours later
      elapsedHours: 23,
    },
    {
      label: 'fall back',
      first: '2026-10-31T13:00:00.000Z', // 08:00 CDT
      next: '2026-11-01T14:00:00.000Z',  // 08:00 CST, 25 hours later
      elapsedHours: 25,
    },
  ]) {
    const first = Date.parse(scenario.first);
    const h = makeHarness({ now: first - 60_000 });
    const engine = h.engine();
    const alarm = engine.startTimer({
      name: `daily_${scenario.label.replaceAll(' ', '_')}`,
      dueAt: first,
      kind: 'alarm',
      payload: {
        notify: false,
        schedule: {
          repeat: 'daily',
          timeZone: 'America/Chicago',
          wallTime: '08:00:00',
        },
      },
    });

    h.setNow(first);
    await engine.enqueue({ kind: 'clock', now: h.now() });
    await drain(engine);
    const recurring = h.store.getTimer(alarm.id);
    assert.equal(recurring.status, 'active', scenario.label);
    assert.equal(new Date(recurring.due_at).toISOString(), scenario.next, scenario.label);
    assert.equal((recurring.due_at - first) / 3_600_000, scenario.elapsedHours, scenario.label);
    assert.equal(h.bus.events.filter((event) => event.type === `alarm.${alarm.name}.finished`).length, 1);
  }
});

test('weekday alarms skip Saturday and Sunday while keeping their local wall time', async () => {
  const friday = Date.parse('2026-08-14T13:00:00.000Z'); // Friday 08:00 CDT
  const monday = Date.parse('2026-08-17T13:00:00.000Z');
  const h = makeHarness({ now: friday - 60_000 });
  const engine = h.engine();
  const alarm = engine.startTimer({
    name: 'weekday_alarm',
    dueAt: friday,
    kind: 'alarm',
    payload: {
      notify: false,
      schedule: {
        repeat: 'weekdays',
        timeZone: 'America/Chicago',
        wallTime: '08:00:00',
      },
    },
  });

  h.setNow(friday);
  await engine.enqueue({ kind: 'clock', now: h.now() });
  await drain(engine);
  assert.equal(h.store.getTimer(alarm.id).due_at, monday);
  assert.equal(h.store.getTimer(alarm.id).status, 'active');
});

test('explicit weekly alarm days do not implicitly include the creation weekday', async () => {
  const friday = Date.parse('2026-08-14T13:00:00.000Z'); // Friday 08:00 CDT
  const monday = Date.parse('2026-08-17T13:00:00.000Z'); // Monday 08:00 CDT
  const h = makeHarness({ now: friday - 60_000 });
  const engine = h.engine();
  const alarm = engine.startTimer({
    name: 'monday_only',
    dueAt: friday,
    kind: 'alarm',
    payload: {
      notify: false,
      schedule: {
        repeat: 'weekly',
        timeZone: 'America/Chicago',
        wallTime: '08:00:00',
        days: ['monday'],
        // This compatibility field reflects the initial/creation weekday. It
        // must not be unioned into an explicitly supplied day set.
        weekday: 'friday',
      },
    },
  });

  h.setNow(friday);
  await engine.enqueue({ kind: 'clock', now: h.now() });
  await drain(engine);
  assert.equal(h.store.getTimer(alarm.id).due_at, monday);
  assert.equal(h.store.getTimer(alarm.id).status, 'active');
});

/* ── injected fakes ─────────────────────────────────────────── */

function makeStore(now) {
  const rules = new Map();
  const timers = new Map();
  const variables = new Map();
  const runs = [];
  const events = [];
  const valueHistory = [];
  let timerSequence = 0;
  let valueHistorySequence = 0;

  const copy = (value) => value == null ? value : structuredClone(value);
  const getRule = (id) => copy(rules.get(String(id)) || null);
  const getTimer = (idOrName) => {
    const key = String(idOrName || '');
    if (timers.has(key)) return copy(timers.get(key));
    const statusRank = new Map([['active', 0], ['paused', 1], ['fired', 2]]);
    return copy(
      [...timers.values()]
        .filter((timer) => timer.name === key)
        .sort((left, right) => {
          const byStatus = (statusRank.get(left.status) ?? 3) - (statusRank.get(right.status) ?? 3);
          return byStatus || right.created_at - left.created_at;
        })[0] || null,
    );
  };

  const store = {
    _rules: rules,
    _timers: timers,
    _variables: variables,
    _runs: runs,
    _events: events,
    _valueHistory: valueHistory,

    saveRule(input, { expectedRevision = null } = {}) {
      const current = rules.get(input.id);
      if (current && expectedRevision != null && Number(expectedRevision) !== current.revision) {
        const error = new Error(`automation changed elsewhere (expected revision ${expectedRevision}, current ${current.revision})`);
        error.code = 'revision_conflict';
        throw error;
      }
      const { createdBy, ...definitionInput } = copy(input);
      const definition = { ...definitionInput, enabled: input.enabled !== false };
      const row = {
        id: input.id,
        name: input.name,
        enabled: input.enabled !== false,
        archived: false,
        revision: current ? current.revision + 1 : 1,
        definition,
        created_at: current?.created_at ?? now(),
        updated_at: now(),
        created_by: current?.created_by ?? createdBy ?? input.metadata?.createdBy ?? 'carvis',
        last_evaluated_at: current?.last_evaluated_at ?? null,
        last_fired_at: current?.last_fired_at ?? null,
        fire_count: current?.fire_count ?? 0,
        while_iterations: 0,
        last_match: current?.last_match ?? null,
        last_outcome: current?.last_outcome ?? null,
        last_error: current?.last_error ?? null,
      };
      rules.set(row.id, row);
      return copy(row);
    },

    getRule,
    listRules({ enabledOnly = false, includeArchived = false, limit = 200 } = {}) {
      return [...rules.values()]
        .filter((row) => (!enabledOnly || row.enabled) && (includeArchived || !row.archived))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit)
        .map(copy);
    },
    setRuleEnabled(id, enabled) {
      const row = rules.get(String(id));
      if (!row) return null;
      row.enabled = Boolean(enabled);
      row.definition.enabled = Boolean(enabled);
      row.updated_at = now();
      row.revision += 1;
      return copy(row);
    },
    archiveRule(id) {
      const row = rules.get(String(id));
      if (!row || row.archived) return false;
      row.archived = true;
      row.enabled = false;
      row.definition.enabled = false;
      row.updated_at = now();
      return true;
    },
    updateEvaluation(id, { matched, fired = false, outcome = null, error = null, whileIterations } = {}) {
      const row = rules.get(String(id));
      if (!row) return;
      row.last_evaluated_at = now();
      row.last_match = matched == null ? null : Boolean(matched);
      if (fired) {
        row.last_fired_at = now();
        row.fire_count += 1;
      }
      if (outcome != null) row.last_outcome = outcome;
      row.last_error = error;
      if (Number.isSafeInteger(whileIterations) && whileIterations >= 0) row.while_iterations = whileIterations;
    },
    recordRun(input) {
      const row = {
        id: input.id,
        rule_id: input.ruleId,
        ts: input.ts,
        trigger: copy(input.trigger || {}),
        outcome: input.outcome,
        actions: copy(input.actions || []),
        error: input.error ?? null,
        ms: input.ms || 0,
      };
      runs.push(row);
      return copy(row);
    },
    listRuns({ ruleId = '', limit = 100 } = {}) {
      return runs
        .filter((run) => !ruleId || run.rule_id === ruleId)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .map(copy);
    },

    setVariable(name, value, updatedBy = 'carvis') {
      const row = { name: String(name), value: copy(value), updated_at: now(), updated_by: updatedBy };
      variables.set(row.name, row);
      return copy(row);
    },
    getVariable(name) { return copy(variables.get(String(name)) || null); },
    listVariables() { return [...variables.values()].sort((a, b) => a.name.localeCompare(b.name)).map(copy); },
    deleteVariable(name) { return variables.delete(String(name)); },
    incrementVariable(name, amount = 1, updatedBy = 'carvis') {
      const key = String(name);
      const current = Number(variables.get(key)?.value || 0);
      return this.setVariable(key, current + Number(amount), updatedBy);
    },

    createTimer(input) {
      const kind = input.kind === 'alarm' ? 'alarm' : 'timer';
      const row = {
        id: input.id || `${kind}_${++timerSequence}`,
        name: String(input.name || (kind === 'alarm' ? 'Alarm' : 'Timer')),
        kind,
        created_at: now(),
        due_at: Number(input.dueAt),
        repeat_ms: input.repeatMs == null ? null : Number(input.repeatMs),
        status: 'active',
        payload: copy(input.payload || {}),
        rule_id: input.ruleId || null,
        paused_remaining_ms: null,
        fired_at: null,
      };
      timers.set(row.id, row);
      return copy(row);
    },
    dueTimers(at = now()) {
      return [...timers.values()]
        .filter((timer) => timer.status === 'active' && timer.due_at <= at)
        .sort((a, b) => a.due_at - b.due_at)
        .map(copy);
    },
    listTimers({ activeOnly = false, kind = '', limit = 200 } = {}) {
      return [...timers.values()]
        .filter((timer) => (!activeOnly || timer.status === 'active') && (!kind || timer.kind === kind))
        .sort((a, b) => a.due_at - b.due_at)
        .slice(0, limit)
        .map(copy);
    },
    getTimer,
    markTimerFired(id, repeatMs = null) {
      const timer = timers.get(String(id));
      if (!timer) return null;
      timer.fired_at = now();
      if (repeatMs && Number(repeatMs) > 0) {
        while (timer.due_at <= now()) timer.due_at += Number(repeatMs);
        timer.status = 'active';
      } else {
        timer.status = 'fired';
      }
      return copy(timer);
    },
    rescheduleTimer(id, dueAt, at = now()) {
      const timer = timers.get(String(id));
      if (!timer || timer.status !== 'active' || Number(dueAt) <= Number(at)) return null;
      timer.status = 'active';
      timer.due_at = Number(dueAt);
      timer.fired_at = Number(at);
      timer.paused_remaining_ms = null;
      return copy(timer);
    },
    cancelTimer(idOrName) {
      const timer = getMutableTimer(timers, idOrName, new Set(['active']));
      if (!timer) return 0;
      timer.status = 'cancelled';
      return 1;
    },
    pauseTimer(idOrName, at = now()) {
      const timer = getMutableTimer(timers, idOrName, new Set(['active']));
      if (!timer) return null;
      timer.status = 'paused';
      timer.paused_remaining_ms = Math.max(0, timer.due_at - at);
      return copy(timer);
    },
    resumeTimer(idOrName, at = now()) {
      const timer = getMutableTimer(timers, idOrName, new Set(['paused']));
      if (!timer) return null;
      timer.status = 'active';
      timer.due_at = at + Math.max(0, timer.paused_remaining_ms || 0);
      timer.paused_remaining_ms = null;
      return copy(timer);
    },
    snoozeTimer(idOrName, durationMs, at = now()) {
      const timer = getMutableTimer(timers, idOrName);
      if (!timer || timer.kind !== 'alarm') return null;
      timer.status = 'active';
      timer.due_at = at + Math.max(1_000, Number(durationMs) || 0);
      timer.fired_at = null;
      timer.paused_remaining_ms = null;
      return copy(timer);
    },
    recordValueChange(refName, from, to, ts = now()) {
      const row = {
        id: ++valueHistorySequence,
        ref: String(refName),
        ts: Number(ts),
        from: copy(from),
        to: copy(to),
      };
      valueHistory.push(row);
      return row.id;
    },
    recentValueChanges(refName, limit = 500) {
      return valueHistory
        .filter((row) => row.ref === String(refName))
        .sort((a, b) => b.ts - a.ts || b.id - a.id)
        .slice(0, limit)
        .map(({ ref, ts, from, to }) => copy({ ref, ts, from, to }));
    },
    recentEvents(limit = 5_000) { return events.slice(0, limit).map(copy); },
  };
  return store;
}

function getMutableTimer(timers, idOrName, statuses = null) {
  const key = String(idOrName || '');
  const byId = timers.get(key);
  if (byId && (!statuses || statuses.has(byId.status))) return byId;
  return [...timers.values()].reverse().find((timer) => timer.name === key && (!statuses || statuses.has(timer.status))) || null;
}

function makeBus(store, now) {
  const subscribers = new Set();
  const events = [];
  return {
    events,
    subscribe(_pattern, callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    publish(type, source, data = {}) {
      const event = { id: `evt_${events.length + 1}`, type, source, timestamp: now(), data: structuredClone(data) };
      events.push(event);
      store._events.unshift(structuredClone({ ...event, ts: event.timestamp }));
      for (const callback of subscribers) callback(event);
      return event;
    },
  };
}

function makeGateway({ tools = {}, call } = {}) {
  const defaults = {
    'safe.write': { risk: 1 },
    'safe.idempotent': { risk: 1, idempotent: true },
    'medium.write': { risk: 2 },
    'secure.unlock': { risk: 3 },
    'mac.command': { risk: 2 },
    'automation.update': { risk: 1 },
    'memory.forget': { risk: 2 },
    'ha.entity.command': { risk: 2 },
    'speech.say': { risk: 1 },
    'hud.set_widget': { risk: 1 },
    'hud.show_camera': { risk: 1 },
    'hud.show_notification': { risk: 1 },
    'hud.clear_all': { risk: 1 },
  };
  const definitions = new Map(Object.entries({ ...defaults, ...tools }).map(([name, details]) => [name, {
    name,
    description: details.description || name,
    schema: details.schema || { type: 'object', properties: {} },
    ...details,
  }]));
  const calls = [];
  return {
    calls,
    get(name) { return definitions.get(name); },
    definitions() {
      return [...definitions.values()].map(({ name, description, schema }) => ({ name, description, schema }));
    },
    inventory() {
      return [...definitions.values()].map(({ name, description, risk, idempotent }) => ({ name, description, risk, idempotent: Boolean(idempotent) }));
    },
    async call(name, args, ctx) {
      const entry = { name, args: structuredClone(args || {}), ctx: structuredClone(ctx || {}) };
      calls.push(entry);
      return call ? call(entry) : { success: true, echoed: entry.args };
    },
  };
}

function makeHa() {
  const states = new Map();
  return {
    states,
    listEntities() {
      return [...states.values()].map((state) => ({
        entity_id: state.entity_id,
        domain: state.entity_id.split('.')[0],
        name: state.attributes?.friendly_name || state.entity_id,
        area: 'Test',
        state: state.state,
      }));
    },
  };
}

function haState(entityId, state, now, attributes = {}) {
  return { entity_id: entityId, state, attributes, last_changed: new Date(now).toISOString() };
}


test('routine memory references survive migration to Continuity IDs and respect deletion',()=>{
 let items=[{id:'new_memory_id',text:'Useful context',dmr:{legacyId:'old_memory_id'}}];
 const engine=makeHarness({memory:{all:()=>items}}).engine();
 assert.equal(engine.resolve('memory.item.old_memory_id.text'),'Useful context');
 assert.equal(engine.resolve('memory.item.old_memory_id.exists'),true);
 items=[];assert.equal(engine.resolve('memory.item.old_memory_id.exists'),false);
});
