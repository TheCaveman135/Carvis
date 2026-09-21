import { isDeepStrictEqual } from 'node:util';

export const RULE_SCHEMA_VERSION = 1;

export const VALUE_NAMESPACES = Object.freeze([
  'time',
  'ha',
  'atlas',
  'timer',
  'location',
  'carvis',
  'memory',
  'variable',
]);

export const OPERATORS = Object.freeze([
  'equals',
  'not_equals',
  'changed_to',
  'changed_from',
  'greater_than',
  'less_than',
  'contains',
  'for_duration',
  'within',
  'has_been',
  'hasnt_happened',
]);

export const ACTION_TYPES = Object.freeze([
  'tool.call',
  'variable.set',
  'timer.start',
  'timer.cancel',
  'rule.enable',
  'rule.disable',
  'carvis.wake',
  'speech.say',
]);

export const ACTION_PREFIXES = Object.freeze(['hud.']);

export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxConditions: 256,
  maxActions: 64,
  maxTemplateNodes: 1024,
  maxArrayLength: 256,
  maxObjectKeys: 128,
  maxStringLength: 8_192,
  maxErrors: 100,
});

const TEMPORAL_OPERATORS = new Set([
  'changed_to',
  'changed_from',
  'for_duration',
  'within',
  'has_been',
  'hasnt_happened',
]);

const BINARY_OPERATORS = new Set([
  'equals',
  'not_equals',
  'changed_to',
  'changed_from',
  'greater_than',
  'less_than',
  'contains',
  'for_duration',
  'has_been',
]);

const HISTORY_METHODS = Object.freeze({
  changed_to: 'changedTo',
  changed_from: 'changedFrom',
  for_duration: 'forDuration',
  within: 'within',
  has_been: 'hasBeen',
  hasnt_happened: 'hasntHappened',
});

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export class RuleValidationError extends Error {
  constructor(errors) {
    const first = errors?.[0];
    super(first ? `${first.path}: ${first.message}` : 'Invalid Carvis rule');
    this.name = 'RuleValidationError';
    this.errors = errors ?? [];
  }
}

export class RuleEvaluationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RuleEvaluationError';
    Object.assign(this, details);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionList(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) || value instanceof Set) return [...value];
  return Object.keys(value);
}

function normalizedOptions(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) limits[name] = fallback;
  }

  return {
    limits,
    namespaces: new Set([...VALUE_NAMESPACES, ...optionList(options.valueNamespaces)]),
    operators: new Set([...OPERATORS, ...optionList(options.operators)]),
    actionTypes: new Set([...ACTION_TYPES, ...optionList(options.actionTypes)]),
    actionPrefixes: [...ACTION_PREFIXES, ...optionList(options.actionPrefixes)],
    operatorValidators: options.operatorValidators ?? {},
    actionValidators: options.actionValidators ?? {},
  };
}

function stateFor(options) {
  return {
    options: normalizedOptions(options),
    errors: [],
    conditions: 0,
    actions: 0,
    templateNodes: 0,
    ancestors: new WeakSet(),
    stopped: false,
  };
}

function addError(state, path, code, message) {
  if (state.stopped) return;
  state.errors.push({ path, code, message });
  if (state.errors.length >= state.options.limits.maxErrors) {
    state.errors.push({
      path: '$',
      code: 'too_many_errors',
      message: `Validation stopped after ${state.options.limits.maxErrors} errors`,
    });
    state.stopped = true;
  }
}

function enterObject(value, path, state) {
  if (state.ancestors.has(value)) {
    addError(state, path, 'cyclic', 'Cyclic values are not allowed');
    return false;
  }
  state.ancestors.add(value);
  return true;
}

function allowedKeys(value, allowed, path, state) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(state, `${path}.${key}`, 'unknown_key', `Unknown property "${key}"`);
  }
}

function validateText(value, path, state, { required = true, pattern } = {}) {
  if (typeof value !== 'string') {
    addError(state, path, 'type', 'Expected a string');
    return;
  }
  if (required && value.trim().length === 0) addError(state, path, 'empty', 'Must not be empty');
  if (value.length > state.options.limits.maxStringLength) {
    addError(state, path, 'string_too_long', `Must be at most ${state.options.limits.maxStringLength} characters`);
  }
  if (pattern && !pattern.test(value)) addError(state, path, 'format', 'Contains unsupported characters');
}

function validatePositiveDuration(value, path, state) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    addError(state, path, 'duration', 'Expected a positive integer number of milliseconds');
  }
}

