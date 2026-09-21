/**
 * Pure building blocks for Carvis automations.
 *
 * These functions deliberately know nothing about the database, the model, or
 * Home Assistant's network client. The rule engine can therefore validate and
 * preview a block with exactly the same semantics it will use at runtime.
 */

export class AutomationValueError extends Error {
  constructor(message, code = 'invalid_automation_value') {
    super(message);
    this.name = 'AutomationValueError';
    this.code = code;
  }
}

const MAX_MATH_EXPRESSION = 512;
const MAX_MATH_TOKENS = 256;
const MAX_MATH_DEPTH = 32;
const MAX_MATH_OPERANDS = 64;

const MATH_FUNCTIONS = Object.freeze({
  abs: unary(Math.abs),
  ceil: unary(Math.ceil),
  floor: unary(Math.floor),
  round: (...args) => {
    arity('round', args, 1, 2);
    const digits = args.length === 2 ? integerInRange(args[1], 0, 12, 'round digits') : 0;
    const factor = 10 ** digits;
    return Math.round((args[0] + Number.EPSILON) * factor) / factor;
  },
  sqrt: unary((value) => {
    if (value < 0) throw valueError('sqrt requires a non-negative value');
    return Math.sqrt(value);
  }),
  min: variadic('min', Math.min),
  max: variadic('max', Math.max),
  sum: variadic('sum', (...values) => values.reduce((total, value) => total + value, 0)),
  average: variadic('average', (...values) => values.reduce((total, value) => total + value, 0) / values.length),
  pow: binary((left, right) => left ** right),
  clamp: (...args) => {
    arity('clamp', args, 3, 3);
    const [value, minimum, maximum] = args;
    if (minimum > maximum) throw valueError('clamp minimum cannot exceed maximum');
    return Math.min(maximum, Math.max(minimum, value));
  },
});

export const MATH_OPERATIONS = Object.freeze([
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'power',
  'minimum',
  'maximum',
  'average',
  'absolute',
  'round',
  'floor',
  'ceil',
  'sqrt',
  'clamp',
]);

/**
 * Evaluate a small arithmetic language without dynamic code execution.
 *
 * Supported: finite numbers, + - * / % ^, parentheses, named numeric
 * variables, pi/e, and the functions in MATH_FUNCTIONS above. Property
 * access, strings, assignment, Javascript globals, and arbitrary calls do not
 * exist in this grammar.
 */
export function evaluateMath(expression, variables = {}) {
  const source = String(expression ?? '').trim();
  if (!source) throw valueError('math expression is required');
  if (source.length > MAX_MATH_EXPRESSION) {
    throw valueError(`math expression cannot exceed ${MAX_MATH_EXPRESSION} characters`);
  }
  if (!isPlainObject(variables)) throw valueError('math variables must be an object');

  const tokens = tokenizeMath(source);
  const parser = new MathParser(tokens, variables);
  const result = parser.parse();
  return finiteResult(result);
}

/**
 * Explicit-operation form for a model-facing math tool. This is cheaper and
 * even harder to misuse than the expression parser when a single operation is
 * all the owner requested.
 */
