import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_PREFIXES,
  ACTION_TYPES,
  DEFAULT_LIMITS,
  OPERATORS,
  RULE_SCHEMA_VERSION,
  VALUE_NAMESPACES,
  RuleValidationError,
  assertValidRule,
  evaluateCondition,
  evaluateRule,
  materializeAction,
  summarizeRule,
  validateRule,
} from '../server/rules/index.js';

const literal = (value) => ({ literal: value });
const ref = (value) => ({ ref: value });

function simpleRule(overrides = {}) {
  return {
    version: RULE_SCHEMA_VERSION,
    id: 'evening-home',
    name: 'Evening arrival',
    enabled: true,
    when: { op: 'equals', left: ref('location.owner'), right: literal('home') },
    then: [{ type: 'speech.say', text: literal('Welcome home') }],
    ...overrides,
  };
}

test('exports the stable built-in rule vocabulary', () => {
  assert.deepEqual(VALUE_NAMESPACES, [
    'time', 'ha', 'atlas', 'timer', 'location', 'carvis', 'memory', 'variable',
  ]);
  assert.ok(OPERATORS.includes('changed_to'));
  assert.ok(OPERATORS.includes('hasnt_happened'));
  assert.ok(ACTION_TYPES.includes('tool.call'));
  assert.ok(ACTION_TYPES.includes('speech.say'));
  assert.deepEqual(ACTION_PREFIXES, ['hud.']);
});

test('strict validation accepts WHEN / IF / WHILE, boolean groups, temporal conditions, and every action family', () => {
  const rule = simpleRule({
    when: {
      all: [
        { op: 'changed_to', left: ref('location.owner'), right: literal('home') },
        {
          any: [
            { op: 'equals', left: ref('time.hour'), right: literal(20) },
            { not: { op: 'equals', left: ref('carvis.muted'), right: literal(true) } },
          ],
        },
      ],
    },
    if: {
      op: 'has_been',
      left: ref('ha.light.living_room.state'),
      right: literal('off'),
      durationMs: 60_000,
    },
    while: { op: 'not_equals', left: ref('timer.bedtime.state'), right: literal('finished') },
    then: [
      { type: 'tool.call', tool: 'ha.light.turn_on', arguments: { entity_id: 'light.living_room' } },
      { type: 'variable.set', name: 'arrival_count', value: ref('memory.arrival_count') },
      { type: 'timer.start', timer: 'welcome', durationMs: literal(5_000), payload: { source: ref('location.owner') } },
      { type: 'timer.cancel', timer: 'old_timer' },
      { type: 'rule.enable', ruleId: 'night-mode' },
      { type: 'rule.disable', ruleId: 'away-mode' },
      { type: 'carvis.wake', prompt: literal('The owner arrived'), trigger: 'automation' },
      { type: 'hud.show', payload: { title: literal('Home'), value: ref('time.local') } },
      {
        type: 'speech.say', text: literal('Welcome home'), voice: 'default',
        media_player: 'media_player.kitchen', tts_entity: 'tts.openai_tts', language: 'en-US', cache: true,
      },
    ],
    else: [{ type: 'hud.clear', payload: { slot: 1 } }],
    metadata: { createdBy: 'test', tags: ['home', 'arrival'] },
  });

  const result = validateRule(rule);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.stats.conditions, 8);
  assert.equal(result.stats.actions, 10);
  assert.equal(assertValidRule(rule), rule);
});

test('validation rejects unknown keys, namespaces, action types, and malformed value nodes', () => {
  const rule = simpleRule({
    surprise: true,
    when: {
      op: 'equals',
      left: { ref: 'weather.outside', literal: 'bad' },
      right: 20,
      secret: 'ignored?',
    },
    then: [{ type: 'shell.exec', command: 'rm' }],
  });
  const result = validateRule(rule);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === '$.surprise' && error.code === 'unknown_key'));
  assert.ok(result.errors.some((error) => error.path === '$.when.secret' && error.code === 'unknown_key'));
  assert.ok(result.errors.some((error) => error.path === '$.when.left' && error.code === 'value_node'));
  assert.ok(result.errors.some((error) => error.path === '$.when.right' && error.code === 'value_node'));
  assert.ok(result.errors.some((error) => error.path === '$.then[0].type' && error.code === 'action_type'));
  assert.throws(() => assertValidRule(rule), RuleValidationError);
});