function validateJson(value, path, state, depth = 0) {
  if (state.stopped) return;
  state.templateNodes += 1;
  if (state.templateNodes > state.options.limits.maxTemplateNodes) {
    addError(state, path, 'too_many_values', `Rule exceeds ${state.options.limits.maxTemplateNodes} data nodes`);
    return;
  }
  if (depth > state.options.limits.maxDepth) {
    addError(state, path, 'too_deep', `Data exceeds maximum depth ${state.options.limits.maxDepth}`);
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    validateText(value, path, state, { required: false });
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) addError(state, path, 'number', 'Numbers must be finite');
    return;
  }
  if (Array.isArray(value)) {
    if (!enterObject(value, path, state)) return;
    if (value.length > state.options.limits.maxArrayLength) {
      addError(state, path, 'array_too_long', `Array exceeds ${state.options.limits.maxArrayLength} items`);
    }
    for (let index = 0; index < value.length && !state.stopped; index += 1) {
      validateJson(value[index], `${path}[${index}]`, state, depth + 1);
    }
    state.ancestors.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    addError(state, path, 'json_type', 'Expected a JSON-compatible value');
    return;
  }
  if (!enterObject(value, path, state)) return;
  const keys = Object.keys(value);
  if (keys.length > state.options.limits.maxObjectKeys) {
    addError(state, path, 'object_too_large', `Object exceeds ${state.options.limits.maxObjectKeys} properties`);
  }
  for (const key of keys) {
    validateText(key, `${path}.{key}`, state, { required: true });
    validateJson(value[key], `${path}.${key}`, state, depth + 1);
    if (state.stopped) break;
  }
  state.ancestors.delete(value);
}

function refNamespace(ref) {
  const separator = ref.indexOf('.');
  return separator === -1 ? '' : ref.slice(0, separator);
}

function validateValue(value, path, state, depth = 0) {
  if (depth > state.options.limits.maxDepth) {
    addError(state, path, 'too_deep', `Value exceeds maximum depth ${state.options.limits.maxDepth}`);
    return;
  }
  if (!isPlainObject(value)) {
    addError(state, path, 'value_node', 'Expected { ref: "namespace.path" } or { literal: value }');
    return;
  }
  if (!enterObject(value, path, state)) return;
  const hasRef = Object.hasOwn(value, 'ref');
  const hasLiteral = Object.hasOwn(value, 'literal');
  if (hasRef === hasLiteral) {
    addError(state, path, 'value_node', 'Value must contain exactly one of ref or literal');
    state.ancestors.delete(value);
    return;
  }
  allowedKeys(value, new Set(hasRef ? ['ref'] : ['literal']), path, state);
  if (hasRef) {
    validateText(value.ref, `${path}.ref`, state, { pattern: IDENTIFIER_RE });
    if (typeof value.ref === 'string') {
      const namespace = refNamespace(value.ref);
      if (!namespace || !state.options.namespaces.has(namespace)) {
        addError(
          state,
          `${path}.ref`,
          'namespace',
          `Unsupported value namespace "${namespace || value.ref}"`,
        );
      }
    }
  } else {
    validateJson(value.literal, `${path}.literal`, state, depth + 1);
  }
  state.ancestors.delete(value);
}

function validateTemplate(value, path, state, depth = 0) {
  if (state.stopped) return;
  if (depth > state.options.limits.maxDepth) {
    addError(state, path, 'too_deep', `Action data exceeds maximum depth ${state.options.limits.maxDepth}`);
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if ((keys.length === 1 && keys[0] === 'ref') || (keys.length === 1 && keys[0] === 'literal')) {
      validateValue(value, path, state, depth);
      return;
    }
  }
  validateJsonTemplateNode(value, path, state, depth);
}

function validateJsonTemplateNode(value, path, state, depth) {
  state.templateNodes += 1;
  if (state.templateNodes > state.options.limits.maxTemplateNodes) {
    addError(state, path, 'too_many_values', `Rule exceeds ${state.options.limits.maxTemplateNodes} action data nodes`);
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    validateText(value, path, state, { required: false });
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) addError(state, path, 'number', 'Numbers must be finite');
    return;
  }
  if (Array.isArray(value)) {
    if (!enterObject(value, path, state)) return;
    if (value.length > state.options.limits.maxArrayLength) {
      addError(state, path, 'array_too_long', `Array exceeds ${state.options.limits.maxArrayLength} items`);
    }
    for (let index = 0; index < value.length && !state.stopped; index += 1) {
      validateTemplate(value[index], `${path}[${index}]`, state, depth + 1);
    }
    state.ancestors.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    addError(state, path, 'json_type', 'Expected JSON data or a value reference');
    return;
  }
  if (!enterObject(value, path, state)) return;
  const keys = Object.keys(value);
  if (keys.length > state.options.limits.maxObjectKeys) {
    addError(state, path, 'object_too_large', `Object exceeds ${state.options.limits.maxObjectKeys} properties`);
  }
  for (const key of keys) {
    validateTemplate(value[key], `${path}.${key}`, state, depth + 1);
    if (state.stopped) break;
  }
  state.ancestors.delete(value);
}