export function calculateMath(operation, operands, { precision } = {}) {
  if (!MATH_OPERATIONS.includes(operation)) {
    throw valueError(`math operation must be one of: ${MATH_OPERATIONS.join(', ')}`);
  }
  if (!Array.isArray(operands) || !operands.length || operands.length > MAX_MATH_OPERANDS) {
    throw valueError(`math operands must contain 1-${MAX_MATH_OPERANDS} numbers`);
  }
  const values = operands.map((value, index) => finiteNumber(value, `operand ${index + 1}`));
  let result;

  switch (operation) {
    case 'add':
      result = values.reduce((total, value) => total + value, 0);
      break;
    case 'subtract':
      atLeast(operation, values, 2);
      result = values.slice(1).reduce((total, value) => total - value, values[0]);
      break;
    case 'multiply':
      result = values.reduce((total, value) => total * value, 1);
      break;
    case 'divide':
      atLeast(operation, values, 2);
      if (values.slice(1).some((value) => value === 0)) throw valueError('division by zero is not allowed');
      result = values.slice(1).reduce((total, value) => total / value, values[0]);
      break;
    case 'modulo':
      exactly(operation, values, 2);
      if (values[1] === 0) throw valueError('modulo by zero is not allowed');
      result = values[0] % values[1];
      break;
    case 'power':
      exactly(operation, values, 2);
      result = values[0] ** values[1];
      break;
    case 'minimum':
      result = Math.min(...values);
      break;
    case 'maximum':
      result = Math.max(...values);
      break;
    case 'average':
      result = values.reduce((total, value) => total + value, 0) / values.length;
      break;
    case 'absolute':
      exactly(operation, values, 1);
      result = Math.abs(values[0]);
      break;
    case 'round':
      exactly(operation, values, 1);
      result = Math.round(values[0]);
      break;
    case 'floor':
      exactly(operation, values, 1);
      result = Math.floor(values[0]);
      break;
    case 'ceil':
      exactly(operation, values, 1);
      result = Math.ceil(values[0]);
      break;
    case 'sqrt':
      exactly(operation, values, 1);
      if (values[0] < 0) throw valueError('sqrt requires a non-negative value');
      result = Math.sqrt(values[0]);
      break;
    case 'clamp':
      exactly(operation, values, 3);
      if (values[1] > values[2]) throw valueError('clamp minimum cannot exceed maximum');
      result = Math.min(values[2], Math.max(values[1], values[0]));
      break;
  }

  result = finiteResult(result);
  if (precision !== undefined) {
    const digits = integerInRange(precision, 0, 12, 'precision');
    const factor = 10 ** digits;
    result = finiteResult(Math.round((result + Number.EPSILON) * factor) / factor);
  }
  return result;
}

/** A timezone-aware, serializable snapshot for time.* value blocks. */
export function timeSnapshot({ now = Date.now(), timeZone = systemTimeZone() } = {}) {
  const epochMs = epochValue(now, 'now');
  const parts = zonedParts(epochMs, timeZone);
  const offsetMinutes = zonedOffsetMinutes(epochMs, timeZone);
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const time = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return {
    iso: new Date(epochMs).toISOString(),
    unix_ms: epochMs,
    unix_seconds: Math.floor(epochMs / 1000),
    time_zone: timeZone,
    offset_minutes: offsetMinutes,
    local: `${date}T${time}${formatOffset(offsetMinutes)}`,
    date,
    time,
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    weekday: parts.weekday,
    is_weekend: parts.weekday === 'Saturday' || parts.weekday === 'Sunday',
  };
}

/**
 * Parse an alarm/run-at value into one exact instant.
 *
 * ISO strings carrying Z/an offset are absolute. A local date/time is
 * interpreted in `timeZone`; a time without a date means its next occurrence
 * (today when still ahead, otherwise tomorrow). DST-gap times are rejected
 * rather than silently shifted by an hour.
 */
export function parseTimeInput(value, {
  now = Date.now(),
  timeZone = systemTimeZone(),
  preferFuture = true,
} = {}) {
  const nowMs = epochValue(now, 'now');
  let epochMs;
  let kind;

  if (value instanceof Date || typeof value === 'number') {
    epochMs = epochValue(value, 'time');
    kind = 'absolute';
  } else {
    const text = String(value ?? '').trim();
    if (!text) throw valueError('time is required');

    if (hasExplicitOffset(text)) {
      epochMs = Date.parse(text);
      if (!Number.isFinite(epochMs)) throw valueError(`invalid absolute time: ${text}`);
      kind = 'absolute';
    } else {
      const dateTime = parseLocalDateTime(text);
      if (dateTime) {
        epochMs = localPartsToEpoch(dateTime, timeZone);
        kind = 'local_datetime';
      } else {
        const dateOnly = parseLocalDate(text);
        if (dateOnly) {
          epochMs = localPartsToEpoch({ ...dateOnly, hour: 0, minute: 0, second: 0 }, timeZone);
          kind = 'local_date';
        } else {
          const timeOnly = parseLocalTime(text);
          if (!timeOnly) throw valueError(`invalid time: ${text}`);
          const today = zonedParts(nowMs, timeZone);
          let local = { year: today.year, month: today.month, day: today.day, ...timeOnly };
          epochMs = localPartsToEpoch(local, timeZone);
          if (preferFuture && epochMs <= nowMs) {
            const tomorrow = addLocalDays(local, 1);
            epochMs = localPartsToEpoch(tomorrow, timeZone);
          }
          kind = 'time_of_day';
        }
      }
    }
  }

  return {
    epoch_ms: epochMs,
    iso: new Date(epochMs).toISOString(),
    in_seconds: Math.round((epochMs - nowMs) / 1000),
    kind,
    local: timeSnapshot({ now: epochMs, timeZone }).local,
    time_zone: timeZone,
  };
}

