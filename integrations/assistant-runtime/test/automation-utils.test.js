import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AutomationValueError,
  calculateMath,
  collectionSize,
  countMatching,
  countOccurrences,
  evaluateMath,
  nextAlarmOccurrence,
  parseDuration,
  parseTimeInput,
  planTtsCall,
  shapeWeatherState,
  timeSnapshot,
} from '../server/automation-utils.js';

test('safe math parser honors precedence, variables, functions, and exponent associativity', () => {
  assert.equal(evaluateMath('2 + 3 * 4'), 14);
  assert.equal(evaluateMath('2 ^ 3 ^ 2'), 512);
  assert.equal(evaluateMath('-2 ^ 2'), -4);
  assert.equal(evaluateMath('clamp(temp * 2, 0, 100)', { temp: 62 }), 100);
  assert.equal(evaluateMath('round(10 / 3, 2)'), 3.33);
  assert.equal(evaluateMath('average(2, 4, 9)'), 5);
});

test('safe math parser has no Javascript escape hatch and rejects invalid results', () => {
  for (const source of ['process.exit()', 'globalThis.constructor', '1; 2', '1 / 0', 'sqrt(-1)', 'unknown + 1']) {
    assert.throws(() => evaluateMath(source), AutomationValueError, source);
  }
  assert.throws(() => evaluateMath('x', { x: Infinity }), /finite number/);
});

test('explicit math operations are bounded and deterministic', () => {
  assert.equal(calculateMath('add', [1, 2, 3]), 6);
  assert.equal(calculateMath('divide', [20, 2, 5]), 2);
  assert.equal(calculateMath('average', [0.1, 0.2], { precision: 2 }), 0.15);
  assert.equal(calculateMath('clamp', [120, 0, 100]), 100);
  assert.throws(() => calculateMath('divide', [2, 0]), /division by zero/);
  assert.throws(() => calculateMath('shell', [1]), /must be one of/);
});

test('time snapshots preserve the requested timezone and DST offset', () => {
  const snapshot = timeSnapshot({ now: Date.parse('2026-08-14T01:30:45Z'), timeZone: 'America/Chicago' });
  assert.equal(snapshot.local, '2026-08-13T20:30:45-05:00');
  assert.equal(snapshot.date, '2026-08-13');
  assert.equal(snapshot.time, '20:30:45');
  assert.equal(snapshot.weekday, 'Thursday');
  assert.equal(snapshot.hour, 20);
  assert.equal(snapshot.offset_minutes, -300);
});

test('time input accepts absolute/local times and makes time-only alarms future-facing', () => {
  const now = Date.parse('2026-08-14T01:30:00Z'); // 20:30 Thursday in Chicago
  assert.equal(
    parseTimeInput('2026-08-14T05:00:00Z', { now, timeZone: 'America/Chicago' }).epoch_ms,
    Date.parse('2026-08-14T05:00:00Z'),
  );
  assert.equal(
    parseTimeInput('9:00 pm', { now, timeZone: 'America/Chicago' }).iso,
    '2026-08-14T02:00:00.000Z',
  );
  assert.equal(
    parseTimeInput('8:00 pm', { now, timeZone: 'America/Chicago' }).iso,
    '2026-08-15T01:00:00.000Z',
  );
  assert.equal(
    parseTimeInput('2026-12-25 09:15', { now, timeZone: 'America/Chicago' }).local,
    '2026-12-25T09:15:00-06:00',
  );
  assert.throws(
    () => parseTimeInput('2026-03-08 02:30', { timeZone: 'America/Chicago' }),
    /does not exist/,
  );
});

test('recurring alarm occurrences honor first-day filters and skip DST-gap wall times', () => {
  assert.equal(
    new Date(nextAlarmOccurrence({
      after: Date.parse('2026-08-14T17:00:00Z'), // Friday noon in Chicago
      wallTime: '09:00:00', timeZone: 'America/Chicago', repeat: 'weekdays',
    })).toISOString(),
    '2026-08-17T14:00:00.000Z',
  );
  assert.equal(
    new Date(nextAlarmOccurrence({
      after: Date.parse('2026-08-13T17:00:00Z'),
      wallTime: '09:00:00', timeZone: 'America/Chicago', repeat: 'weekly', days: ['monday'],
    })).toISOString(),
    '2026-08-17T14:00:00.000Z',
  );
  assert.equal(
    new Date(nextAlarmOccurrence({
      after: Date.parse('2026-03-07T14:00:00Z'),
      wallTime: '02:30:00', timeZone: 'America/Chicago', repeat: 'daily',
    })).toISOString(),
    '2026-03-09T07:30:00.000Z',
  );
});