function validateCondition(condition, path, state, depth = 0) {
  if (state.stopped) return;
  state.conditions += 1;
  if (state.conditions > state.options.limits.maxConditions) {
    addError(state, path, 'too_many_conditions', `Rule exceeds ${state.options.limits.maxConditions} conditions`);
    return;
  }
  if (depth > state.options.limits.maxDepth) {
    addError(state, path, 'too_deep', `Condition exceeds maximum depth ${state.options.limits.maxDepth}`);
    return;
  }
  if (!isPlainObject(condition)) {
    addError(state, path, 'condition', 'Expected a condition object');
    return;
  }
  if (!enterObject(condition, path, state)) return;

  const structural = ['all', 'any', 'not', 'op'].filter((key) => Object.hasOwn(condition, key));
  if (structural.length !== 1) {
    addError(state, path, 'condition_shape', 'Condition must contain exactly one of all, any, not, or op');
    state.ancestors.delete(condition);
    return;
  }

  const kind = structural[0];
  if (kind === 'all' || kind === 'any') {
    allowedKeys(condition, new Set([kind, 'label']), path, state);
    if (!Array.isArray(condition[kind]) || condition[kind].length === 0) {
      addError(state, `${path}.${kind}`, 'condition_group', `${kind.toUpperCase()} requires at least one condition`);
    } else {
      if (condition[kind].length > state.options.limits.maxConditions) {
        addError(state, `${path}.${kind}`, 'too_many_conditions', 'Condition group is too large');
      }
      for (let index = 0; index < condition[kind].length && !state.stopped; index += 1) {
        validateCondition(condition[kind][index], `${path}.${kind}[${index}]`, state, depth + 1);
      }
    }
  } else if (kind === 'not') {
    allowedKeys(condition, new Set(['not', 'label']), path, state);
    validateCondition(condition.not, `${path}.not`, state, depth + 1);
  } else {
    validateComparison(condition, path, state, depth);
  }

  if (Object.hasOwn(condition, 'label')) validateText(condition.label, `${path}.label`, state);
  state.ancestors.delete(condition);
}

function validateComparison(condition, path, state, depth) {
  allowedKeys(
    condition,
    new Set(['op', 'left', 'right', 'durationMs', 'withinMs', 'label']),
    path,
    state,
  );
  if (typeof condition.op !== 'string' || !state.options.operators.has(condition.op)) {
    addError(state, `${path}.op`, 'operator', `Unsupported operator "${String(condition.op)}"`);
    return;
  }
  if (!Object.hasOwn(condition, 'left')) {
    addError(state, `${path}.left`, 'required', 'Comparison requires a left value');
  } else {
    validateValue(condition.left, `${path}.left`, state, depth + 1);
  }

  const rightRequired = BINARY_OPERATORS.has(condition.op);
  if (rightRequired && !Object.hasOwn(condition, 'right')) {
    addError(state, `${path}.right`, 'required', `${condition.op} requires a right value`);
  } else if (Object.hasOwn(condition, 'right')) {
    validateValue(condition.right, `${path}.right`, state, depth + 1);
  }

  if (TEMPORAL_OPERATORS.has(condition.op) && (!isPlainObject(condition.left) || typeof condition.left.ref !== 'string')) {
    addError(state, `${path}.left`, 'temporal_ref', `${condition.op} requires a reference on the left`);
  }
  if (condition.op === 'for_duration' || condition.op === 'has_been') {
    if (!Object.hasOwn(condition, 'durationMs')) {
      addError(state, `${path}.durationMs`, 'required', `${condition.op} requires durationMs`);
    } else {
      validatePositiveDuration(condition.durationMs, `${path}.durationMs`, state);
    }
  } else if (Object.hasOwn(condition, 'durationMs')) {
    addError(state, `${path}.durationMs`, 'unsupported', `durationMs is not valid for ${condition.op}`);
  }
  if (condition.op === 'within' || condition.op === 'hasnt_happened') {
    if (!Object.hasOwn(condition, 'withinMs')) {
      addError(state, `${path}.withinMs`, 'required', `${condition.op} requires withinMs`);
    } else {
      validatePositiveDuration(condition.withinMs, `${path}.withinMs`, state);
    }
  } else if (Object.hasOwn(condition, 'withinMs')) {
    addError(state, `${path}.withinMs`, 'unsupported', `withinMs is not valid for ${condition.op}`);
  }

  const customValidator = state.options.operatorValidators[condition.op];
  if (typeof customValidator === 'function') {
    try {
      const problem = customValidator(condition);
      if (typeof problem === 'string' && problem) addError(state, path, 'custom_operator', problem);
      if (Array.isArray(problem)) {
        for (const message of problem) addError(state, path, 'custom_operator', String(message));
      }
    } catch (error) {
      addError(state, path, 'custom_operator', `Operator validator failed: ${error.message}`);
    }
  }
}

function isKnownActionType(type, options) {
  return options.actionTypes.has(type)
    || options.actionPrefixes.some((prefix) => type.startsWith(prefix) && type.length > prefix.length);
}