test('validation bounds condition depth, total actions, JSON size, and cycles', () => {
  let deep = { op: 'equals', left: ref('time.hour'), right: literal(20) };
  for (let index = 0; index < 6; index += 1) deep = { not: deep };
  const tooDeep = validateRule(simpleRule({ when: deep }), { limits: { maxDepth: 3 } });
  assert.equal(tooDeep.ok, false);
  assert.ok(tooDeep.errors.some((error) => error.code === 'too_deep'));

  const tooManyActions = validateRule(simpleRule({
    then: Array.from({ length: 3 }, (_, index) => ({ type: 'timer.cancel', timer: `timer_${index}` })),
  }), { limits: { maxActions: 2 } });
  assert.equal(tooManyActions.ok, false);
  assert.ok(tooManyActions.errors.some((error) => error.code === 'too_many_actions'));

  const payload = {};
  payload.loop = payload;
  const cyclic = validateRule(simpleRule({
    then: [{ type: 'hud.show', payload }],
  }));
  assert.equal(cyclic.ok, false);
  assert.ok(cyclic.errors.some((error) => error.code === 'cyclic'));

  const conditionCycle = { not: null };
  conditionCycle.not = conditionCycle;
  const cycleResult = evaluateRule(simpleRule({ when: conditionCycle }));
  assert.equal(cycleResult.valid, false);
  assert.match(cycleResult.summary, /<cycle>/);

  const dataHeavy = validateRule(simpleRule({ metadata: { values: [1, 2, 3, 4] } }), {
    limits: { maxTemplateNodes: 3 },
  });
  assert.equal(dataHeavy.ok, false);
  assert.ok(dataHeavy.errors.some((error) => error.code === 'too_many_values'));
  assert.equal(DEFAULT_LIMITS.maxDepth, 16);
});