test('durations accept structured, ISO, unit, clock, and numeric forms', () => {
  assert.equal(parseDuration(90), 90_000);
  assert.equal(parseDuration({ hours: 1, minutes: 2, seconds: 3 }), 3_723_000);
  assert.equal(parseDuration('PT1H2M3S'), 3_723_000);
  assert.equal(parseDuration('1 hour 30 minutes'), 5_400_000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('01:02:03'), 3_723_000);
  assert.throws(() => parseDuration('eventually'), /invalid duration/);
});

test('count helpers define collection, occurrence, and filtered-count semantics', () => {
  assert.equal(collectionSize('A😀B'), 3);
  assert.equal(collectionSize({ a: 1, b: 2 }), 2);
  assert.equal(countOccurrences('Go go GONE', 'go'), 3);
  assert.equal(countOccurrences(['on', 'OFF', 'on'], 'ON'), 2);
  const entities = [
    { state: 'on', attributes: { temperature: 72 } },
    { state: 'off', attributes: { temperature: 80 } },
    { state: 'ON', attributes: { temperature: 69 } },
  ];
  assert.equal(countMatching(entities, { path: 'state', operator: 'equals', value: 'on' }), 2);
  assert.equal(countMatching(entities, { path: 'attributes.temperature', operator: 'greater_than', value: 70 }), 2);
  assert.throws(() => countMatching(entities, { path: '__proto__.x' }), /unsafe/);
});

test('weather shaping handles HA return-response envelopes without leaking noisy attributes', () => {
  const state = {
    entity_id: 'weather.forecast_home',
    state: 'cloudy',
    last_changed: '2026-08-14T01:00:00Z',
    attributes: {
      friendly_name: 'Example forecast',
      temperature: 77,
      temperature_unit: '°F',
      humidity: 87,
      wind_speed: 8.26,
      wind_speed_unit: 'mph',
      attribution: 'Weather source',
      irrelevant_blob: { should_not: 'escape' },
    },
  };
  const response = {
    changed_states: [],
    service_response: {
      'weather.forecast_home': {
        forecast: [
          { datetime: '2026-08-14T17:00:00Z', condition: 'sunny', temperature: 82, templow: 69, humidity: 64 },
          { datetime: '2026-08-15T17:00:00Z', condition: 'rainy', temperature: 79 },
        ],
      },
    },
  };
  const weather = shapeWeatherState(state, response, {
    forecastType: 'daily',
    limit: 1,
    now: Date.parse('2026-08-14T01:05:00Z'),
  });
  assert.equal(weather.condition, 'cloudy');
  assert.deepEqual(weather.current, { temperature: 77, humidity: 87, wind_speed: 8.26 });
  assert.deepEqual(weather.units, { temperature: '°F', wind_speed: 'mph' });
  assert.equal(weather.age_seconds, 300);
  assert.deepEqual(weather.forecast, [{
    datetime: '2026-08-14T17:00:00Z',
    condition: 'sunny',
    temperature: 82,
    temperature_low: 69,
    humidity: 64,
  }]);
  assert.equal('irrelevant_blob' in weather.current, false);
});

test('TTS planning emits only tts.speak with selected, live targets', () => {
  const available = new Set(['tts.openai_tts', 'media_player.example_speaker']);
  const call = planTtsCall({
    tts_entity_id: 'tts.openai_tts',
    media_player_entity_id: 'media_player.example_speaker',
    message: '  Dinner\u0007 is ready.  ',
    language: 'en-US',
  }, {
    availableEntities: available,
    allowedMediaPlayers: ['media_player.example_speaker'],
  });
  assert.deepEqual(call, {
    domain: 'tts',
    service: 'speak',
    data: {
      entity_id: 'tts.openai_tts',
      media_player_entity_id: 'media_player.example_speaker',
      message: 'Dinner is ready.',
      cache: true,
      language: 'en-US',
    },
  });
  assert.throws(
    () => planTtsCall({
      tts_entity_id: 'tts.openai_tts',
      media_player_entity_id: 'media_player.example_speaker',
      message: 'Hello',
    }, { availableEntities: available, allowedMediaPlayers: [] }),
    /not selected for control/,
  );
  assert.throws(() => planTtsCall({
    tts_entity_id: 'script.sneaky',
    media_player_entity_id: 'media_player.example_speaker',
    message: 'Hello',
  }), /must be a tts entity/);
});