function validateAction(action, path, state) {
  if (state.stopped) return;
  state.actions += 1;
  if (state.actions > state.options.limits.maxActions) {
    addError(state, path, 'too_many_actions', `Rule exceeds ${state.options.limits.maxActions} actions`);
    return;
  }
  if (!isPlainObject(action)) {
    addError(state, path, 'action', 'Expected an action object');
    return;
  }
  if (!enterObject(action, path, state)) return;
  const type = action.type;
  if (typeof type !== 'string' || !isKnownActionType(type, state.options)) {
    addError(state, `${path}.type`, 'action_type', `Unsupported action type "${String(type)}"`);
    state.ancestors.delete(action);
    return;
  }
  validateText(type, `${path}.type`, state, { pattern: IDENTIFIER_RE });

  const common = ['type', 'label'];
  if (type === 'tool.call') {
    allowedKeys(action, new Set([...common, 'tool', 'arguments']), path, state);
    validateText(action.tool, `${path}.tool`, state, { pattern: IDENTIFIER_RE });
    if (Object.hasOwn(action, 'arguments')) validateTemplate(action.arguments, `${path}.arguments`, state);
  } else if (type === 'variable.set') {
    allowedKeys(action, new Set([...common, 'name', 'value']), path, state);
    validateText(action.name, `${path}.name`, state, { pattern: NAME_RE });
    if (!Object.hasOwn(action, 'value')) addError(state, `${path}.value`, 'required', 'variable.set requires value');
    else validateValue(action.value, `${path}.value`, state);
  } else if (type === 'timer.start') {
    allowedKeys(action, new Set([...common, 'timer', 'durationMs', 'payload']), path, state);
    validateText(action.timer, `${path}.timer`, state, { pattern: NAME_RE });
    if (!Object.hasOwn(action, 'durationMs')) addError(state, `${path}.durationMs`, 'required', 'timer.start requires durationMs');
    else validateValue(action.durationMs, `${path}.durationMs`, state);
    if (Object.hasOwn(action, 'payload')) validateTemplate(action.payload, `${path}.payload`, state);
  } else if (type === 'timer.cancel') {
    allowedKeys(action, new Set([...common, 'timer']), path, state);
    validateText(action.timer, `${path}.timer`, state, { pattern: NAME_RE });
  } else if (type === 'rule.enable' || type === 'rule.disable') {
    allowedKeys(action, new Set([...common, 'ruleId']), path, state);
    validateText(action.ruleId, `${path}.ruleId`, state, { pattern: IDENTIFIER_RE });
  } else if (type === 'carvis.wake') {
    allowedKeys(action, new Set([...common, 'prompt', 'trigger']), path, state);
    if (!Object.hasOwn(action, 'prompt')) addError(state, `${path}.prompt`, 'required', 'carvis.wake requires prompt');
    else validateValue(action.prompt, `${path}.prompt`, state);
    if (Object.hasOwn(action, 'trigger')) validateText(action.trigger, `${path}.trigger`, state);
  } else if (type === 'speech.say') {
    allowedKeys(action, new Set([...common, 'text', 'voice', 'media_player', 'tts_entity', 'language', 'cache']), path, state);
    if (!Object.hasOwn(action, 'text')) addError(state, `${path}.text`, 'required', 'speech.say requires text');
    else validateValue(action.text, `${path}.text`, state);
    if (Object.hasOwn(action, 'voice')) validateText(action.voice, `${path}.voice`, state);
    if (Object.hasOwn(action, 'media_player')) validateText(action.media_player, `${path}.media_player`, state, { pattern: IDENTIFIER_RE });
    if (Object.hasOwn(action, 'tts_entity')) validateText(action.tts_entity, `${path}.tts_entity`, state, { pattern: IDENTIFIER_RE });
    if (Object.hasOwn(action, 'language')) validateText(action.language, `${path}.language`, state);
    if (Object.hasOwn(action, 'cache') && typeof action.cache !== 'boolean') addError(state, `${path}.cache`, 'type', 'cache must be a boolean');
  } else {
    allowedKeys(action, new Set([...common, 'payload']), path, state);
    if (Object.hasOwn(action, 'payload')) validateTemplate(action.payload, `${path}.payload`, state);
  }

  if (Object.hasOwn(action, 'label')) validateText(action.label, `${path}.label`, state);
  const customValidator = state.options.actionValidators[type];
  if (typeof customValidator === 'function') {
    try {
      const problem = customValidator(action);
      if (typeof problem === 'string' && problem) addError(state, path, 'custom_action', problem);
      if (Array.isArray(problem)) {
        for (const message of problem) addError(state, path, 'custom_action', String(message));
      }
    } catch (error) {
      addError(state, path, 'custom_action', `Action validator failed: ${error.message}`);
    }
  }
  state.ancestors.delete(action);
}

function validateActionList(actions, path, state, { required }) {
  if (!Array.isArray(actions)) {
    addError(state, path, 'action_list', 'Expected an array of actions');
    return;
  }
  if (required && actions.length === 0) addError(state, path, 'action_list', 'At least one action is required');
  if (actions.length > state.options.limits.maxActions) {
    addError(state, path, 'too_many_actions', `Action list exceeds ${state.options.limits.maxActions} actions`);
  }
  for (let index = 0; index < actions.length && !state.stopped; index += 1) {
    validateAction(actions[index], `${path}[${index}]`, state);
  }
}