/**
 * Return the next valid wall-clock occurrence for a recurring alarm.
 *
 * Calendar days are evaluated in the requested timezone, so weekday filters
 * and daylight-saving changes never degrade into 24-hour millisecond math. A
 * nonexistent spring-forward wall time is skipped; it is never shifted or
 * retried as an already-overdue occurrence.
 */
export function nextAlarmOccurrence({
  after = Date.now(),
  wallTime,
  timeZone = systemTimeZone(),
  repeat = 'daily',
  days = [],
  weekday,
} = {}) {
  const afterMs = epochValue(after, 'after');
  const time = parseLocalTime(String(wallTime ?? '').trim());
  if (!time) throw valueError(`invalid alarm wall time: ${String(wallTime ?? '')}`);
  if (!['daily', 'weekdays', 'weekly'].includes(repeat)) {
    throw valueError('recurring alarm repeat must be daily, weekdays, or weekly');
  }
  const wanted = new Set((Array.isArray(days) ? days : []).map((day) => String(day).toLowerCase()));
  if (repeat === 'weekdays') {
    for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) wanted.add(day);
  } else if (repeat === 'weekly' && wanted.size === 0 && weekday) {
    wanted.add(String(weekday).toLowerCase());
  }
  if (repeat === 'weekly' && wanted.size === 0) throw valueError('weekly alarms need a weekday or days');

  const base = zonedParts(afterMs, timeZone);
  for (let offset = 0; offset < 15; offset += 1) {
    const local = addLocalDays({ ...base, ...time }, offset);
    let candidate;
    try {
      candidate = localPartsToEpoch(local, timeZone);
    } catch (error) {
      if (/does not exist.*daylight-saving/i.test(error.message)) continue;
      throw error;
    }
    if (candidate <= afterMs) continue;
    if (repeat === 'daily') return candidate;
    const candidateWeekday = zonedParts(candidate, timeZone).weekday.toLowerCase();
    if (wanted.has(candidateWeekday)) return candidate;
  }
  throw valueError(`could not calculate the next ${repeat} alarm occurrence`);
}

/** Parse a deterministic duration. Numeric values are seconds. */
export function parseDuration(value, { minimumMs = 0, maximumMs = 365 * 86_400_000 } = {}) {
  let milliseconds;
  if (typeof value === 'number') {
    milliseconds = finiteNumber(value, 'duration') * 1000;
  } else if (isPlainObject(value)) {
    const allowed = new Set(['days', 'hours', 'minutes', 'seconds', 'milliseconds']);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw valueError(`unknown duration field: ${key}`);
    }
    milliseconds =
      finiteNumber(value.days ?? 0, 'duration.days') * 86_400_000 +
      finiteNumber(value.hours ?? 0, 'duration.hours') * 3_600_000 +
      finiteNumber(value.minutes ?? 0, 'duration.minutes') * 60_000 +
      finiteNumber(value.seconds ?? 0, 'duration.seconds') * 1000 +
      finiteNumber(value.milliseconds ?? 0, 'duration.milliseconds');
  } else {
    const text = String(value ?? '').trim();
    if (!text) throw valueError('duration is required');
    milliseconds = parseIsoDuration(text) ?? parseUnitDuration(text) ?? parseClockDuration(text);
    if (milliseconds == null) throw valueError(`invalid duration: ${text}`);
  }

  if (!Number.isFinite(milliseconds) || milliseconds < minimumMs || milliseconds > maximumMs) {
    throw valueError(`duration must be between ${minimumMs}ms and ${maximumMs}ms`);
  }
  return Math.round(milliseconds);
}

/** Count the visible size of a supported collection. Strings count Unicode characters. */
export function collectionSize(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Array.from(value).length;
  if (Array.isArray(value)) return value.length;
  if (value instanceof Set || value instanceof Map) return value.size;
  if (isPlainObject(value)) return Object.keys(value).length;
  throw valueError('count requires an array, object, set, map, string, or null');
}

