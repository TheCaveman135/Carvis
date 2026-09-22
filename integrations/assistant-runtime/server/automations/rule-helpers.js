import { evaluateCondition } from '../rules/index.js';

export function slug(value, fallback = 'item') {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || fallback;
}

export function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

export function finiteTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasReferenceValue(value) {
  let dynamic = false;
  walk(value, (node) => {
    if (isPlainObject(node) && Object.keys(node).length === 1 && typeof node.ref === 'string') dynamic = true;
  });
  return dynamic;
}

export function unwrapStaticTemplates(value) {
  if (Array.isArray(value)) return value.map(unwrapStaticTemplates);
  if (!isPlainObject(value)) return clone(value);
  if (Object.keys(value).length === 1 && Object.hasOwn(value, 'literal')) return clone(value.literal);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapStaticTemplates(item)]));
}

export function ownPath(value, path) {
  let current = value;
  for (const segment of String(path || '').split('.').filter(Boolean)) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

export function walk(value, visitor) {
  if (!value || typeof value !== 'object') return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor);
  } else {
    for (const item of Object.values(value)) walk(item, visitor);
  }
}

export function refsInRule(rule) {
  const refs = new Set();
  walk(rule, (node) => {
    if (typeof node.ref === 'string' && Object.keys(node).length === 1) refs.add(node.ref);
  });
  return [...refs];
}

export function conditionUsesEventEdge(condition) {
  let found = false;
  walk(condition, (node) => {
    if (node.op === 'changed_to' || node.op === 'changed_from') found = true;
  });
  return found;
}

/** A WHEN that reads an event needs an event edge to actually start a run. */
export function whenUsesEventWithoutEdge(condition) {
  const readsEvent = predicatesInCondition(condition, (node) =>
    typeof node.left?.ref === 'string' && node.left.ref.startsWith('event.'),
  ).length > 0;
  return readsEvent && !conditionUsesEventEdge(condition);
}

export function edgeBranchResult(condition, context) {
  if (!isPlainObject(condition)) return { value: false, edgeMatched: false };
  if (condition.op) {
    const value = evaluateCondition(condition, context);
    return {
      value,
      edgeMatched: value && (condition.op === 'changed_to' || condition.op === 'changed_from'),
    };
  }
  if (Array.isArray(condition.all)) {
    const children = condition.all.map((child) => edgeBranchResult(child, context));
    const value = children.every((child) => child.value);
    return { value, edgeMatched: value && children.some((child) => child.edgeMatched) };
  }
  if (Array.isArray(condition.any)) {
    const children = condition.any.map((child) => edgeBranchResult(child, context));
    return {
      value: children.some((child) => child.value),
      edgeMatched: children.some((child) => child.value && child.edgeMatched),
    };
  }
  if (condition.not) {
    const child = edgeBranchResult(condition.not, context);
    return { value: !child.value, edgeMatched: false };
  }
  return { value: false, edgeMatched: false };
}

export function conditionEdgeUnderNot(condition, beneathNot = false) {
  if (!isPlainObject(condition)) return false;
  if (condition.op === 'changed_to' || condition.op === 'changed_from') return beneathNot;
  if (Array.isArray(condition.all)) return condition.all.some((child) => conditionEdgeUnderNot(child, beneathNot));
  if (Array.isArray(condition.any)) return condition.any.some((child) => conditionEdgeUnderNot(child, beneathNot));
  if (condition.not) return conditionEdgeUnderNot(condition.not, true);
  return false;
}

export function predicatesInCondition(condition, predicate, found = []) {
  if (!isPlainObject(condition)) return found;
  if (condition.op) {
    if (predicate(condition)) found.push(condition);
    return found;
  }
  if (Array.isArray(condition.all)) for (const child of condition.all) predicatesInCondition(child, predicate, found);
  if (Array.isArray(condition.any)) for (const child of condition.any) predicatesInCondition(child, predicate, found);
  if (condition.not) predicatesInCondition(condition.not, predicate, found);
  return found;
}

export function temporalRefProblem(op, ref) {
  const changed = op === 'changed_to' || op === 'changed_from';
  const held = op === 'for_duration' || op === 'has_been';
  const occurrence = op === 'within' || op === 'hasnt_happened';
  if (!changed && !held && !occurrence) return null;

  const haState = /^ha\.[^.]+\..+\.state$/.test(ref);
  const locationState = /^location\.[^.]+(?:\.state)?$/.test(ref);
  const weatherStatus = ref === 'weather.status' || /^weather\.[^.]+\.status$/.test(ref);
  const variable = /^variable\.[A-Za-z_][A-Za-z0-9_.:-]*$/.test(ref);
  // `.state` remains a convenient read alias, but persisted transitions are
  // deliberately recorded under one canonical `.status` key. Accepting the
  // alias for edge/occurrence operators would create rules that never fire.
  const timerStatus = /^(?:timer|alarm)\.[^.]+\.status$/.test(ref);
  const event = ref === 'event.type' || ref === 'event.source' || ref.startsWith('event.data.');

  if (changed && event) {
    if (op === 'changed_from') return 'changed_from is not meaningful for an event; use changed_to event.type/source/data instead';
    return null;
  }
  if (changed && (haState || locationState || weatherStatus || variable || timerStatus)) return null;
  if (held && (haState || locationState || weatherStatus || variable)) return null;
  if (occurrence && (haState || locationState || weatherStatus || variable || timerStatus || event)) return null;
  return `${op} is not supported for ${ref}; choose a state/status/event/variable reference with durable transition history`;
}