/**
 * Validate a declarative rule without mutating it.
 * @returns {{ok: boolean, errors: Array<{path:string,code:string,message:string}>, stats: object}}
 */
export function validateRule(rule, options = {}) {
  const state = stateFor(options);
  if (!isPlainObject(rule)) {
    addError(state, '$', 'rule', 'Rule must be an object');
  } else if (enterObject(rule, '$', state)) {
    allowedKeys(
      rule,
      new Set(['version', 'id', 'name', 'description', 'enabled', 'when', 'if', 'while', 'then', 'else', 'metadata']),
      '$',
      state,
    );
    if (rule.version !== RULE_SCHEMA_VERSION) {
      addError(state, '$.version', 'version', `Expected rule schema version ${RULE_SCHEMA_VERSION}`);
    }
    validateText(rule.id, '$.id', state, { pattern: IDENTIFIER_RE });
    validateText(rule.name, '$.name', state);
    if (Object.hasOwn(rule, 'description')) validateText(rule.description, '$.description', state, { required: false });
    if (typeof rule.enabled !== 'boolean') addError(state, '$.enabled', 'type', 'enabled must be a boolean');
    if (!Object.hasOwn(rule, 'when')) addError(state, '$.when', 'required', 'Rule requires WHEN');
    else validateCondition(rule.when, '$.when', state);
    if (Object.hasOwn(rule, 'if')) validateCondition(rule.if, '$.if', state);
    if (Object.hasOwn(rule, 'while')) validateCondition(rule.while, '$.while', state);
    if (!Object.hasOwn(rule, 'then')) addError(state, '$.then', 'required', 'Rule requires THEN actions');
    else validateActionList(rule.then, '$.then', state, { required: true });
    if (Object.hasOwn(rule, 'else')) validateActionList(rule.else, '$.else', state, { required: true });
    if (Object.hasOwn(rule, 'metadata')) validateJson(rule.metadata, '$.metadata', state);
    state.ancestors.delete(rule);
  }
  return {
    ok: state.errors.length === 0,
    errors: state.errors,
    stats: {
      conditions: state.conditions,
      actions: state.actions,
      dataNodes: state.templateNodes,
    },
  };
}

export function assertValidRule(rule, options = {}) {
  const result = validateRule(rule, options);
  if (!result.ok) throw new RuleValidationError(result.errors);
  return rule;
}

function resolvedValue(ref, context) {
  if (typeof context?.resolve === 'function') {
    const result = context.resolve(ref);
    if (result && typeof result.then === 'function') {
      throw new RuleEvaluationError(`Value resolver for "${ref}" returned a Promise; rule evaluation is synchronous`, { ref });
    }
    if (isPlainObject(result) && typeof result.found === 'boolean') {
      if (result.found) return result.value;
    } else if (result !== undefined) {
      return result;
    }
  }
  if (context?.values instanceof Map && context.values.has(ref)) return context.values.get(ref);
  if (isPlainObject(context?.values) && Object.hasOwn(context.values, ref)) return context.values[ref];

  const namespace = refNamespace(ref);
  const resolver = context?.resolvers?.[namespace];
  if (typeof resolver === 'function') {
    const result = resolver(ref.slice(namespace.length + 1), ref);
    if (result && typeof result.then === 'function') {
      throw new RuleEvaluationError(`Namespace resolver for "${ref}" returned a Promise; rule evaluation is synchronous`, { ref });
    }
    if (result !== undefined) return result;
  }
  throw new RuleEvaluationError(`No value available for "${ref}"`, { ref });
}

export function evaluateValue(node, context = {}) {
  if (!isPlainObject(node)) throw new RuleEvaluationError('Malformed value node');
  if (Object.hasOwn(node, 'literal') && !Object.hasOwn(node, 'ref')) return node.literal;
  if (typeof node.ref === 'string' && !Object.hasOwn(node, 'literal')) return resolvedValue(node.ref, context);
  throw new RuleEvaluationError('Malformed value node');
}

function evaluateTemporal(node, context) {
  if (!Number.isFinite(context?.now)) {
    throw new RuleEvaluationError(`Temporal operator "${node.op}" requires context.now as epoch milliseconds`, {
      operator: node.op,
    });
  }
  const history = context.history;
  if (!history || typeof history !== 'object') {
    throw new RuleEvaluationError(`Temporal operator "${node.op}" requires context.history`, { operator: node.op });
  }
  const expectedProvided = Object.hasOwn(node, 'right');
  const query = Object.freeze({
    operator: node.op,
    ref: node.left.ref,
    expected: expectedProvided ? evaluateValue(node.right, context) : undefined,
    expectedProvided,
    durationMs: node.durationMs,
    withinMs: node.withinMs,
    now: context.now,
  });
  const method = typeof history.test === 'function' ? history.test : history[HISTORY_METHODS[node.op]];
  if (typeof method !== 'function') {
    throw new RuleEvaluationError(`History does not implement "${node.op}"`, { operator: node.op });
  }
  const result = method.call(history, query);
  if (result && typeof result.then === 'function') {
    throw new RuleEvaluationError(`History operator "${node.op}" returned a Promise; rule evaluation is synchronous`, {
      operator: node.op,
    });
  }
  if (typeof result !== 'boolean') {
    throw new RuleEvaluationError(`History operator "${node.op}" must return a boolean`, { operator: node.op });
  }
  return result;
}