/** Count non-overlapping string or array occurrences. */
export function countOccurrences(collection, needle, { caseSensitive = false } = {}) {
  if (typeof collection === 'string') {
    let haystack = collection;
    let target = String(needle ?? '');
    if (!target) throw valueError('count needle cannot be empty');
    if (!caseSensitive) {
      haystack = haystack.toLocaleLowerCase();
      target = target.toLocaleLowerCase();
    }
    let count = 0;
    let cursor = 0;
    while ((cursor = haystack.indexOf(target, cursor)) >= 0) {
      count++;
      cursor += target.length;
    }
    return count;
  }
  if (!Array.isArray(collection)) throw valueError('occurrence count requires a string or array');
  return collection.reduce((count, item) => count + (valuesEqual(item, needle, caseSensitive) ? 1 : 0), 0);
}

/**
 * Count array/object values matching a small declarative predicate. `path`
 * uses own-properties only, so a rule cannot traverse prototypes.
 */
export function countMatching(collection, {
  operator = 'truthy',
  value,
  path = '',
  caseSensitive = false,
} = {}) {
  const items = Array.isArray(collection)
    ? collection
    : isPlainObject(collection)
      ? Object.values(collection)
      : null;
  if (!items) throw valueError('matching count requires an array or object');
  return items.reduce((count, item) => {
    const actual = path ? ownPath(item, path) : item;
    return count + (matchesCount(actual, operator, value, caseSensitive) ? 1 : 0);
  }, 0);
}

/** Turn HA weather state/service-response payloads into a stable value shape. */
export function shapeWeatherState(state, forecastInput = [], { forecastType = 'daily', limit = 12, now = Date.now() } = {}) {
  if (!state || typeof state !== 'object' || !String(state.entity_id || '').startsWith('weather.')) {
    throw valueError('weather state must be a Home Assistant weather entity');
  }
  if (state.state === 'unknown' || state.state === 'unavailable') {
    throw valueError(`weather entity is ${state.state}`, 'weather_unavailable');
  }
  if (!['daily', 'hourly', 'twice_daily'].includes(forecastType)) {
    throw valueError('forecast type must be daily, hourly, or twice_daily');
  }
  const safeLimit = integerInRange(limit, 0, 48, 'weather forecast limit');
  const attributes = state.attributes || {};
  const forecast = extractForecast(forecastInput, state.entity_id).slice(0, safeLimit).map(shapeForecastEntry);
  const changedAt = Date.parse(state.last_changed || state.last_updated || '');
  const nowMs = epochValue(now, 'now');

  return omitUndefined({
    entity_id: state.entity_id,
    name: attributes.friendly_name || state.entity_id,
    condition: state.state,
    updated_at: Number.isFinite(changedAt) ? new Date(changedAt).toISOString() : undefined,
    age_seconds: Number.isFinite(changedAt) ? Math.max(0, Math.round((nowMs - changedAt) / 1000)) : undefined,
    current: omitUndefined({
      temperature: finiteOrUndefined(attributes.temperature),
      apparent_temperature: finiteOrUndefined(attributes.apparent_temperature),
      temperature_low: finiteOrUndefined(attributes.templow),
      humidity: finiteOrUndefined(attributes.humidity),
      dew_point: finiteOrUndefined(attributes.dew_point),
      pressure: finiteOrUndefined(attributes.pressure),
      wind_speed: finiteOrUndefined(attributes.wind_speed),
      wind_bearing: finiteOrUndefined(attributes.wind_bearing),
      visibility: finiteOrUndefined(attributes.visibility),
      cloud_coverage: finiteOrUndefined(attributes.cloud_coverage),
      uv_index: finiteOrUndefined(attributes.uv_index),
      precipitation: finiteOrUndefined(attributes.precipitation),
    }),
    units: omitUndefined({
      temperature: attributes.temperature_unit,
      pressure: attributes.pressure_unit,
      wind_speed: attributes.wind_speed_unit,
      visibility: attributes.visibility_unit,
      precipitation: attributes.precipitation_unit,
    }),
    forecast_type: forecastType,
    forecast,
    attribution: attributes.attribution,
  });
}

/**
 * Build the only HA call the speech tool needs. Target and provider allowlists
 * are optional here for previews, but the runtime should always provide them.
 */