test('a namespaced action prefix must include a concrete operation', () => {
  const result = validateRule(simpleRule({ then: [{ type: 'hud.' }] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'action_type'));
});

test('deterministically evaluates boolean conditions and materializes selected actions', () => {
  const rule = simpleRule({
    when: {
      all: [
        { op: 'equals', left: ref('location.owner'), right: literal('home') },
        { op: 'greater_than', left: ref('time.hour'), right: literal(19) },
        { not: { op: 'equals', left: ref('carvis.muted'), right: literal(true) } },
      ],
    },
    if: { op: 'less_than', left: ref('ha.sensor.temperature'), right: literal(80) },
    while: { op: 'equals', left: ref('variable.paused'), right: literal(false) },
    then: [
      {
        type: 'tool.call',
        tool: 'ha.light.turn_on',
        arguments: {
          entity_id: ref('memory.preferred_light'),
          brightness: literal(100),
          transition: 1,
        },
      },
      { type: 'variable.set', name: 'greeting', value: ref('atlas.next_task') },
      { type: 'timer.start', timer: 'welcome', durationMs: ref('memory.welcome_duration_ms') },
      { type: 'speech.say', text: ref('memory.welcome_phrase') },
    ],
  });
  const values = {
    'location.owner': 'home',
    'time.hour': 20,
    'carvis.muted': false,
    'ha.sensor.temperature': 72,
    'variable.paused': false,
    'memory.preferred_light': 'light.living_room',
    'atlas.next_task': 'Finish Carvis',
    'memory.welcome_duration_ms': 5_000,
    'memory.welcome_phrase': 'Welcome home',
  };

  const result = evaluateRule(rule, { now: 1_700_000_000_000, values });
  assert.equal(result.ok, true);
  assert.equal(result.valid, true);
  assert.equal(result.matched, true);
  assert.equal(result.triggered, true);
  assert.equal(result.branch, 'then');
  assert.deepEqual(result.conditions, { when: true, if: true, while: true });
  assert.deepEqual(result.actions[0].arguments, {
    entity_id: 'light.living_room',
    brightness: 100,
    transition: 1,
  });
  assert.equal(result.actions[1].value, 'Finish Carvis');
  assert.equal(result.actions[2].durationMs, 5_000);
  assert.equal(result.actions[3].text, 'Welcome home');
  assert.deepEqual(rule.then[0].arguments.entity_id, ref('memory.preferred_light'), 'input AST remains unchanged');
});

test('WHEN false selects no branch; failed IF selects ELSE and short-circuits WHILE', () => {
  const whenFalse = evaluateRule(simpleRule(), { values: { 'location.owner': 'away' } });
  assert.equal(whenFalse.ok, true);
  assert.equal(whenFalse.matched, false);
  assert.equal(whenFalse.branch, 'none');
  assert.deepEqual(whenFalse.actions, []);

  let whileReads = 0;
  const guarded = simpleRule({
    if: { op: 'equals', left: ref('carvis.ready'), right: literal(true) },
    while: { op: 'equals', left: ref('timer.waiting'), right: literal(true) },
    else: [{ type: 'speech.say', text: literal('Not ready') }],
  });
  const result = evaluateRule(guarded, {
    resolve(name) {
      if (name === 'location.owner') return 'home';
      if (name === 'carvis.ready') return false;
      if (name === 'timer.waiting') whileReads += 1;
      return undefined;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.triggered, false);
  assert.equal(result.branch, 'else');
  assert.equal(result.if, false);
  assert.equal(result.while, null);
  assert.equal(whileReads, 0);
  assert.equal(result.actions[0].text, 'Not ready');
});

test('disabled rules do not resolve values or history', () => {
  let calls = 0;
  const result = evaluateRule(simpleRule({ enabled: false }), {
    resolve() { calls += 1; return 'home'; },
    history: { test() { calls += 1; return true; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'disabled');
  assert.equal(calls, 0);
});

test('all temporal operators use the explicit synchronous history interface and supplied clock', () => {
  const calls = [];
  const history = {
    test(query) {
      calls.push(query);
      return true;
    },
  };
  const right = literal('on');
  const conditions = [
    { op: 'changed_to', left: ref('ha.light.office.state'), right },
    { op: 'changed_from', left: ref('ha.light.office.state'), right },
    { op: 'for_duration', left: ref('ha.light.office.state'), right, durationMs: 60_000 },
    { op: 'within', left: ref('atlas.task.completed'), right: literal('task-1'), withinMs: 300_000 },
    { op: 'has_been', left: ref('location.owner'), right: literal('home'), durationMs: 600_000 },
    { op: 'hasnt_happened', left: ref('timer.medication.finished'), withinMs: 86_400_000 },
  ];
  for (const condition of conditions) {
    assert.equal(evaluateCondition(condition, { now: 123_456, history }), true);
  }
  assert.deepEqual(calls.map((call) => call.operator), conditions.map((condition) => condition.op));
  assert.ok(calls.every((call) => call.now === 123_456));
  assert.equal(calls.at(-1).expectedProvided, false);
  assert.ok(calls.every(Object.isFrozen));
});

test('temporal and resolution failures fail closed without returning actions', () => {
  const temporalRule = simpleRule({
    when: { op: 'changed_to', left: ref('ha.lock.front.state'), right: literal('unlocked') },
  });
  const noHistory = evaluateRule(temporalRule, { now: 123 });
  assert.equal(noHistory.ok, false);
  assert.equal(noHistory.valid, true);
  assert.match(noHistory.error.message, /context\.history/);
  assert.deepEqual(noHistory.actions, []);

  const noClock = evaluateRule(temporalRule, { history: { test: () => true } });
  assert.equal(noClock.ok, false);
  assert.match(noClock.error.message, /context\.now/);

  const unresolved = evaluateRule(simpleRule(), { values: {} });
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.error.message, /No value available/);
  assert.deepEqual(unresolved.actions, []);
});

test('custom namespaces, operators, and actions are explicitly extensible', () => {
  const rule = simpleRule({
    when: { op: 'approximately', left: ref('weather.temperature'), right: literal(70) },
    then: [{ type: 'alarm.arm', payload: { name: ref('weather.station') } }],
  });
  const options = {
    valueNamespaces: ['weather'],
    operators: ['approximately'],
    actionTypes: ['alarm.arm'],
  };
  assert.equal(validateRule(rule, options).ok, true);
  const result = evaluateRule(rule, {
    values: { 'weather.temperature': 71, 'weather.station': 'backyard' },
    operators: { approximately: ({ left, right }) => Math.abs(left - right) <= 2 },
  }, {
    valueNamespaces: ['weather'],
    actionTypes: ['alarm.arm'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.triggered, true);
  assert.deepEqual(result.actions, [{ type: 'alarm.arm', payload: { name: 'backyard' } }]);
});

test('materializeAction rejects an invalid resolved timer duration', () => {
  assert.throws(
    () => materializeAction(
      { type: 'timer.start', timer: 'bad', durationMs: ref('variable.delay') },
      { values: { 'variable.delay': -1 } },
    ),
    /positive integer/,
  );
});

test('human-readable summary presents a block program', () => {
  const summary = summarizeRule(simpleRule({
    when: {
      all: [
        { op: 'equals', left: ref('location.owner'), right: literal('home') },
        { not: { op: 'contains', left: ref('memory.mode'), right: literal('quiet') } },
      ],
    },
    then: [
      { type: 'tool.call', tool: 'ha.light.turn_on', arguments: { entity_id: 'light.living_room' } },
      { type: 'speech.say', text: literal('Welcome home') },
    ],
  }));
  assert.match(summary, /^RULE "Evening arrival" \[ENABLED\]/);
  assert.match(summary, /WHEN\n  AND/);
  assert.match(summary, /location\.owner EQUALS "home"/);
  assert.match(summary, /NOT\n      memory\.mode CONTAINS "quiet"/);
  assert.match(summary, /THEN\n  TOOL\.CALL ha\.light\.turn_on/);
  assert.match(summary, /SPEECH\.SAY "Welcome home"/);

  const temporal = summarizeRule(simpleRule({
    when: {
      op: 'hasnt_happened',
      left: ref('timer.medication.finished'),
      withinMs: 7_200_000,
    },
  }));
  assert.match(temporal, /timer\.medication\.finished HASN'T HAPPENED WITHIN 2h/);
});