function compareOrdered(left, right, operator) {
  const numeric = typeof left === 'number' && typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right);
  const textual = typeof left === 'string' && typeof right === 'string';
  if (!numeric && !textual) {
    throw new RuleEvaluationError(`${operator} requires two finite numbers or two strings`, { operator });
  }
  return operator === 'greater_than' ? left > right : left < right;
}

function containsValue(container, expected) {
  if (typeof container === 'string' && typeof expected === 'string') return container.includes(expected);
  if (Array.isArray(container)) return container.some((item) => isDeepStrictEqual(item, expected));
  if (isPlainObject(container) && typeof expected === 'string') return Object.hasOwn(container, expected);
  throw new RuleEvaluationError('contains requires a string, array, or object on the left');
}

/** Evaluate one already-validated condition against an immutable context snapshot. */
export function evaluateCondition(condition, context = {}) {
  if (Object.hasOwn(condition, 'all')) {
    for (const child of condition.all) if (!evaluateCondition(child, context)) return false;
    return true;
  }
  if (Object.hasOwn(condition, 'any')) {
    for (const child of condition.any) if (evaluateCondition(child, context)) return true;
    return false;
  }
  if (Object.hasOwn(condition, 'not')) return !evaluateCondition(condition.not, context);

  if (TEMPORAL_OPERATORS.has(condition.op)) return evaluateTemporal(condition, context);
  const left = evaluateValue(condition.left, context);
  const right = Object.hasOwn(condition, 'right') ? evaluateValue(condition.right, context) : undefined;
  if (condition.op === 'equals') return isDeepStrictEqual(left, right);
  if (condition.op === 'not_equals') return !isDeepStrictEqual(left, right);
  if (condition.op === 'greater_than' || condition.op === 'less_than') return compareOrdered(left, right, condition.op);
  if (condition.op === 'contains') return containsValue(left, right);

  const custom = context?.operators?.[condition.op];
  if (typeof custom !== 'function') {
    throw new RuleEvaluationError(`No evaluator registered for operator "${condition.op}"`, { operator: condition.op });
  }
  const result = custom(Object.freeze({ left, right, node: condition, now: context.now }));
  if (result && typeof result.then === 'function') {
    throw new RuleEvaluationError(`Operator "${condition.op}" returned a Promise; rule evaluation is synchronous`, {
      operator: condition.op,
    });
  }
  if (typeof result !== 'boolean') {
    throw new RuleEvaluationError(`Operator "${condition.op}" must return a boolean`, { operator: condition.op });
  }
  return result;
}

function cloneAndResolveTemplate(value, context, depth = 0, maxDepth = DEFAULT_LIMITS.maxDepth) {
  if (depth > maxDepth) throw new RuleEvaluationError('Action template is too deep');
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if ((keys.length === 1 && keys[0] === 'ref') || (keys.length === 1 && keys[0] === 'literal')) {
      return evaluateValue(value, context);
    }
    const output = {};
    for (const key of keys) output[key] = cloneAndResolveTemplate(value[key], context, depth + 1, maxDepth);
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => cloneAndResolveTemplate(item, context, depth + 1, maxDepth));
  return value;
}

/** Resolve all value references in an action into an executable action plan. */
export function materializeAction(action, context = {}, options = {}) {
  const maxDepth = normalizedOptions(options).limits.maxDepth;
  const output = { ...action };
  if (action.type === 'tool.call' && Object.hasOwn(action, 'arguments')) {
    output.arguments = cloneAndResolveTemplate(action.arguments, context, 0, maxDepth);
  } else if (action.type === 'variable.set') {
    output.value = evaluateValue(action.value, context);
  } else if (action.type === 'timer.start') {
    output.durationMs = evaluateValue(action.durationMs, context);
    if (!Number.isSafeInteger(output.durationMs) || output.durationMs <= 0) {
      throw new RuleEvaluationError('timer.start durationMs must resolve to a positive integer');
    }
    if (Object.hasOwn(action, 'payload')) output.payload = cloneAndResolveTemplate(action.payload, context, 0, maxDepth);
  } else if (action.type === 'carvis.wake') {
    output.prompt = evaluateValue(action.prompt, context);
  } else if (action.type === 'speech.say') {
    output.text = evaluateValue(action.text, context);
  } else if (Object.hasOwn(action, 'payload')) {
    output.payload = cloneAndResolveTemplate(action.payload, context, 0, maxDepth);
  }
  return output;
}

export function materializeActions(actions, context = {}, options = {}) {
  return actions.map((action) => materializeAction(action, context, options));
}