export function planTtsCall({
  tts_entity_id,
  media_player_entity_id,
  message,
  cache = true,
  language,
}, {
  availableEntities,
  allowedMediaPlayers,
  maxChars = 500,
} = {}) {
  const provider = String(tts_entity_id || '').trim();
  const target = String(media_player_entity_id || '').trim();
  if (!provider.startsWith('tts.')) throw valueError('tts_entity_id must be a tts entity');
  if (!target.startsWith('media_player.')) throw valueError('media_player_entity_id must be a media_player entity');
  assertListed(provider, availableEntities, 'TTS provider is not available');
  assertListed(target, availableEntities, 'TTS target is not available');
  assertListed(target, allowedMediaPlayers, 'TTS target is not selected for control');
  if (typeof cache !== 'boolean') throw valueError('TTS cache must be true or false');
  const limit = integerInRange(maxChars, 1, 2_000, 'TTS maximum length');
  const spoken = sanitizeSpeech(message);
  if (!spoken) throw valueError('TTS message is required');
  if (spoken.length > limit) throw valueError(`TTS message cannot exceed ${limit} characters`);
  if (language !== undefined && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(String(language))) {
    throw valueError('TTS language must be a language tag such as en or en-US');
  }

  return {
    domain: 'tts',
    service: 'speak',
    data: omitUndefined({
      entity_id: provider,
      media_player_entity_id: target,
      message: spoken,
      cache,
      language: language === undefined ? undefined : String(language),
    }),
  };
}

/* ── math parser ────────────────────────────────────────────── */

class MathParser {
  constructor(tokens, variables) {
    this.tokens = tokens;
    this.variables = variables;
    this.position = 0;
    this.depth = 0;
  }

  parse() {
    const result = this.expression(0);
    if (this.peek().type !== 'eof') throw valueError(`unexpected token "${this.peek().value}"`);
    return result;
  }

  expression(minimumPrecedence) {
    if (++this.depth > MAX_MATH_DEPTH) throw valueError('math expression is nested too deeply');
    let left = this.prefix();
    while (this.peek().type === 'operator') {
      const operator = this.peek().value;
      const precedence = { '+': 10, '-': 10, '*': 20, '/': 20, '%': 20, '^': 30 }[operator];
      if (precedence === undefined || precedence < minimumPrecedence) break;
      this.take();
      const right = this.expression(operator === '^' ? precedence : precedence + 1);
      left = applyBinary(operator, left, right);
    }
    this.depth--;
    return finiteResult(left);
  }

  prefix() {
    const token = this.take();
    if (token.type === 'number') return token.value;
    if (token.type === 'operator' && (token.value === '+' || token.value === '-')) {
      const value = this.expression(25);
      return token.value === '-' ? -value : value;
    }
    if (token.type === 'left') {
      const value = this.expression(0);
      this.expect('right');
      return value;
    }
    if (token.type === 'identifier') {
      if (this.peek().type === 'left') return this.functionCall(token.value);
      if (token.value === 'pi') return Math.PI;
      if (token.value === 'e') return Math.E;
      if (!Object.hasOwn(this.variables, token.value)) throw valueError(`unknown math variable: ${token.value}`);
      return finiteNumber(this.variables[token.value], `math variable ${token.value}`);
    }
    throw valueError(`expected a number, variable, or parenthesis; got "${token.value}"`);
  }

  functionCall(name) {
    const fn = MATH_FUNCTIONS[name.toLowerCase()];
    if (!fn) throw valueError(`unknown math function: ${name}`);
    this.expect('left');
    const args = [];
    if (this.peek().type !== 'right') {
      do {
        args.push(this.expression(0));
        if (args.length > MAX_MATH_OPERANDS) throw valueError(`math functions accept at most ${MAX_MATH_OPERANDS} values`);
      } while (this.maybe('comma'));
    }
    this.expect('right');
    return finiteResult(fn(...args));
  }

  peek() {
    return this.tokens[this.position];
  }

  take() {
    return this.tokens[this.position++];
  }

  maybe(type) {
    if (this.peek().type !== type) return false;
    this.take();
    return true;
  }

  expect(type) {
    const token = this.take();
    if (token.type !== type) throw valueError(`expected ${type}; got "${token.value}"`);
    return token;
  }
}