function evaluationFailure(rule, summary, error, extra = {}) {
  return {
    ok: false,
    valid: true,
    ruleId: rule?.id ?? null,
    enabled: rule?.enabled === true,
    matched: false,
    triggered: false,
    branch: 'none',
    when: null,
    if: null,
    while: null,
    conditions: { when: null, if: null, while: null },
    actions: [],
    rawActions: [],
    summary,
    error: {
      name: error.name || 'Error',
      message: error.message || String(error),
      ...(error.ref ? { ref: error.ref } : {}),
      ...(error.operator ? { operator: error.operator } : {}),
    },
    ...extra,
  };
}

/**
 * Validate and evaluate a rule. No actions are executed.
 * ELSE is selected only when WHEN matched but IF or WHILE did not.
 */
export function evaluateRule(rule, context = {}, options = {}) {
  const summary = summarizeRule(rule);
  const extensionOptions = {
    ...options,
    operators: [...optionList(options.operators), ...Object.keys(context.operators ?? {})],
  };
  const validation = validateRule(rule, extensionOptions);
  if (!validation.ok) {
    return {
      ok: false,
      valid: false,
      ruleId: rule?.id ?? null,
      enabled: rule?.enabled === true,
      matched: false,
      triggered: false,
      branch: 'none',
      when: null,
      if: null,
      while: null,
      conditions: { when: null, if: null, while: null },
      actions: [],
      rawActions: [],
      validationErrors: validation.errors,
      summary,
    };
  }
  if (!rule.enabled) {
    return {
      ok: true,
      valid: true,
      ruleId: rule.id,
      enabled: false,
      matched: false,
      triggered: false,
      branch: 'none',
      when: null,
      if: null,
      while: null,
      conditions: { when: null, if: null, while: null },
      actions: [],
      rawActions: [],
      skipped: 'disabled',
      summary,
    };
  }

  try {
    const when = evaluateCondition(rule.when, context);
    if (!when) {
      return {
        ok: true,
        valid: true,
        ruleId: rule.id,
        enabled: true,
        matched: false,
        triggered: false,
        branch: 'none',
        when,
        if: null,
        while: null,
        conditions: { when, if: null, while: null },
        actions: [],
        rawActions: [],
        summary,
      };
    }
    const ifResult = rule.if ? evaluateCondition(rule.if, context) : true;
    const whileResult = rule.while && ifResult ? evaluateCondition(rule.while, context) : rule.while ? null : true;
    const triggered = ifResult && whileResult === true;
    const branch = triggered ? 'then' : rule.else ? 'else' : 'none';
    const rawActions = branch === 'then' ? rule.then : branch === 'else' ? rule.else : [];
    const actions = options.materializeActions === false
      ? rawActions.slice()
      : materializeActions(rawActions, context, options);
    return {
      ok: true,
      valid: true,
      ruleId: rule.id,
      enabled: true,
      matched: true,
      triggered,
      branch,
      when,
      if: ifResult,
      while: whileResult,
      conditions: { when, if: ifResult, while: whileResult },
      actions,
      rawActions: rawActions.slice(),
      summary,
    };
  } catch (error) {
    return evaluationFailure(rule, summary, error);
  }
}

function compactJson(value, max = 120) {
  try {
    const output = JSON.stringify(value);
    if (output === undefined) return String(value);
    return output.length <= max ? output : `${output.slice(0, max - 1)}…`;
  } catch {
    return '[unprintable]';
  }
}

export function summarizeValue(value) {
  if (!isPlainObject(value)) return '<?>';
  if (typeof value.ref === 'string' && !Object.hasOwn(value, 'literal')) return value.ref;
  if (Object.hasOwn(value, 'literal') && !Object.hasOwn(value, 'ref')) return compactJson(value.literal);
  return '<?>';
}

function readableOperator(operator) {
  const labels = {
    equals: 'EQUALS',
    not_equals: 'DOES NOT EQUAL',
    changed_to: 'CHANGED TO',
    changed_from: 'CHANGED FROM',
    greater_than: 'GREATER THAN',
    less_than: 'LESS THAN',
    contains: 'CONTAINS',
  };
  return labels[operator] ?? String(operator ?? '?').replaceAll('_', ' ').toUpperCase();
}

function durationLabel(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '?';
  if (milliseconds % 86_400_000 === 0) return `${milliseconds / 86_400_000}d`;
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

function summarizeConditionInner(condition, indent, state, depth) {
  const pad = ' '.repeat(indent);
  if (!isPlainObject(condition)) return `${pad}<?>`;
  if (depth > DEFAULT_LIMITS.maxDepth) return `${pad}<maximum depth>`;
  if (state.remaining <= 0) return `${pad}<condition limit>`;
  state.remaining -= 1;
  if (state.ancestors.has(condition)) return `${pad}<cycle>`;
  state.ancestors.add(condition);
  let result;
  if (Array.isArray(condition.all)) {
    const lines = [`${pad}AND`];
    let index = 0;
    for (; index < condition.all.length && state.remaining > 0; index += 1) {
      lines.push(summarizeConditionInner(condition.all[index], indent + 2, state, depth + 1));
    }
    if (index < condition.all.length) lines.push(`${' '.repeat(indent + 2)}<conditions omitted>`);
    result = lines.join('\n');
  } else if (Array.isArray(condition.any)) {
    const lines = [`${pad}OR`];
    let index = 0;
    for (; index < condition.any.length && state.remaining > 0; index += 1) {
      lines.push(summarizeConditionInner(condition.any[index], indent + 2, state, depth + 1));
    }
    if (index < condition.any.length) lines.push(`${' '.repeat(indent + 2)}<conditions omitted>`);
    result = lines.join('\n');
  } else if (Object.hasOwn(condition, 'not')) {
    result = `${pad}NOT\n${summarizeConditionInner(condition.not, indent + 2, state, depth + 1)}`;
  } else {
    const right = Object.hasOwn(condition, 'right') ? ` ${summarizeValue(condition.right)}` : '';
    const left = summarizeValue(condition.left);
    if (condition.op === 'for_duration') {
      result = `${pad}${left} EQUALS${right} FOR ${durationLabel(condition.durationMs)}`;
    } else if (condition.op === 'has_been') {
      result = `${pad}${left} HAS BEEN${right} FOR ${durationLabel(condition.durationMs)}`;
    } else if (condition.op === 'within') {
      result = `${pad}${left}${right ? ` MATCHED${right}` : ' HAPPENED'} WITHIN ${durationLabel(condition.withinMs)}`;
    } else if (condition.op === 'hasnt_happened') {
      result = `${pad}${left} HASN'T HAPPENED${right} WITHIN ${durationLabel(condition.withinMs)}`;
    } else {
      result = `${pad}${left} ${readableOperator(condition.op)}${right}`;
    }
  }
  state.ancestors.delete(condition);
  return result;
}

export function summarizeCondition(condition, indent = 0) {
  return summarizeConditionInner(condition, indent, {
    ancestors: new WeakSet(),
    remaining: DEFAULT_LIMITS.maxConditions,
  }, 0);
}

export function summarizeAction(action, indent = 0) {
  const pad = ' '.repeat(indent);
  if (!isPlainObject(action)) return `${pad}<?>`;
  if (action.type === 'tool.call') {
    return `${pad}TOOL.CALL ${action.tool ?? '<?>'}${Object.hasOwn(action, 'arguments') ? ` ${compactJson(action.arguments)}` : ''}`;
  }
  if (action.type === 'variable.set') return `${pad}VARIABLE.SET ${action.name ?? '<?>'} = ${summarizeValue(action.value)}`;
  if (action.type === 'timer.start') return `${pad}TIMER.START ${action.timer ?? '<?>'} FOR ${summarizeValue(action.durationMs)}`;
  if (action.type === 'timer.cancel') return `${pad}TIMER.CANCEL ${action.timer ?? '<?>'}`;
  if (action.type === 'rule.enable' || action.type === 'rule.disable') {
    return `${pad}${String(action.type).toUpperCase()} ${action.ruleId ?? '<?>'}`;
  }
  if (action.type === 'carvis.wake') return `${pad}CARVIS.WAKE ${summarizeValue(action.prompt)}`;
  if (action.type === 'speech.say') return `${pad}SPEECH.SAY ${summarizeValue(action.text)}`;
  return `${pad}${String(action.type ?? '<?>').toUpperCase()}${Object.hasOwn(action, 'payload') ? ` ${compactJson(action.payload)}` : ''}`;
}

export function summarizeRule(rule) {
  if (!isPlainObject(rule)) return 'INVALID RULE';
  const lines = [`RULE ${compactJson(rule.name ?? rule.id ?? 'Unnamed')} [${rule.enabled ? 'ENABLED' : 'DISABLED'}]`];
  lines.push('WHEN');
  lines.push(summarizeCondition(rule.when, 2));
  if (Object.hasOwn(rule, 'if')) {
    lines.push('IF');
    lines.push(summarizeCondition(rule.if, 2));
  }
  if (Object.hasOwn(rule, 'while')) {
    lines.push('WHILE');
    lines.push(summarizeCondition(rule.while, 2));
  }
  lines.push('THEN');
  if (Array.isArray(rule.then)) {
    lines.push(...rule.then.slice(0, DEFAULT_LIMITS.maxActions).map((action) => summarizeAction(action, 2)));
    if (rule.then.length > DEFAULT_LIMITS.maxActions) lines.push('  <actions omitted>');
  }
  else lines.push('  <?>');
  if (Array.isArray(rule.else)) {
    lines.push('ELSE');
    lines.push(...rule.else.slice(0, DEFAULT_LIMITS.maxActions).map((action) => summarizeAction(action, 2)));
    if (rule.else.length > DEFAULT_LIMITS.maxActions) lines.push('  <actions omitted>');
  }
  return lines.join('\n');
}