function tokenizeMath(source) {
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    const rest = source.slice(cursor);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) {
      cursor += whitespace[0].length;
      continue;
    }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw valueError(`invalid number: ${number[0]}`);
      tokens.push({ type: 'number', value });
      cursor += number[0].length;
    } else {
      const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
      if (identifier) {
        tokens.push({ type: 'identifier', value: identifier[0] });
        cursor += identifier[0].length;
      } else {
        const char = source[cursor++];
        const type = '+-*/%^'.includes(char)
          ? 'operator'
          : char === '('
            ? 'left'
            : char === ')'
              ? 'right'
              : char === ','
                ? 'comma'
                : null;
        if (!type) throw valueError(`unsupported math token: ${char}`);
        tokens.push({ type, value: char });
      }
    }
    if (tokens.length > MAX_MATH_TOKENS) throw valueError(`math expression allows at most ${MAX_MATH_TOKENS} tokens`);
  }
  tokens.push({ type: 'eof', value: 'end of expression' });
  return tokens;
}

function applyBinary(operator, left, right) {
  if ((operator === '/' || operator === '%') && right === 0) {
    throw valueError(operator === '/' ? 'division by zero is not allowed' : 'modulo by zero is not allowed');
  }
  return {
    '+': () => left + right,
    '-': () => left - right,
    '*': () => left * right,
    '/': () => left / right,
    '%': () => left % right,
    '^': () => left ** right,
  }[operator]();
}

/* ── time parsing ───────────────────────────────────────────── */

function zonedParts(epochMs, timeZone) {
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: values.weekday,
  };
}

function zonedOffsetMinutes(epochMs, timeZone) {
  const parts = zonedParts(epochMs, timeZone);
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((representedAsUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

function localPartsToEpoch(parts, timeZone) {
  validateLocalParts(parts);
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = target;
  for (let pass = 0; pass < 4; pass++) {
    const actual = zonedParts(guess, timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = target - represented;
    guess += delta;
    if (delta === 0) break;
  }
  const final = zonedParts(guess, timeZone);
  if (!sameLocalParts(final, parts)) {
    throw valueError('that local time does not exist in the selected timezone (daylight-saving transition)');
  }
  return guess;
}

function parseLocalDateTime(text) {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };
}

function parseLocalDate(text) {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

function parseLocalTime(text) {
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const second = Number(match[3] || 0);
  const meridiem = match[4]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function validateLocalParts(parts) {
  const values = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) => Number(parts[key]));
  if (!values.every(Number.isInteger)) throw valueError('local date/time must contain whole-number fields');
  const [year, month, day, hour, minute, second] = values;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    year < 1970 || year > 9999 ||
    check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second
  ) {
    throw valueError('invalid local date/time');
  }
}

function parseIsoDuration(text) {
  const match = text.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match || !match.slice(1).some((value) => value !== undefined)) return null;
  return Number(match[1] || 0) * 86_400_000 + Number(match[2] || 0) * 3_600_000 + Number(match[3] || 0) * 60_000 + Number(match[4] || 0) * 1000;
}

function parseUnitDuration(text) {
  // Longest/most-specific `m...` forms come first so "500ms" cannot be
  // consumed as "500m" with a stray trailing "s".
  const re = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|d(?:ays?)?|h(?:ours?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)/gi;
  const units = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  let total = 0;
  let cursor = 0;
  let found = false;
  for (const match of text.matchAll(re)) {
    if (text.slice(cursor, match.index).trim()) return null;
    const unit = match[2].toLowerCase();
    const canonical = unit.startsWith('d') ? 'd' : unit.startsWith('h') ? 'h' : unit === 'ms' || unit.startsWith('milli') ? 'ms' : unit.startsWith('m') ? 'm' : 's';
    total += Number(match[1]) * units[canonical];
    cursor = match.index + match[0].length;
    found = true;
  }
  return found && !text.slice(cursor).trim() ? total : null;
}

function parseClockDuration(text) {
  const match = text.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null;
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1000;
}

/* ── collection/weather/TTS helpers ─────────────────────────── */

function matchesCount(actual, operator, expected, caseSensitive) {
  switch (operator) {
    case 'truthy': return Boolean(actual);
    case 'falsy': return !actual;
    case 'equals': return valuesEqual(actual, expected, caseSensitive);
    case 'not_equals': return !valuesEqual(actual, expected, caseSensitive);
    case 'contains':
      if (typeof actual === 'string') {
        const left = caseSensitive ? actual : actual.toLocaleLowerCase();
        const right = caseSensitive ? String(expected ?? '') : String(expected ?? '').toLocaleLowerCase();
        return left.includes(right);
      }
      if (Array.isArray(actual)) return actual.some((item) => valuesEqual(item, expected, caseSensitive));
      return false;
    case 'greater_than': return comparableNumber(actual) > comparableNumber(expected);
    case 'greater_than_or_equal': return comparableNumber(actual) >= comparableNumber(expected);
    case 'less_than': return comparableNumber(actual) < comparableNumber(expected);
    case 'less_than_or_equal': return comparableNumber(actual) <= comparableNumber(expected);
    default: throw valueError(`unsupported count operator: ${operator}`);
  }
}

function ownPath(value, path) {
  const segments = String(path).split('.').filter(Boolean);
  if (!segments.length || segments.length > 12) throw valueError('count path must contain 1-12 segments');
  let current = value;
  for (const segment of segments) {
    if (['__proto__', 'prototype', 'constructor'].includes(segment)) throw valueError('unsafe count path');
    if (current == null || (typeof current !== 'object' && typeof current !== 'string') || !Object.hasOwn(Object(current), segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function valuesEqual(left, right, caseSensitive) {
  if (!caseSensitive && typeof left === 'string' && typeof right === 'string') {
    return left.toLocaleLowerCase() === right.toLocaleLowerCase();
  }
  return Object.is(left, right);
}

function comparableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function extractForecast(input, entityId) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input.forecast)) return input.forecast;
  const service = input.service_response || input;
  return Array.isArray(service?.[entityId]?.forecast) ? service[entityId].forecast : [];
}

function shapeForecastEntry(entry) {
  const value = entry && typeof entry === 'object' ? entry : {};
  return omitUndefined({
    datetime: value.datetime,
    condition: value.condition,
    temperature: finiteOrUndefined(value.temperature),
    temperature_low: finiteOrUndefined(value.templow ?? value.temperature_low),
    apparent_temperature: finiteOrUndefined(value.apparent_temperature),
    humidity: finiteOrUndefined(value.humidity),
    precipitation: finiteOrUndefined(value.precipitation),
    precipitation_probability: finiteOrUndefined(value.precipitation_probability),
    wind_speed: finiteOrUndefined(value.wind_speed),
    wind_bearing: finiteOrUndefined(value.wind_bearing),
    cloud_coverage: finiteOrUndefined(value.cloud_coverage),
    uv_index: finiteOrUndefined(value.uv_index),
  });
}

function sanitizeSpeech(message) {
  if (typeof message !== 'string') return '';
  return message
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertListed(value, list, message) {
  if (list == null) return;
  const allowed = list instanceof Set ? list : new Set(list);
  if (!allowed.has(value)) throw valueError(`${message}: ${value}`);
}

/* ── shared primitives ──────────────────────────────────────── */

function valueError(message, code) {
  return new AutomationValueError(message, code);
}

function finiteNumber(value, label) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw valueError(`${label} must be a finite number`);
  return number;
}

function finiteResult(value) {
  if (!Number.isFinite(value)) throw valueError('math result is not finite');
  return Object.is(value, -0) ? 0 : value;
}

function finiteOrUndefined(value) {
  if (value === '' || value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw valueError(`${label} must be a whole number between ${minimum} and ${maximum}`);
  }
  return number;
}

function epochValue(value, label) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw valueError(`${label} must be a valid timestamp`);
  return Math.trunc(milliseconds);
}

function unary(fn) {
  return (...args) => {
    arity('function', args, 1, 1);
    return fn(args[0]);
  };
}

function binary(fn) {
  return (...args) => {
    arity('function', args, 2, 2);
    return fn(args[0], args[1]);
  };
}

function variadic(name, fn) {
  return (...args) => {
    arity(name, args, 1, MAX_MATH_OPERANDS);
    return fn(...args);
  };
}

function arity(name, args, minimum, maximum) {
  if (args.length < minimum || args.length > maximum) {
    const wanted = minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
    throw valueError(`${name} expects ${wanted} argument${maximum === 1 ? '' : 's'}`);
  }
}

function atLeast(name, values, minimum) {
  if (values.length < minimum) throw valueError(`${name} requires at least ${minimum} operands`);
}

function exactly(name, values, count) {
  if (values.length !== count) throw valueError(`${name} requires exactly ${count} operand${count === 1 ? '' : 's'}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw valueError(`invalid timezone: ${timeZone}`);
  }
}

function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function hasExplicitOffset(text) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
}

function sameLocalParts(left, right) {
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].every((key) => Number(left[key]) === Number(right[key]));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}
