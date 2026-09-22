/**
 * Carvis's deterministic automation runtime.
 *
 * Models may author these programs, but never execute them. A saved rule is a
 * validated AST evaluated against an immutable snapshot; every external side
 * effect still crosses ToolGateway. This is the replacement for "leave a
 * model awake and hope it remembers" as well as the common foundation for
 * timers, alarms, variables, and visual block coding.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  archiveAutomationRule,
  cancelAutomationTimer,
  createAutomationTimer,
  dueAutomationTimers,
  deleteAutomationVariable,
  getAutomationRule,
  getAutomationTimer,
  getAutomationVariable,
  incrementAutomationVariable,
  listAutomationRules,
  listAutomationRuns,
  listAutomationTimers,
  listAutomationVariables,
  markAutomationTimerFired,
  pauseAutomationTimer,
  pruneAutomationOperationalHistory,
  recentEvents,
  recentAutomationValueChanges,
  recordAutomationRun,
  recordAutomationValueChange,
  rescheduleAutomationTimer,
  resumeAutomationTimer,
  saveAutomationRule,
  setAutomationRuleEnabled,
  setAutomationVariable,
  snoozeAutomationTimer,
  updateAutomationRuleEvaluation,
} from './db.js';
import { log } from './log.js';
import { requiresOwnerConfirmation } from './guards.js';
import { nextAlarmOccurrence } from './automation-utils.js';
import {
  RULE_SCHEMA_VERSION,
  evaluateCondition,
  evaluateRule,
  materializeActions,
  RuleEvaluationError,
  summarizeRule,
  validateRule,
} from './rules/index.js';
import { RISK, validate as validateToolArguments } from './tools/gateway.js';

const EXTRA_VALUE_NAMESPACES = ['alarm', 'weather', 'count', 'event'];
const MAX_RULE_ACTION_RISK = RISK.MEDIUM;
const MIN_WHILE_REPEAT_MS = 1_000;
const DEFAULT_WHILE_REPEAT_MS = 60_000;
const MAX_WHILE_ITERATIONS = 1_000;
const MIN_TIMER_DURATION_MS = 1_000;
const MAX_TIMER_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_TIMERS = 500;
const MAX_ACTIVE_TIMERS_PER_RULE = 32;
const MAX_SAVED_RULES = 500;
// Operational history is retained for thirty days. A temporal condition beyond
// that would look deterministic while silently relying on pruned evidence.
const MAX_TEMPORAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

const DEFAULT_STORE = {
  archiveRule: archiveAutomationRule,
  cancelTimer: cancelAutomationTimer,
  createTimer: createAutomationTimer,
  dueTimers: dueAutomationTimers,
  deleteVariable: deleteAutomationVariable,
  getRule: getAutomationRule,
  getTimer: getAutomationTimer,
  getVariable: getAutomationVariable,
  incrementVariable: incrementAutomationVariable,
  listRules: listAutomationRules,
  listRuns: listAutomationRuns,
  listTimers: listAutomationTimers,
  listVariables: listAutomationVariables,
  markTimerFired: markAutomationTimerFired,
  pauseTimer: pauseAutomationTimer,
  prune: pruneAutomationOperationalHistory,
  recentEvents,
  recentValueChanges: recentAutomationValueChanges,
  recordValueChange: recordAutomationValueChange,
  recordRun: recordAutomationRun,
  resumeTimer: resumeAutomationTimer,
  rescheduleTimer: rescheduleAutomationTimer,
  saveRule: saveAutomationRule,
  setRuleEnabled: setAutomationRuleEnabled,
  setVariable: setAutomationVariable,
  snoozeTimer: snoozeAutomationTimer,
  updateEvaluation: updateAutomationRuleEvaluation,
};

function slug(value, fallback = 'item') {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || fallback;
}

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function finiteTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasReferenceValue(value) {
  let dynamic = false;
  walk(value, (node) => {
    if (isPlainObject(node) && Object.keys(node).length === 1 && typeof node.ref === 'string') dynamic = true;
  });
  return dynamic;
}

function unwrapStaticTemplates(value) {
  if (Array.isArray(value)) return value.map(unwrapStaticTemplates);
  if (!isPlainObject(value)) return clone(value);
  if (Object.keys(value).length === 1 && Object.hasOwn(value, 'literal')) return clone(value.literal);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapStaticTemplates(item)]));
}

function ownPath(value, path) {
  let current = value;
  for (const segment of String(path || '').split('.').filter(Boolean)) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function walk(value, visitor) {
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

function conditionUsesEventEdge(condition) {
  let found = false;
  walk(condition, (node) => {
    if (node.op === 'changed_to' || node.op === 'changed_from') found = true;
  });
  return found;
}

/** A WHEN that reads an event needs an event edge to actually start a run. */
function whenUsesEventWithoutEdge(condition) {
  const readsEvent = predicatesInCondition(condition, (node) =>
    typeof node.left?.ref === 'string' && node.left.ref.startsWith('event.'),
  ).length > 0;
  return readsEvent && !conditionUsesEventEdge(condition);
}

function edgeBranchResult(condition, context) {
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

function conditionEdgeUnderNot(condition, beneathNot = false) {
  if (!isPlainObject(condition)) return false;
  if (condition.op === 'changed_to' || condition.op === 'changed_from') return beneathNot;
  if (Array.isArray(condition.all)) return condition.all.some((child) => conditionEdgeUnderNot(child, beneathNot));
  if (Array.isArray(condition.any)) return condition.any.some((child) => conditionEdgeUnderNot(child, beneathNot));
  if (condition.not) return conditionEdgeUnderNot(condition.not, true);
  return false;
}

function predicatesInCondition(condition, predicate, found = []) {
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

function temporalRefProblem(op, ref) {
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

function publicRule(row) {
  if (!row) return null;
  return {
    ...clone(row.definition),
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    revision: row.revision,
    archived: row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    lastEvaluatedAt: row.last_evaluated_at,
    lastFiredAt: row.last_fired_at,
    fireCount: row.fire_count,
    whileIterations: row.while_iterations || 0,
    lastMatch: row.last_match,
    lastOutcome: row.last_outcome,
    lastError: row.last_error,
    summary: summarizeRule(row.definition),
  };
}

function publicTimer(timer, now = Date.now()) {
  if (!timer) return null;
  return {
    id: timer.id,
    name: timer.name,
    kind: timer.kind,
    status: timer.status,
    createdAt: timer.created_at,
    dueAt: timer.due_at,
    dueAtIso: nowIso(timer.due_at),
    remainingMs: timer.status === 'paused'
      ? timer.paused_remaining_ms
      : Math.max(0, timer.due_at - now),
    repeatMs: timer.repeat_ms,
    ruleId: timer.rule_id,
    firedAt: timer.fired_at,
    payload: clone(timer.payload || {}),
  };
}

function publicRun(run) {
  return {
    id: run.id,
    ruleId: run.rule_id,
    ts: run.ts,
    trigger: clone(run.trigger),
    outcome: run.outcome,
    actions: clone(run.actions),
    error: run.error,
    ms: run.ms,
  };
}

export class AutomationEngine {
  constructor({
    bus,
    gateway,
    ha,
    atlas,
    memory,
    hud,
    feed,
    getCarvisState = () => ({}),
    getVoiceState = () => ({}),
    getConfig = () => ({}),
    isHaReady = () => true,
    isAtlasReady = () => true,
    onWake = async () => ({ outcome: 'ok' }),
    onChange = () => {},
    store = DEFAULT_STORE,
    now = () => Date.now(),
  }) {
    this.bus = bus;
    this.gateway = gateway;
    this.ha = ha;
    this.atlas = atlas;
    this.memory = memory;
    this.hud = hud;
    this.feed = feed;
    this.getCarvisState = getCarvisState;
    this.getVoiceState = getVoiceState;
    this.getConfig = getConfig;
    this.isHaReady = isHaReady;
    this.isAtlasReady = isAtlasReady;
    this.onWake = onWake;
    this.onChange = onChange;
    this.store = store;
    this.now = now;

    this.rules = new Map();
    this.trackedRefs = new Set();
    this.lastWhen = new Map();
    this.whileIterations = new Map();
    this.valueHistory = new Map();
    this.running = new Set();
    this.firingTimers = new Set();
    this.queue = Promise.resolve();
    this.unsubscribe = null;
    this.clock = null;
    this.maintenance = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.reload();
    this.store.prune?.({ now: this.now() });
    this.unsubscribe = this.bus?.subscribe('**', (event) => this.enqueue({ kind: 'event', event }));
    this.clock = setInterval(() => this.enqueue({ kind: 'clock', now: this.now() }), 1_000);
    this.clock.unref?.();
    this.maintenance = setInterval(() => this.store.prune?.({ now: this.now() }), 24 * 60 * 60_000);
    this.maintenance.unref?.();
    // Establish edge baselines after a restart. No action may fire merely
    // because Home Assistant restored its current state into memory.
    this.enqueue({ kind: 'startup', now: this.now(), baselineOnly: true });
    const active = [...this.rules.values()].filter((row) => row.enabled).length;
    const timers = this.store.listTimers({ activeOnly: true }).length;
    if (active || timers) log('info', `Automation engine restored ${active} rule(s) and ${timers} timer/alarm(s)`);
  }

  stop() {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    clearInterval(this.clock);
    this.clock = null;
    clearInterval(this.maintenance);
    this.maintenance = null;
  }

  reload() {
    this.rules.clear();
    this.valueHistory.clear();
    for (const row of this.store.listRules({ includeArchived: false, limit: 500 })) {
      this.rules.set(row.id, row);
      if (row.last_match != null) this.lastWhen.set(row.id, Boolean(row.last_match));
      if (Number(row.while_iterations) > 0) this.whileIterations.set(row.id, Number(row.while_iterations));
    }
    this.#rebuildTrackedRefs();
    for (const ref of this.trackedRefs) {
      const persisted = this.store.recentValueChanges?.(ref, 100) || [];
      if (persisted.length) this.valueHistory.set(ref, persisted.slice().reverse().map(({ from, to, ts }) => ({ from, to, ts })));
    }
  }

  enqueue(trigger) {
    this.queue = this.queue
      .then(() => this.#process(trigger))
      .catch((err) => log('error', `Automation evaluation failed: ${err.message}`));
    return this.queue;
  }

  /**
   * Reconcile current values without treating restored state as a transition.
   * Home Assistant's initial get_states snapshot intentionally emits no
   * state_changed callbacks, so the host calls this once HA has bootstrapped.
   */
  baseline(reason = 'source_connected') {
    return this.enqueue({ kind: 'baseline', reason, now: this.now(), baselineOnly: true });
  }

  handleHaChange(entityId, newState, oldState) {
    if (!newState || newState.state === oldState?.state) return;
    const timestamp = this.now();
    const ref = `ha.${entityId}.state`;
    this.#rememberValueChange(ref, oldState?.state, newState.state, timestamp);
    if (entityId.startsWith('person.') || entityId.startsWith('device_tracker.')) {
      const person = entityId.split('.').slice(1).join('.');
      this.#rememberValueChange(`location.${person}`, oldState?.state, newState.state, timestamp);
      this.#rememberValueChange(`location.${person}.state`, oldState?.state, newState.state, timestamp);
    }
    if (entityId.startsWith('weather.')) {
      const weatherName = entityId.slice('weather.'.length);
      this.#rememberValueChange(`weather.${weatherName}.status`, oldState?.state, newState.state, timestamp);
      // `weather.status` deliberately means the default/first weather entity.
      // Record the alias only when this is that same entity.
      if (this.#weatherEntity()?.entity_id === entityId) {
        this.#rememberValueChange('weather.status', oldState?.state, newState.state, timestamp);
      }
    }
    return this.enqueue({
      kind: 'ha_change',
      now: timestamp,
      event: {
        id: `ha_${randomUUID().slice(0, 10)}`,
        type: 'ha.state.changed',
        source: 'home_assistant',
        timestamp,
        data: {
          entity_id: entityId,
          from: oldState?.state,
          to: newState.state,
          last_changed: newState.last_changed,
        },
      },
      change: { ref, entityId, from: oldState?.state, to: newState.state, timestamp },
    });
  }

  #rememberValueChange(ref, from, to, ts) {
    const list = this.valueHistory.get(ref) || [];
    list.push({ from, to, ts });
    if (list.length > 100) list.splice(0, list.length - 100);
    this.valueHistory.set(ref, list);
    // Persist only references that a saved rule actually uses. Tracking the
    // whole HA firehose would be wasteful and would archive unrelated life.
    if (this.trackedRefs.has(ref)) {
      this.store.recordValueChange?.(ref, from, to, ts);
    }
  }

  #emitValueChange(ref, from, to, ts = this.now()) {
    if (isDeepStrictEqual(from, to)) return;
    this.#rememberValueChange(ref, from, to, ts);
    // Queue the synthetic edge behind the action that caused it. This lets a
    // variable or native timer drive another rule without recursively running
    // that rule inside the current action stack.
    this.enqueue({
      kind: 'value_change',
      now: ts,
      change: { ref, from, to, timestamp: ts },
    });
  }

  #rebuildTrackedRefs() {
    this.trackedRefs = new Set([...this.rules.values()].flatMap((row) => refsInRule(row.definition)));
  }

  async #process(trigger) {
    if (trigger.kind === 'clock' || trigger.kind === 'startup') await this.#fireDueTimers(trigger.now || this.now());
    const rows = [...this.rules.values()].filter((row) => row.enabled && !row.archived);
    for (const snapshot of rows) {
      // A preceding rule may enable/disable this one during the same trigger.
      // Re-read the live map so a stale iteration snapshot cannot execute a
      // rule that was just paused.
      const row = this.rules.get(snapshot.id);
      if (row?.enabled && !row.archived) await this.#evaluateStored(row, trigger);
    }
  }

  #validationOptions() {
    return {
      valueNamespaces: EXTRA_VALUE_NAMESPACES,
      actionValidators: {
        'tool.call': (action) => this.#toolActionProblem(action.tool, action.arguments),
        'timer.start': (action) => this.#timerActionProblem(action),
        'rule.enable': (action) => action.ruleId === action._ownerRuleId ? 'A rule cannot enable itself' : null,
        'rule.disable': (action) => action.ruleId === action._ownerRuleId ? 'A rule cannot disable itself' : null,
      },
    };
  }

  #visibleEntityIds() {
    const entities = this.getConfig?.()?.entities || {};
    return new Set([...(entities.observed || []), ...(entities.controlled || [])]);
  }

  #isVisibleEntity(entityId) {
    return this.#visibleEntityIds().has(entityId);
  }

  #toolActionProblem(name, args = {}) {
    const tool = this.gateway.get(name);
    if (!tool) return `No tool named ${name}`;
    if (name === 'memory.forget') {
      return 'memory.forget is destructive and cannot run unattended; wake Carvis for a live owner request instead';
    }
    if (!this.#automatableTool(name, tool)) {
      if (tool.risk > MAX_RULE_ACTION_RISK) {
        return `${name} is sensitive and cannot run unattended; use carvis.wake so the owner confirms each firing`;
      }
      return `${name} is not available inside a persistent rule`;
    }
    if (name === 'ha.entity.command') {
      const raw = args?.entity_id;
      const entityId = typeof raw === 'string' ? raw : raw?.literal;
      if (typeof entityId !== 'string') {
        return 'Persistent HA entity commands require one fixed entity_id so safety can be audited before the rule is enabled';
      }
      const domain = entityId.split('.')[0];
      const state = this.ha?.states?.get?.(entityId);
      if (requiresOwnerConfirmation(entityId, state, '', this.getConfig?.() || {})) {
        return `${domain} actions for ${entityId} are protected or indirect and cannot run unattended; wake Carvis for a live owner confirmation instead`;
      }
    }
    // Static calls, including typed {literal: ...} nodes, can be checked
    // completely at save time. Calls containing a live reference are checked
    // again by the gateway after materialization.
    if (!hasReferenceValue(args)) {
      const checked = validateToolArguments(unwrapStaticTemplates(args || {}), tool.schema);
      if (!checked.ok) return `${name} has invalid arguments: ${checked.error}`;
    }
    return null;
  }

  #timerActionProblem(action) {
    if (action.payload === undefined) return null;
    if (!isPlainObject(action.payload) || hasReferenceValue(action.payload)) {
      return 'timer.start payload must be a fixed object so its finish behavior can be safety-audited';
    }
    const payload = unwrapStaticTemplates(action.payload);
    if (!isPlainObject(payload)) return 'timer.start payload must resolve to an object';
    const finishActions = payload.actions;
    if (finishActions === undefined) return null;
    if (!Array.isArray(finishActions)) return 'timer.start payload.actions must be an array';
    if (finishActions.length > 16) return 'timer.start allows at most 16 finish actions';
    for (let index = 0; index < finishActions.length; index += 1) {
      const finish = finishActions[index];
      if (!isPlainObject(finish)) return `timer.start finish action ${index + 1} must be an object`;
      if (finish.type === 'carvis.wake') {
        if (typeof finish.prompt !== 'string' || !finish.prompt.trim()) {
          return `timer.start finish action ${index + 1} needs a prompt`;
        }
        continue;
      }
      if (finish.type !== 'tool.call') {
        return `timer.start finish action ${index + 1} must be tool.call or carvis.wake`;
      }
      const problem = this.#toolActionProblem(finish.tool, finish.arguments || {});
      if (problem) return `timer.start finish action ${index + 1}: ${problem}`;
    }
    return null;
  }

  #automatableTool(name, tool = this.gateway.get(name)) {
    if (name === 'hud.express' || name === 'vision.inspect') return false;
    if (!tool || tool.risk > MAX_RULE_ACTION_RISK) return false;
    if (/^(automation\.|watch\.|carvis\.escalate$)/.test(name)) return false;
    if (name === 'mac.command') return false;
    if (name === 'memory.forget') return false;
    return true;
  }

  validate(definition) {
    const rule = this.#normalizeRule(definition, { preserveId: true });
    const validation = validateRule(rule, this.#validationOptions());
    const cycles = validation.ok ? this.#cycleErrors(rule) : [];
    const integration = validation.ok ? this.#integrationErrors(rule) : [];
    return {
      ok: validation.ok && cycles.length === 0 && integration.length === 0,
      errors: [...validation.errors, ...cycles, ...integration],
      stats: validation.stats,
      rule,
      summary: summarizeRule(rule),
      sensitiveActions: this.#sensitiveActions(rule),
    };
  }

  #integrationErrors(rule) {
    const errors = [];
    const metadata = rule.metadata || {};
    if (Object.hasOwn(metadata, 'once') && typeof metadata.once !== 'boolean') {
      errors.push({ path: '$.metadata.once', code: 'type', message: 'once must be true or false' });
    }
    if (Object.hasOwn(metadata, 'stopOnError') && typeof metadata.stopOnError !== 'boolean') {
      errors.push({ path: '$.metadata.stopOnError', code: 'type', message: 'stopOnError must be true or false' });
    }
    if (Object.hasOwn(metadata, 'repeatEveryMs') && (!Number.isSafeInteger(metadata.repeatEveryMs) || metadata.repeatEveryMs < MIN_WHILE_REPEAT_MS)) {
      errors.push({ path: '$.metadata.repeatEveryMs', code: 'range', message: `repeatEveryMs must be an integer of at least ${MIN_WHILE_REPEAT_MS}` });
    }
    if (Object.hasOwn(metadata, 'maxIterations') && (!Number.isSafeInteger(metadata.maxIterations) || metadata.maxIterations < 1 || metadata.maxIterations > MAX_WHILE_ITERATIONS)) {
      errors.push({ path: '$.metadata.maxIterations', code: 'range', message: `maxIterations must be an integer from 1 to ${MAX_WHILE_ITERATIONS}` });
    }
    // A Carvis-authored protocol must obey the same visibility boundary as a
    // live tool call. A guessed `ha.*` reference cannot become an inventory
    // back door to the owner's full Home Assistant.
    if (metadata.createdBy === 'carvis') {
      for (const ref of refsInRule(rule)) {
        const haRef = this.#parseHaRef(ref);
        if (haRef && !this.#isVisibleEntity(haRef.entityId)) {
          errors.push({ path: '$', code: 'entity_visibility', message: 'a protocol may only reference entities available to Carvis' });
          break;
        }
      }
    }
    for (const stage of ['when', 'if', 'while']) {
      const condition = rule[stage];
      if (!condition) continue;
      if (metadata.createdBy === 'carvis') {
        for (const node of predicatesInCondition(condition, (item) => ['equals', 'not_equals', 'changed_to', 'changed_from', 'for_duration', 'within', 'has_been', 'hasnt_happened'].includes(item.op))) {
          const reference = node.left?.ref || node.right?.ref;
          const value = node.left?.ref ? node.right?.literal : node.left?.literal;
          if (typeof value !== 'string') continue;
          let choices;
          if (reference === 'event.type') choices = this.#eventChoices().map((event) => event.type);
          const haRef = this.#parseHaRef(reference || '');
          if (haRef?.field === 'state' && this.#isVisibleEntity(haRef.entityId)) {
            const state = this.ha.states.get(haRef.entityId);
            // Numeric readings and free-form text are not enumerated states.
            if (state?.attributes?.unit_of_measurement || (value.trim() !== '' && Number.isFinite(Number(value))) || ['input_text', 'text'].includes(haRef.entityId.split('.')[0])) continue;
            choices = this.#stateChoices(haRef.entityId);
          }
          if (choices && !choices.includes(value)) errors.push({
            path: `$.${stage}`, code: 'unverified_trigger_value',
            message: `Unverified value ${JSON.stringify(value)} for ${reference}. Exact known values: ${JSON.stringify(choices)}. Use automation.catalog (kind entities or events) and copy a verified value; do not guess or claim this protocol was saved.`,
          });
        }
      }
      if (stage === 'when' && whenUsesEventWithoutEdge(condition)) {
        errors.push({
          path: '$.when',
          code: 'event_edge',
          message: 'Event-based WHEN conditions must use CHANGED TO event.type; put event.data checks in IF or alongside that edge',
        });
      }
      if (conditionEdgeUnderNot(condition)) {
        errors.push({
          path: `$.${stage}`,
          code: 'negated_edge',
          message: 'CHANGED TO/FROM cannot sit inside NOT; negate the resulting state with equals/not_equals instead',
        });
      }
      if (stage !== 'when' && conditionUsesEventEdge(condition)) {
        errors.push({
          path: `$.${stage}`,
          code: 'edge_guard',
          message: 'CHANGED TO/FROM belongs in WHEN; IF and WHILE are snapshot guards and do not independently trigger a rule',
        });
      }
      for (const node of predicatesInCondition(condition, (item) => ['changed_to', 'changed_from', 'for_duration', 'within', 'has_been', 'hasnt_happened'].includes(item.op))) {
        const problem = temporalRefProblem(node.op, node.left?.ref);
        if (problem) errors.push({ path: `$.${stage}`, code: 'temporal_ref', message: problem });
        const window = Number(node.durationMs ?? node.withinMs);
        if (Number.isFinite(window) && window > MAX_TEMPORAL_WINDOW_MS) {
          errors.push({
            path: `$.${stage}`,
            code: 'temporal_window',
            message: `temporal conditions are limited to ${Math.round(MAX_TEMPORAL_WINDOW_MS / 86_400_000)} days, the retained history window`,
          });
        }
      }
    }
    if (rule.while && conditionUsesEventEdge(rule.when)) {
      errors.push({
        path: '$.while',
        code: 'edge_while',
        message: 'WHILE needs a persistent WHEN condition; a one-instant CHANGED TO/FROM event cannot remain active for later repeats',
      });
    }
    const aliases = { 'hud.show': 'hud.set_widget', 'hud.clear': 'hud.clear_all', 'hud.camera': 'hud.show_camera' };
    for (const [branch, actions] of [['then', rule.then || []], ['else', rule.else || []]]) {
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        if (!action.type?.startsWith('hud.')) continue;
        const toolName = aliases[action.type] || action.type;
        const tool = this.gateway.get(toolName);
        if (!tool || !this.#automatableTool(toolName, tool)) {
          errors.push({ path: `$.${branch}[${index}].type`, code: 'action_type', message: `No automatable HUD action named ${action.type}` });
          continue;
        }
        if (!hasReferenceValue(action.payload || {})) {
          const checked = validateToolArguments(unwrapStaticTemplates(action.payload || {}), tool.schema);
          if (!checked.ok) errors.push({ path: `$.${branch}[${index}].payload`, code: 'arguments', message: checked.error });
        }
      }
    }
    return errors;
  }

  #normalizeRule(definition, { preserveId = false, createdBy = 'owner' } = {}) {
    const raw = clone(definition || {});
    const id = preserveId && raw.id
      ? String(raw.id)
      : `rule_${slug(raw.name, 'automation')}_${randomUUID().slice(0, 6)}`;
    const now = this.now();
    return {
      ...raw,
      version: RULE_SCHEMA_VERSION,
      id,
      name: String(raw.name || 'Untitled automation').trim().slice(0, 120),
      enabled: raw.enabled !== false,
      metadata: {
        ...(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}),
        createdAt: raw.metadata?.createdAt || nowIso(now),
        createdBy: raw.metadata?.createdBy || createdBy,
      },
    };
  }

  #sensitiveActions(rule) {
    const found = [];
    for (const action of [...(rule.then || []), ...(rule.else || [])]) {
      if (action.type !== 'tool.call') continue;
      const tool = this.gateway.get(action.tool);
      if (tool?.risk > MAX_RULE_ACTION_RISK) found.push({ tool: action.tool, risk: tool.risk });
    }
    return found;
  }

  #cycleErrors(candidate) {
    const definitions = new Map([...this.rules.values()].map((row) => [row.id, row.definition]));
    definitions.set(candidate.id, candidate);
    const graph = new Map();
    for (const [id, rule] of definitions) {
      const targets = [];
      for (const action of [...(rule.then || []), ...(rule.else || [])]) {
        if ((action.type === 'rule.enable' || action.type === 'rule.disable') && action.ruleId) targets.push(action.ruleId);
      }
      graph.set(id, targets);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const next of graph.get(id) || []) if (graph.has(next) && visit(next)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if (!visit(candidate.id)) return [];
    return [{ path: '$.then', code: 'rule_cycle', message: 'Rule enable/disable actions form a cycle' }];
  }

  save(definition, { expectedRevision = null, createdBy = 'owner' } = {}) {
    const requestedId = definition?.id ? String(definition.id) : '';
    const current = requestedId ? this.store.getRule(requestedId) : null;
    if (!current && this.rules.size >= MAX_SAVED_RULES) {
      const err = new Error(`Carvis already has the maximum ${MAX_SAVED_RULES} active or paused automations; archive one before adding another`);
      err.code = 'rule_limit';
      throw err;
    }
    if (current && expectedRevision == null) {
      const err = new Error(`automation ${requestedId} already exists; update it with revision ${current.revision}`);
      err.code = 'revision_conflict';
      err.currentRevision = current.revision;
      throw err;
    }
    if (!current && expectedRevision != null) {
      const err = new Error(`automation ${requestedId || '(missing id)'} no longer exists`);
      err.code = 'revision_conflict';
      err.currentRevision = null;
      throw err;
    }
    const rule = this.#normalizeRule(definition, { preserveId: Boolean(definition?.id), createdBy });
    rule.metadata.createdBy = createdBy;
    const checked = this.validate(rule);
    if (!checked.ok) {
      const err = new Error(checked.errors.map((item) => `${item.path}: ${item.message}`).join('; '));
      err.code = 'invalid_rule';
      err.errors = checked.errors;
      throw err;
    }
    const stored = this.store.saveRule({ ...rule, createdBy }, { expectedRevision });
    this.rules.set(stored.id, stored);
    this.#rebuildTrackedRefs();

    // Evaluate every full boolean tree. Event predicates are false without an
    // event, while ordinary branches retain their current truth. This matters
    // for mixed rules such as `changed_to(...) OR time.hour = 20`: forcing the
    // whole tree false would spuriously run it on the next clock tick.
    const evaluation = this.#evaluateDefinition(rule, { kind: 'save_baseline', now: this.now() });
    if (evaluation.ok) {
      this.lastWhen.set(rule.id, Boolean(evaluation.when));
      this.store.updateEvaluation(rule.id, { matched: Boolean(evaluation.when), error: null });
    }
    this.#changed('automation.changed', { rule: publicRule(this.store.getRule(stored.id)) });
    return publicRule(this.store.getRule(stored.id));
  }

  get(id) {
    return publicRule(this.store.getRule(id));
  }

  list({ includeArchived = false } = {}) {
    return this.store.listRules({ includeArchived, limit: 500 }).map(publicRule);
  }

  setEnabled(id, enabled) {
    const row = this.store.setRuleEnabled(id, Boolean(enabled));
    if (!row) return null;
    this.rules.set(row.id, row);
    if (enabled) {
      const evaluation = this.#evaluateDefinition(row.definition, { kind: 'enable_baseline', now: this.now() });
      if (evaluation.ok) this.lastWhen.set(row.id, Boolean(evaluation.when));
    }
    this.#changed('automation.changed', { rule: publicRule(row) });
    return publicRule(row);
  }

  archive(id) {
    const archived = this.store.archiveRule(id);
    if (archived) {
      this.rules.delete(id);
      this.#rebuildTrackedRefs();
      this.lastWhen.delete(id);
      this.#changed('automation.changed', { id, archived: true });
    }
    return archived;
  }

  duplicate(id) {
    const source = this.store.getRule(id);
    if (!source) return null;
    const definition = clone(source.definition);
    delete definition.id;
    definition.name = `${source.name} copy`.slice(0, 120);
    definition.enabled = false;
    definition.metadata = { ...(definition.metadata || {}), duplicatedFrom: id, createdAt: nowIso(this.now()) };
    return this.save(definition, { createdBy: 'owner' });
  }

  history(id, limit = 100) {
    return this.store.listRuns({ ruleId: id, limit }).map(publicRun);
  }

  test(definition, { values = {}, event = null, change = null, at = null } = {}) {
    const rule = this.#normalizeRule(definition, { preserveId: true });
    const checked = this.validate(rule);
    if (!checked.ok) return { ok: false, validationErrors: checked.errors, summary: checked.summary };
    const now = finiteTime(at) ?? this.now();
    const fixtureEvent = isPlainObject(event)
      ? {
        id: String(event.id || 'evt_test'),
        type: String(event.type || 'test.event'),
        source: String(event.source || 'test'),
        timestamp: finiteTime(event.timestamp) ?? now,
        data: isPlainObject(event.data) ? clone(event.data) : {},
      }
      : null;
    const fixtureChange = isPlainObject(change) && typeof change.ref === 'string'
      ? { ref: change.ref, from: clone(change.from), to: clone(change.to), timestamp: finiteTime(change.timestamp) ?? now }
      : null;
    const evaluation = this.#evaluateDefinition(rule, {
      kind: 'test', now, values,
      ...(fixtureEvent ? { event: fixtureEvent } : {}),
      ...(fixtureChange ? { change: fixtureChange } : {}),
      ruleCreatedAt: finiteTime(rule.metadata?.createdAt) ?? now,
    });
    if (!evaluation.ok) return { ...evaluation, dryRun: true };
    const actionValidationErrors = this.#previewActionErrors(evaluation.actions);
    return {
      ...evaluation,
      ok: actionValidationErrors.length === 0,
      dryRun: true,
      actionValidationErrors,
      fixture: { event: fixtureEvent, change: fixtureChange, values: clone(values) },
      fixtureRequired: conditionUsesEventEdge(rule.when) && !fixtureEvent && !fixtureChange,
      note: conditionUsesEventEdge(rule.when) && !fixtureEvent && !fixtureChange
        ? 'This WHEN contains CHANGED TO/FROM. Add an event/change fixture to exercise that edge; no action was executed.'
        : 'Conditions and materialized action schemas were evaluated; no action was executed.',
    };
  }

  #previewActionErrors(actions) {
    const errors = [];
    const aliases = { 'hud.show': 'hud.set_widget', 'hud.clear': 'hud.clear_all', 'hud.camera': 'hud.show_camera' };
    actions.forEach((action, index) => {
      let name = null;
      let args = null;
      if (action.type === 'tool.call') {
        name = action.tool;
        args = action.arguments || {};
      } else if (action.type === 'speech.say') {
        name = 'speech.say';
        args = {
          text: String(action.text),
          ...(action.voice ? { voice: action.voice } : {}),
          ...(action.media_player ? { media_player: action.media_player } : {}),
          ...(action.tts_entity ? { tts_entity: action.tts_entity } : {}),
          ...(action.language ? { language: action.language } : {}),
          ...(typeof action.cache === 'boolean' ? { cache: action.cache } : {}),
        };
      } else if (action.type?.startsWith('hud.')) {
        name = aliases[action.type] || action.type;
        args = action.payload || {};
      } else if (action.type === 'timer.start') {
        if (!Number.isSafeInteger(action.durationMs) || action.durationMs < MIN_TIMER_DURATION_MS || action.durationMs > MAX_TIMER_DURATION_MS) {
          errors.push({ index, path: `action[${index}].durationMs`, message: 'timer duration must resolve to 1 second through 365 days' });
        }
        return;
      } else {
        return;
      }
      const tool = this.gateway.get(name);
      if (!tool) {
        errors.push({ index, path: `action[${index}]`, message: `no tool named ${name}` });
        return;
      }
      const result = validateToolArguments(args, tool.schema);
      if (!result.ok) errors.push({ index, path: `action[${index}]`, message: `${name}: ${result.error}` });
    });
    return errors;
  }

  /** True when a saved rule will handle this exact event with an action. */
  claimsEvent(event) {
    // Semantic HA events retain entity_id/from/to. Reconstruct the raw value
    // edge here so a rule written against `ha.<entity>.state changed_to ...`
    // can claim the same event before the classifier independently wakes a
    // model for it.
    const entityId = event?.source === 'home_assistant' ? event.data?.entity_id : null;
    const trigger = {
      kind: 'event', event, now: event?.timestamp || this.now(),
      ...(entityId && Object.hasOwn(event.data || {}, 'to') ? {
        change: {
          ref: `ha.${entityId}.state`, entityId,
          from: event.data?.from, to: event.data?.to,
          timestamp: event.timestamp,
        },
      } : {}),
    };
    for (const row of this.rules.values()) {
      if (!row.enabled || row.archived) continue;
      const result = this.#evaluateDefinition(row.definition, { ...trigger, ruleCreatedAt: row.created_at }, false);
      if (!result.ok || !result.when || result.branch === 'none' || !result.rawActions.length) continue;
      const priorWhen = this.lastWhen.has(row.id)
        ? this.lastWhen.get(row.id)
        : row.last_match == null ? null : Boolean(row.last_match);
      const edgeMatched = this.#matchingWhenEdge(row.definition.when, trigger);
      // Claim only when processing this same event will actually start a run.
      // A rule whose state condition merely remains true must not suppress
      // every unrelated event while it waits for its next real edge/clock.
      if (priorWhen != null && (edgeMatched || priorWhen === false)) return true;
    }
    return false;
  }

  async runNow(id) {
    const row = this.store.getRule(id);
    if (!row || row.archived) return { ok: false, error: `no automation ${id}` };
    const context = this.#context({ kind: 'manual', now: this.now() });
    let actions;
    try {
      // "Run now" deliberately skips WHEN/IF/WHILE, but it must still resolve
      // every typed value in the THEN branch against the same immutable
      // snapshot used by a normal run.
      actions = materializeActions(row.definition.then, context, this.#validationOptions());
    } catch (error) {
      return { ok: false, outcome: 'error', error: error.message };
    }
    return this.#execute(row, actions, {
      kind: 'manual',
      now: this.now(),
      forced: true,
    }, 'then');
  }

  #evaluateDefinition(rule, trigger, materializeActions = true) {
    const context = this.#context(trigger);
    return evaluateRule(rule, context, { ...this.#validationOptions(), materializeActions });
  }

  async #evaluateStored(row, trigger) {
    if (this.running.has(row.id)) return;
    const result = this.#evaluateDefinition(row.definition, { ...trigger, ruleCreatedAt: row.created_at });
    if (!result.ok) {
      const error = result.error?.message || result.validationErrors?.[0]?.message || 'evaluation failed';
      this.store.updateEvaluation(row.id, { matched: false, outcome: 'error', error });
      const refreshed = this.store.getRule(row.id);
      if (refreshed) this.rules.set(row.id, refreshed);
      this.#changed('automation.failed', { ruleId: row.id, error });
      return;
    }

    const priorWhen = this.lastWhen.has(row.id)
      ? this.lastWhen.get(row.id)
      : row.last_match == null ? null : Boolean(row.last_match);
    const when = Boolean(result.when);
    const edgeMatched = this.#matchingWhenEdge(row.definition.when, trigger);
    const repeat = row.definition.while
      ? Math.max(MIN_WHILE_REPEAT_MS, Number(row.definition.metadata?.repeatEveryMs) || DEFAULT_WHILE_REPEAT_MS)
      : 0;
    const sinceFire = this.now() - (row.last_fired_at || 0);
    const whileCount = this.whileIterations.get(row.id) || 0;
    const firstObservation = priorWhen == null;
    let shouldRun = false;

    if (!trigger.baselineOnly && !firstObservation) {
      const activated = when && (edgeMatched || priorWhen === false);
      if (row.definition.while && result.triggered) {
        const requestedMax = Number(row.definition.metadata?.maxIterations);
        const maxIterations = Number.isSafeInteger(requestedMax) && requestedMax > 0
          ? Math.min(requestedMax, MAX_WHILE_ITERATIONS)
          : MAX_WHILE_ITERATIONS;
        // A fresh edge runs immediately. Continuing WHILE executions are
        // clock-driven, so unrelated home events cannot accelerate the loop.
        shouldRun = activated || (
          trigger.kind === 'clock' && sinceFire >= repeat && whileCount < maxIterations
        );
      } else {
        shouldRun = activated;
      }
    }

    const resetWhile = !when && whileCount > 0;
    if (resetWhile) this.whileIterations.delete(row.id);
    this.lastWhen.set(row.id, when);
    if (priorWhen !== when || row.last_error || resetWhile) {
      this.store.updateEvaluation(row.id, { matched: when, error: null, ...(resetWhile ? { whileIterations: 0 } : {}) });
      const refreshed = this.store.getRule(row.id);
      if (refreshed) this.rules.set(row.id, refreshed);
    }
    if (!shouldRun) return;

    const branch = result.branch;
    if (branch === 'none') {
      this.store.updateEvaluation(row.id, { matched: when, outcome: 'guarded', error: null });
      return;
    }
    if (row.definition.while && branch === 'then') {
      const nextWhileIterations = whileCount + 1;
      this.whileIterations.set(row.id, nextWhileIterations);
      this.store.updateEvaluation(row.id, { matched: when, whileIterations: nextWhileIterations });
      const refreshed = this.store.getRule(row.id);
      if (refreshed) this.rules.set(row.id, refreshed);
    }
    await this.#execute(row, result.actions, trigger, branch);
  }

  #matchingWhenEdge(condition, trigger) {
    if (!conditionUsesEventEdge(condition)) return false;
    try {
      return edgeBranchResult(condition, this.#context(trigger)).edgeMatched;
    } catch {
      return false;
    }
  }

  #context(trigger) {
    const at = Number(trigger.now || trigger.event?.timestamp || this.now());
    const overrides = trigger.values || {};
    const resolve = (ref) => {
      if (overrides instanceof Map && overrides.has(ref)) return overrides.get(ref);
      if (overrides && Object.hasOwn(overrides, ref)) return overrides[ref];
      return this.resolve(ref, at, trigger);
    };
    return {
      now: at,
      resolve,
      history: {
        changedTo: ({ ref, expected }) => this.#matchesChange(ref, trigger, (change) => isDeepStrictEqual(change.to, expected)),
        changedFrom: ({ ref, expected }) => this.#matchesChange(ref, trigger, (change) => isDeepStrictEqual(change.from, expected)),
        forDuration: ({ ref, expected, durationMs }) => this.#held(ref, expected, durationMs, at, resolve),
        hasBeen: ({ ref, expected, durationMs }) => this.#held(ref, expected, durationMs, at, resolve),
        within: ({ ref, expected, expectedProvided, withinMs }) => {
          const latest = this.#lastOccurrence(ref, expected, expectedProvided);
          return latest != null && at - latest <= withinMs;
        },
        hasntHappened: ({ ref, expected, expectedProvided, withinMs }) => {
          const latest = this.#lastOccurrence(ref, expected, expectedProvided);
          const created = finiteTime(trigger.ruleCreatedAt) || at;
          return at - Math.max(latest || 0, created) >= withinMs;
        },
      },
    };
  }

  #matchesChange(ref, trigger, predicate) {
    const direct = trigger.change;
    if (direct && this.#sameSourceRef(ref, direct.ref) && predicate(direct)) return true;
    const event = trigger.event;
    if (!event) return false;
    if (ref === 'event.type') return predicate({ from: null, to: event.type, ts: event.timestamp });
    if (ref === 'event.source') return predicate({ from: null, to: event.source, ts: event.timestamp });
    if (ref.startsWith('event.data.')) {
      const field = ref.slice('event.data.'.length);
      return predicate({ from: undefined, to: ownPath(event.data, field), ts: event.timestamp });
    }
    return false;
  }

  #sameSourceRef(left, right) {
    if (left === right) return true;
    if (left.startsWith('location.') && right.startsWith('ha.person.')) {
      return left.slice('location.'.length).replace(/\.state$/, '') === right.slice('ha.person.'.length).replace(/\.state$/, '');
    }
    if (left.startsWith('location.') && right.startsWith('ha.device_tracker.')) {
      return left.slice('location.'.length).replace(/\.state$/, '') === right.slice('ha.device_tracker.'.length).replace(/\.state$/, '');
    }
    if (left.startsWith('weather.') && right.startsWith('ha.weather.') && right.endsWith('.state')) {
      const entityId = right.slice(3, -'.state'.length);
      if (left === 'weather.status') return this.#weatherEntity()?.entity_id === entityId;
      return left === `weather.${entityId.slice('weather.'.length)}.status`;
    }
    return false;
  }

  #held(ref, expected, durationMs, at, resolve) {
    if (!isDeepStrictEqual(resolve(ref), expected)) return false;
    const changedAt = this.#changedAt(ref);
    return changedAt != null && at - changedAt >= durationMs;
  }

  #lastOccurrence(ref, expected, expectedProvided) {
    const history = this.valueHistory.get(ref) || [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (!expectedProvided || isDeepStrictEqual(history[index].to, expected)) return history[index].ts;
    }
    if (ref === 'event.type') {
      const events = this.store.recentEvents(5_000);
      const match = events.find((event) => !expectedProvided || event.type === expected);
      return match?.ts ?? null;
    }
    if (ref === 'event.source') {
      const match = this.store.recentEvents(5_000)
        .find((event) => !expectedProvided || isDeepStrictEqual(event.source, expected));
      return match?.ts ?? null;
    }
    if (ref.startsWith('event.data.')) {
      const field = ref.slice('event.data.'.length);
      const match = this.store.recentEvents(5_000).find((event) => {
        const value = ownPath(event.data, field);
        return expectedProvided ? isDeepStrictEqual(value, expected) : value !== undefined;
      });
      return match?.ts ?? null;
    }
    if (ref.startsWith('event.')) {
      const eventType = ref.slice('event.'.length);
      const match = this.store.recentEvents(5_000).find((event) => event.type === eventType);
      return match?.ts ?? null;
    }
    // last_changed/updated_at says that *something* changed, not that it
    // changed to the expected value. It is a valid fallback only for the
    // unary "this value happened" form; otherwise it would make
    // WITHIN(light=on) true after a transition to off.
    return expectedProvided ? null : this.#changedAt(ref);
  }

  #changedAt(ref) {
    const latest = this.valueHistory.get(ref)?.at(-1)?.ts;
    if (latest) return latest;
    const haRef = this.#parseHaRef(ref);
    if (haRef) return this.#isVisibleEntity(haRef.entityId) ? finiteTime(this.ha.states.get(haRef.entityId)?.last_changed) : null;
    if (ref.startsWith('location.')) {
      const rest = ref.slice('location.'.length);
      const suffix = ['.age_seconds', '.last_changed', '.fresh', '.state'].find((candidate) => rest.endsWith(candidate));
      const state = this.#locationState(suffix ? rest.slice(0, -suffix.length) : rest);
      return finiteTime(state?.last_changed);
    }
    if (ref.startsWith('variable.')) return this.store.getVariable(ref.slice('variable.'.length))?.updated_at ?? null;
    return null;
  }

  resolve(ref, at = this.now(), trigger = {}) {
    const date = new Date(at);
    if (ref === 'time.now') return nowIso(at);
    if (ref === 'time.timestamp') return at;
    if (ref === 'time.hour') return date.getHours();
    if (ref === 'time.minute') return date.getMinutes();
    if (ref === 'time.second') return date.getSeconds();
    if (ref === 'time.day_of_week') return date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    if (ref === 'time.date') return date.toLocaleDateString('en-CA');
    if (ref === 'time.is_weekend') return date.getDay() === 0 || date.getDay() === 6;
    if (ref === 'event.type') return trigger.event?.type;
    if (ref === 'event.source') return trigger.event?.source;
    if (ref.startsWith('event.data.')) return ownPath(trigger.event?.data, ref.slice('event.data.'.length));

    const needsHa = ref.startsWith('ha.') || ref.startsWith('location.') || ref.startsWith('weather.') ||
      ref === 'count.entities' || ref === 'count.entities.on' || ref.startsWith('count.domain.');
    if (needsHa && !this.isHaReady()) {
      throw new RuleEvaluationError('Home Assistant is not connected; live entity values are unavailable', { ref });
    }
    if (ref.startsWith('atlas.') && !this.isAtlasReady()) {
      throw new RuleEvaluationError('Project Atlas has not supplied a current snapshot', { ref });
    }

    const haRef = this.#parseHaRef(ref);
    if (haRef) {
      if (!this.#isVisibleEntity(haRef.entityId)) return undefined;
      const state = this.ha.states.get(haRef.entityId);
      if (!state) return undefined;
      if (haRef.field === 'state') return state.state;
      if (haRef.field === 'last_changed') return state.last_changed;
      if (haRef.field === 'age_seconds') return Math.max(0, Math.round((at - Date.parse(state.last_changed)) / 1000));
      if (haRef.field.startsWith('attribute.')) return state.attributes?.[haRef.field.slice('attribute.'.length)];
    }

    if (ref.startsWith('location.')) {
      const rest = ref.slice('location.'.length);
      const suffixes = ['.age_seconds', '.last_changed', '.fresh', '.state'];
      const suffix = suffixes.find((candidate) => rest.endsWith(candidate));
      const person = suffix ? rest.slice(0, -suffix.length) : rest;
      const field = suffix ? suffix.slice(1) : 'state';
      const state = this.#locationState(person);
      if (!state) return undefined;
      if (field === 'state') return state.state;
      if (field === 'last_changed') return state.last_changed;
      const ageSeconds = Math.max(0, Math.round((at - Date.parse(state.last_changed)) / 1_000));
      if (field === 'age_seconds') return ageSeconds;
      if (field === 'fresh') return ageSeconds <= 15 * 60;
    }
    if (ref === 'atlas.projects.count') return this.atlas?.snapshot?.projects?.length ?? 0;
    if (ref === 'atlas.tasks.count') return this.atlas?.snapshot?.tasks?.length ?? 0;
    if (ref.startsWith('atlas.project.')) {
      const rest = ref.slice('atlas.project.'.length);
      const dot = rest.lastIndexOf('.');
      const id = dot === -1 ? rest : rest.slice(0, dot);
      const field = dot === -1 ? 'state' : rest.slice(dot + 1);
      const project = this.atlas?.snapshot?.projects?.find((item) => item.id === id);
      if (!project) return undefined;
      if (field === 'exists') return true;
      if (field === 'state') return project.state || project.status;
      return project[field];
    }
    if (ref.startsWith('atlas.task.')) {
      const rest = ref.slice('atlas.task.'.length);
      const dot = rest.lastIndexOf('.');
      const id = dot === -1 ? rest : rest.slice(0, dot);
      const field = dot === -1 ? 'state' : rest.slice(dot + 1);
      return this.atlas?.snapshot?.tasks?.find((task) => task.id === id)?.[field];
    }

    if (ref.startsWith('timer.') || ref.startsWith('alarm.')) {
      const kind = ref.startsWith('alarm.') ? 'alarm' : 'timer';
      const rest = ref.slice(kind.length + 1);
      const dot = rest.lastIndexOf('.');
      const name = dot === -1 ? rest : rest.slice(0, dot);
      const field = dot === -1 ? 'state' : rest.slice(dot + 1);
      const timer = this.store.getTimer(name);
      if (!timer || timer.kind !== kind) return undefined;
      if (field === 'state' || field === 'status') return timer.status;
      if (field === 'remaining_seconds') {
        const remainingMs = timer.status === 'paused' ? timer.paused_remaining_ms : timer.due_at - at;
        return Math.max(0, Math.ceil(Number(remainingMs || 0) / 1000));
      }
      if (field === 'due_at') return nowIso(timer.due_at);
      if (field === 'finished') return timer.status === 'fired';
    }

    if (ref.startsWith('weather.')) return this.#weatherValue(ref.slice('weather.'.length));
    if (ref === 'carvis.busy') return Boolean(this.getCarvisState()?.busy);
    if (ref === 'carvis.voice_muted') return !Boolean(this.getVoiceState()?.enabled);
    if (ref === 'carvis.glasses_connected') return Boolean(this.getCarvisState()?.glassesConnected);
    if (ref === 'memory.count') return this.memory?.state()?.total ?? 0;
    if (ref === 'memory.facts.count') return this.memory?.state()?.facts ?? 0;
    if (ref === 'memory.preferences.count') return this.memory?.state()?.preferences ?? 0;
    if (ref.startsWith('memory.item.')) {
      const rest = ref.slice('memory.item.'.length);
      const dot = rest.lastIndexOf('.');
      const id = dot === -1 ? rest : rest.slice(0, dot);
      const field = dot === -1 ? 'exists' : rest.slice(dot + 1);
      const item = this.memory?.all?.().find((memory) => memory.id === id || memory.dmr?.legacyId === id);
      if (field === 'exists') return Boolean(item);
      return item?.[field];
    }
    if (ref.startsWith('variable.')) return this.store.getVariable(ref.slice('variable.'.length))?.value;
    if (ref.startsWith('count.')) return this.#countValue(ref.slice('count.'.length));
    return undefined;
  }

  #parseHaRef(ref) {
    if (!ref.startsWith('ha.')) return null;
    const body = ref.slice(3);
    const markers = ['.attribute.', '.last_changed', '.age_seconds', '.state'];
    for (const marker of markers) {
      const index = body.indexOf(marker);
      if (index <= 0) continue;
      return { entityId: body.slice(0, index), field: marker === '.attribute.' ? `attribute.${body.slice(index + marker.length)}` : marker.slice(1) };
    }
    return { entityId: body, field: 'state' };
  }

  #locationState(person) {
    const wanted = slug(person);
    const exact = this.ha.states.get(`person.${wanted}`) || this.ha.states.get(`device_tracker.${wanted}`);
    if (exact && this.#isVisibleEntity(exact.entity_id)) return exact;
    return [...this.ha.states.values()].find((state) => {
      if (!state.entity_id.startsWith('person.') && !state.entity_id.startsWith('device_tracker.')) return false;
      return this.#isVisibleEntity(state.entity_id) && slug(state.attributes?.friendly_name || state.entity_id.split('.')[1]) === wanted;
    });
  }

  #weatherEntity(requested = '') {
    if (requested && this.ha.states.has(requested) && this.#isVisibleEntity(requested)) return this.ha.states.get(requested);
    const id = requested.startsWith('weather.') ? requested : `weather.${requested}`;
    if (requested && this.ha.states.has(id) && this.#isVisibleEntity(id)) return this.ha.states.get(id);
    return [...this.ha.states.values()].find((state) => state.entity_id.startsWith('weather.') && this.#isVisibleEntity(state.entity_id));
  }

  #weatherValue(path) {
    const knownFields = new Set(['status', 'temperature', 'humidity', 'pressure', 'wind_speed', 'wind_bearing', 'visibility', 'forecast']);
    const parts = path.split('.');
    let field = parts.at(-1);
    let requested = parts.slice(0, -1).join('.');
    if (!knownFields.has(field)) { requested = path; field = 'status'; }
    const state = this.#weatherEntity(requested);
    if (!state) return undefined;
    if (field === 'status') return state.state;
    return state.attributes?.[field];
  }

  #countValue(path) {
    const visible = this.#visibleEntityIds();
    if (path === 'entities') return visible.size;
    if (path === 'entities.on') return [...this.ha.states.values()].filter((state) => visible.has(state.entity_id) && state.state === 'on').length;
    if (path.startsWith('domain.')) {
      const domain = path.slice('domain.'.length);
      return [...visible].filter((id) => id.startsWith(`${domain}.`)).length;
    }
    if (path === 'timers.active') return this.store.listTimers({ activeOnly: true, kind: 'timer' }).length;
    if (path === 'alarms.active') return this.store.listTimers({ activeOnly: true, kind: 'alarm' }).length;
    if (path === 'rules.enabled') return [...this.rules.values()].filter((rule) => rule.enabled && !rule.archived).length;
    return undefined;
  }

  async #execute(row, actions, trigger, branch) {
    if (this.running.has(row.id)) return { ok: false, outcome: 'busy', error: 'rule is already running' };
    this.running.add(row.id);
    const started = this.now();
    const runId = `run_${randomUUID().slice(0, 12)}`;
    const results = [];
    let outcome = 'ok';
    let error = null;
    try {
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        const result = await this.#executeAction(action, {
          rule: row,
          runId,
          actionIndex: index,
          trigger,
        });
        results.push({ index, type: action.type, ...result });
        if (result.success === false) {
          outcome = 'partial';
          error ||= result.error || `${action.type} failed`;
          if (row.definition.metadata?.stopOnError !== false) break;
        }
      }
    } catch (err) {
      outcome = 'error';
      error = err.message;
      results.push({ index: results.length, type: actions[results.length]?.type || 'unknown', success: false, error });
    } finally {
      this.running.delete(row.id);
    }
    const run = this.store.recordRun({
      id: runId,
      ruleId: row.id,
      ts: started,
      trigger: { kind: trigger.kind, event: trigger.event, branch, forced: Boolean(trigger.forced) },
      outcome,
      actions: results,
      error,
      ms: this.now() - started,
    });
    this.store.updateEvaluation(row.id, { matched: true, fired: true, outcome, error });
    const refreshed = this.store.getRule(row.id);
    if (refreshed) this.rules.set(row.id, refreshed);
    if (row.definition.metadata?.once && outcome === 'ok') this.setEnabled(row.id, false);
    this.#changed(outcome === 'ok' ? 'automation.fired' : 'automation.failed', {
      rule: publicRule(refreshed || row),
      run: publicRun(run),
    });
    log(outcome === 'ok' ? 'action' : 'warn', `Automation ${row.name}: ${outcome} (${results.length} action${results.length === 1 ? '' : 's'})`);
    return { ok: outcome === 'ok', outcome, actions: results, error, run: publicRun(run) };
  }

  async #executeAction(action, ctx) {
    if (action.type === 'tool.call') {
      if (!this.#automatableTool(action.tool)) {
        return { success: false, error: `${action.tool} is not permitted in unattended rules` };
      }
      const result = await this.gateway.call(action.tool, action.arguments || {}, {
        triggerType: 'automation',
        reason: `automation "${ctx.rule.name}"`,
        ruleId: ctx.rule.id,
        automationRunId: ctx.runId,
        idempotencyPrefix: `${ctx.runId}:${ctx.actionIndex}`,
      });
      return { success: result.success !== false, tool: action.tool, result };
    }
    if (action.type === 'variable.set') {
      const before = this.store.getVariable(action.name)?.value;
      const variable = this.store.setVariable(action.name, action.value, `rule:${ctx.rule.id}`);
      this.#emitValueChange(`variable.${action.name}`, before, variable.value);
      this.#changed('variable.changed', { variable });
      return { success: true, variable };
    }
    if (action.type === 'timer.start') {
      const timer = this.startTimer({
        name: action.timer,
        durationMs: action.durationMs,
        payload: action.payload || {},
        ruleId: ctx.rule.id,
      });
      return { success: true, timer };
    }
    if (action.type === 'timer.cancel') {
      const cancelled = this.cancelTimerKind(action.timer, 'timer');
      return cancelled ? { success: true, cancelled } : { success: false, error: `no active timer ${action.timer}` };
    }
    if (action.type === 'rule.enable' || action.type === 'rule.disable') {
      if (action.ruleId === ctx.rule.id) return { success: false, error: 'a rule cannot toggle itself' };
      const target = this.setEnabled(action.ruleId, action.type === 'rule.enable');
      return target ? { success: true, rule: target } : { success: false, error: `no rule ${action.ruleId}` };
    }
    if (action.type === 'carvis.wake') {
      const result = await this.onWake({
        trigger: {
          type: 'automation',
          reason: 'automation_rule',
          rule_id: ctx.rule.id,
          rule_name: ctx.rule.name,
          requested: String(action.prompt || ''),
          event: ctx.trigger.event?.type,
          event_data: ctx.trigger.event?.data,
        },
      });
      if (result?.outcome === 'busy') {
        const retry = this.#deferWake({
          prompt: String(action.prompt || ''),
          source: 'rule',
          sourceId: ctx.rule.id,
          sourceName: ctx.rule.name,
          retryCount: 0,
        });
        return { success: true, deferred: true, retry, result };
      }
      return { success: result?.outcome !== 'error', result };
    }
    if (action.type === 'speech.say') {
      const result = await this.gateway.call('speech.say', {
        text: String(action.text),
        ...(action.voice ? { voice: action.voice } : {}),
        ...(action.media_player ? { media_player: action.media_player } : {}),
        ...(action.tts_entity ? { tts_entity: action.tts_entity } : {}),
        ...(action.language ? { language: action.language } : {}),
        ...(typeof action.cache === 'boolean' ? { cache: action.cache } : {}),
      }, {
        triggerType: 'automation',
        reason: `automation "${ctx.rule.name}"`,
        idempotencyPrefix: `${ctx.runId}:${ctx.actionIndex}`,
      });
      return { success: result.success !== false, tool: 'speech.say', result };
    }
    if (action.type.startsWith('hud.')) {
      const aliases = { 'hud.show': 'hud.set_widget', 'hud.clear': 'hud.clear_all', 'hud.camera': 'hud.show_camera' };
      const tool = aliases[action.type] || action.type;
      const payload = tool === 'hud.show_notification'
        // Saved rules are proactive by definition. Keep them behind the HUD's
        // interruption limiter so a tight WHILE cannot take over the owner's
        // vision. Timers/alarms use their separate explicitly-scheduled path.
        ? { ...(action.payload || {}), proactive: true }
        : action.payload || {};
      const result = await this.gateway.call(tool, payload, {
        triggerType: 'automation',
        reason: `automation "${ctx.rule.name}"`,
        idempotencyPrefix: `${ctx.runId}:${ctx.actionIndex}`,
      });
      return { success: result.success !== false, tool, result };
    }
    return { success: false, error: `unsupported action ${action.type}` };
  }

  startTimer({ name, durationMs, dueAt, repeatMs = null, payload = {}, kind = 'timer', ruleId = null }) {
    const now = this.now();
    const due = finiteTime(dueAt) ?? now + Number(durationMs || 0);
    const delay = due - now;
    if (!Number.isFinite(due) || !Number.isSafeInteger(Math.round(due)) || delay < MIN_TIMER_DURATION_MS || delay > MAX_TIMER_DURATION_MS) {
      throw new Error(`${kind} must be scheduled 1 second to 365 days in the future`);
    }
    const active = this.store.listTimers({ activeOnly: true, limit: MAX_ACTIVE_TIMERS + 1 });
    if (active.length >= MAX_ACTIVE_TIMERS) throw new Error(`Carvis already has the maximum ${MAX_ACTIVE_TIMERS} active timers and alarms`);
    if (ruleId && active.filter((timer) => timer.rule_id === ruleId).length >= MAX_ACTIVE_TIMERS_PER_RULE) {
      throw new Error(`automation ${ruleId} already has ${MAX_ACTIVE_TIMERS_PER_RULE} active timers`);
    }
    const timer = this.store.createTimer({ name, kind, dueAt: due, repeatMs, payload, ruleId });
    this.#emitValueChange(`${kind}.${timer.name}.status`, undefined, 'active', now);
    this.#emitValueChange(`${kind}.${timer.id}.status`, undefined, 'active', now);
    this.#changed(`${kind}.changed`, { timer: publicTimer(timer, now) });
    return publicTimer(timer, now);
  }

  listTimers({ kind = '', activeOnly = false } = {}) {
    return this.store.listTimers({ kind, activeOnly, limit: 500 }).map((timer) => publicTimer(timer, this.now()));
  }

  getTimer(idOrName) {
    return publicTimer(this.store.getTimer(idOrName), this.now());
  }

  cancelTimer(idOrName) {
    const before = this.store.getTimer(idOrName);
    const count = this.store.cancelTimer(idOrName);
    if (count && before) {
      this.#emitValueChange(`${before.kind}.${before.name}.status`, before.status, 'cancelled');
      this.#emitValueChange(`${before.kind}.${before.id}.status`, before.status, 'cancelled');
      this.#changed(`${before.kind}.changed`, { id: before.id, status: 'cancelled' });
    }
    return count;
  }

  cancelTimerKind(idOrName, kind) {
    const timer = this.getTimer(idOrName);
    if (!timer || timer.kind !== kind || !['active', 'paused'].includes(timer.status)) return 0;
    return this.cancelTimer(timer.id);
  }

  pauseTimer(idOrName) {
    const before = this.store.getTimer(idOrName);
    const timer = this.store.pauseTimer(idOrName, this.now());
    if (timer) {
      this.#emitValueChange(`${timer.kind}.${timer.name}.status`, before?.status, timer.status);
      this.#emitValueChange(`${timer.kind}.${timer.id}.status`, before?.status, timer.status);
      this.#changed(`${timer.kind}.changed`, { timer: publicTimer(timer, this.now()) });
    }
    return publicTimer(timer, this.now());
  }

  resumeTimer(idOrName) {
    const before = this.store.getTimer(idOrName);
    const timer = this.store.resumeTimer(idOrName, this.now());
    if (timer) {
      this.#emitValueChange(`${timer.kind}.${timer.name}.status`, before?.status, timer.status);
      this.#emitValueChange(`${timer.kind}.${timer.id}.status`, before?.status, timer.status);
      this.#changed(`${timer.kind}.changed`, { timer: publicTimer(timer, this.now()) });
    }
    return publicTimer(timer, this.now());
  }

  snoozeAlarm(idOrName, durationMs) {
    const before = this.store.getTimer(idOrName);
    const timer = this.store.snoozeTimer(idOrName, durationMs, this.now());
    if (timer) {
      this.#emitValueChange(`alarm.${timer.name}.status`, before?.status, timer.status);
      this.#emitValueChange(`alarm.${timer.id}.status`, before?.status, timer.status);
      this.#changed('alarm.changed', { timer: publicTimer(timer, this.now()) });
    }
    return publicTimer(timer, this.now());
  }

  variable(name) {
    return this.store.getVariable(name);
  }

  variables() {
    return this.store.listVariables();
  }

  unsetVariable(name) {
    const before = this.store.getVariable(name)?.value;
    const removed = this.store.deleteVariable(name);
    if (removed) {
      this.#emitValueChange(`variable.${name}`, before, undefined);
      this.#changed('variable.changed', { name, removed: true });
    }
    return removed;
  }

  setVariable(name, value, updatedBy = 'owner') {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(String(name || ''))) throw new Error('invalid variable name');
    const before = this.store.getVariable(name)?.value;
    const variable = this.store.setVariable(name, value, updatedBy);
    this.#emitValueChange(`variable.${name}`, before, value);
    this.#changed('variable.changed', { variable });
    return variable;
  }

  incrementVariable(name, amount = 1, updatedBy = 'owner') {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(String(name || ''))) throw new Error('invalid variable name');
    const before = this.store.getVariable(name)?.value;
    const variable = this.store.incrementVariable(name, amount, updatedBy);
    this.#emitValueChange(`variable.${name}`, before, variable.value);
    this.#changed('variable.changed', { variable });
    return variable;
  }

  async #fireDueTimers(now) {
    for (const timer of this.store.dueTimers(now)) {
      if (this.firingTimers.has(timer.id)) continue;
      this.firingTimers.add(timer.id);
      try {
        if (this.#timerNeedsHa(timer) && !this.isHaReady()) continue;
        // Resolve recurrence before any side effect. Corrupt schedule data or
        // a calendar error must never leave an overdue alarm replaying its HUD,
        // speech, or tool actions every second.
        let nextAlarmDue;
        try {
          nextAlarmDue = this.#nextAlarmDue(timer, now);
        } catch (error) {
          this.store.cancelTimer(timer.id);
          this.#emitValueChange(`${timer.kind}.${timer.name}.status`, 'active', 'cancelled', now);
          this.#emitValueChange(`${timer.kind}.${timer.id}.status`, 'active', 'cancelled', now);
          throw new Error(`invalid recurrence; alarm was cancelled before delivery: ${error.message}`);
        }
        const eventType = `${timer.kind}.${slug(timer.name)}.finished`;
        const payload = timer.payload || {};
        const actions = Array.isArray(payload.actions) ? payload.actions : [];
        const actionResults = [];
        for (let index = 0; index < actions.length; index += 1) {
          actionResults.push(await this.#executeTimerAction(actions[index], timer, index));
        }
        if (payload.notify !== false) {
          const text = String(payload.message || `${timer.name} finished`);
          if (payload.hud !== false) {
            // This is the delivery the owner explicitly scheduled, not an
            // unsolicited proactive interruption. It must not disappear behind
            // the ambient-notification rate limiter.
            actionResults.push(await this.gateway.call('hud.show_notification', { text, detail: timer.kind === 'alarm' ? 'Alarm' : 'Timer', seconds: 12, proactive: false }, {
              triggerType: 'automation', reason: `${timer.kind} ${timer.name}`, idempotencyPrefix: timer.id,
            }));
          } else {
            this.feed?.push('note', text, { proactive: false, source: timer.kind });
            actionResults.push({ success: true, tool: 'feed.push' });
          }
          if (payload.speak) {
            actionResults.push(await this.gateway.call('speech.say', {
              text,
              ...(payload.media_player ? { media_player: payload.media_player } : {}),
              ...(payload.tts_entity ? { tts_entity: payload.tts_entity } : {}),
            }, {
              triggerType: 'automation',
              reason: `${timer.kind} ${timer.name}`,
              scheduled: true,
              idempotencyPrefix: `${timer.id}:${timer.due_at}`,
            }));
          }
        }
        if (nextAlarmDue != null) {
          // Daily/weekday alarms recur at the same wall-clock time, not every
          // 86,400,000ms. The distinction is the hour either side of DST.
          const rescheduled = this.store.rescheduleTimer?.(timer.id, nextAlarmDue, now);
          if (!rescheduled) throw new Error('could not atomically schedule the next alarm occurrence');
        } else {
          this.store.markTimerFired(timer.id, timer.repeat_ms);
        }
        const recurring = Boolean(timer.repeat_ms) || Boolean(
          timer.payload?.schedule?.repeat && timer.payload.schedule.repeat !== 'none',
        );
        const nextStatus = recurring ? 'active' : 'fired';
        this.#emitValueChange(`${timer.kind}.${timer.name}.status`, 'active', nextStatus, now);
        this.#emitValueChange(`${timer.kind}.${timer.id}.status`, 'active', nextStatus, now);
        const event = this.bus?.publish(eventType, 'automation', {
          timer_id: timer.id,
          name: timer.name,
          kind: timer.kind,
          due_at: timer.due_at,
          actions: actionResults.map((result) => ({ success: result?.success !== false })),
        });
        // The generic event is the stable protocol trigger for a timer the
        // owner already created. The named event above remains available for
        // integrations that need a human-readable event type. Both carry the
        // exact timer id, so a protocol never has to guess the name slug.
        this.bus?.publish(`${timer.kind}.finished`, 'automation', {
          timer_id: timer.id,
          name: timer.name,
          kind: timer.kind,
          due_at: timer.due_at,
          actions: actionResults.map((result) => ({ success: result?.success !== false })),
        });
        this.#changed(`${timer.kind}.changed`, { timer: publicTimer(this.store.getTimer(timer.id), now), event });
      } catch (err) {
        log('error', `${timer.kind} ${timer.name} failed: ${err.message}`);
      } finally {
        this.firingTimers.delete(timer.id);
      }
    }
  }

  #timerNeedsHa(timer) {
    const payload = timer.payload || {};
    if (payload.speak) return true;
    return (Array.isArray(payload.actions) ? payload.actions : []).some((action) =>
      action?.type === 'tool.call' && (/^ha\./.test(action.tool) || action.tool === 'speech.say' || action.tool === 'weather.get_status')
    );
  }

  async #executeTimerAction(action, timer, index) {
    if (action?.type === 'carvis.wake') {
      const result = await this.onWake({ trigger: { type: 'automation', reason: `${timer.kind}_finished`, timer_id: timer.id, requested: String(action.prompt || timer.payload?.message || '') } });
      if (result?.outcome !== 'busy') return result;
      const retryCount = Number(timer.payload?.retryCount || 0);
      if (retryCount >= 30) return { success: false, outcome: 'busy', error: 'Carvis remained busy after 30 retries' };
      const retry = this.#deferWake({
        prompt: String(action.prompt || timer.payload?.message || ''),
        source: timer.kind,
        sourceId: timer.id,
        sourceName: timer.name,
        retryCount: retryCount + 1,
      });
      return { success: true, outcome: 'deferred', retry };
    }
    if (action?.type === 'tool.call' && this.#automatableTool(action.tool)) {
      return this.gateway.call(action.tool, action.arguments || {}, {
        triggerType: 'automation',
        reason: `${timer.kind} "${timer.name}"`,
        scheduled: true,
        // A recurring timer has many legitimate occurrences. Scope dedupe to
        // this deadline so retries of one occurrence collapse while tomorrow's
        // occurrence still executes.
        idempotencyPrefix: `${timer.id}:${timer.due_at}:${index}`,
      });
    }
    return { success: false, error: 'timer actions must be carvis.wake or an automatable tool.call' };
  }

  #nextAlarmDue(timer, now) {
    const schedule = timer.kind === 'alarm' ? timer.payload?.schedule : null;
    if (!schedule || schedule.repeat === 'none') return null;
    const timeZone = schedule.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const wallTime = schedule.wallTime;
    if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(String(wallTime || ''))) return null;
    return nextAlarmOccurrence({
      after: now,
      wallTime,
      timeZone,
      repeat: schedule.repeat,
      days: schedule.days,
      weekday: schedule.weekday,
    });
  }

  #deferWake({ prompt, source, sourceId, sourceName, retryCount }) {
    return this.startTimer({
      name: `Retry ${sourceName || sourceId || 'Carvis wake'}`,
      durationMs: 2_000,
      payload: {
        notify: false,
        retryCount,
        actions: [{ type: 'carvis.wake', prompt }],
        deferredFrom: { source, id: sourceId },
      },
    });
  }

  /**
   * Event types this install has actually seen, commonest first. Read from
   * persisted history rather than a live counter so it is useful immediately
   * after a restart, before Home Assistant has emitted anything fresh.
   */
  #observedEventTypes(limit = 5000) {
    const counts = new Map();
    try {
      for (const event of this.store.recentEvents(5000)) {
        counts.set(event.type, (counts.get(event.type) || 0) + 1);
      }
    } catch {
      return [];
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([type, seen]) => ({ type, seen }));
  }

  #eventChoices() {
    const events = new Map(this.#observedEventTypes().map((event) => [event.type, event]));
    for (const kind of ['timer', 'alarm']) {
      events.set(`${kind}.finished`, { type: `${kind}.finished`, builtin: true });
    }
    for (const timer of this.store.listTimers({})) {
      const type = `${timer.kind || 'timer'}.${slug(timer.name)}.finished`;
      events.set(type, { type, builtin: true });
    }
    return [...events.values()];
  }

  #stateChoices(entityId) {
    const state = this.ha.states.get(entityId);
    const domain = entityId.split('.')[0];
    const standard = {
      light: ['on', 'off'], switch: ['on', 'off'], binary_sensor: ['on', 'off'],
      input_boolean: ['on', 'off'], lock: ['locked', 'unlocked', 'locking', 'unlocking', 'jammed', 'open', 'opening'],
      cover: ['open', 'closed', 'opening', 'closing'],
      media_player: ['off', 'on', 'idle', 'playing', 'paused', 'standby', 'buffering'],
    }[domain] || [];
    const history = this.store.recentValueChanges(`ha.${entityId}.state`, 5000);
    return [...new Set([
      ...standard, ...(Array.isArray(state?.attributes?.options) ? state.attributes.options : []),
      state?.state, ...history.flatMap((change) => [change.from, change.to]),
      'unknown', 'unavailable',
    ].filter((value) => typeof value === 'string'))];
  }

  catalog() {
    const inventory = new Map(this.gateway.inventory().map((tool) => [tool.name, tool]));
    const tools = this.gateway.definitions().map((definition) => {
      const details = inventory.get(definition.name) || {};
      return { ...definition, ...details, automatable: this.#automatableTool(definition.name) };
    });
    const config = this.getConfig?.() || {};
    const observed = new Set(config.entities?.observed || []);
    const controlled = new Set(config.entities?.controlled || []);
    const entities = this.ha.listEntities().filter((entity) => observed.has(entity.entity_id) || controlled.has(entity.entity_id)).map((entity) => ({
      ...entity,
      observed: observed.has(entity.entity_id),
      controllable: controlled.has(entity.entity_id),
      ref: `ha.${entity.entity_id}.state`,
      known_states: this.#stateChoices(entity.entity_id),
    }));
    return {
      version: RULE_SCHEMA_VERSION,
      values: [
        { namespace: 'time', label: 'Time', examples: ['time.now', 'time.hour', 'time.minute', 'time.day_of_week', 'time.is_weekend'] },
        { namespace: 'ha', label: 'Home Assistant', examples: ['ha.light.living_room.state', 'ha.sensor.temperature.state'] },
        { namespace: 'atlas', label: 'Project Atlas', examples: ['atlas.projects.count', 'atlas.tasks.count', 'atlas.project.<id>.state', 'atlas.task.<id>.state'] },
        { namespace: 'timer', label: 'Timer', examples: ['timer.pasta.status', 'timer.pasta.remaining_seconds'] },
        { namespace: 'alarm', label: 'Alarm clock / reminder', examples: ['alarm.morning.status'] },
        { namespace: 'weather', label: 'Weather', examples: ['weather.status', 'weather.temperature', 'weather.humidity'] },
        { namespace: 'location', label: 'Location', examples: ['location.owner', 'location.owner.fresh', 'location.owner.age_seconds'] },
        { namespace: 'carvis', label: 'Carvis', examples: ['carvis.busy', 'carvis.voice_muted', 'carvis.glasses_connected'] },
        { namespace: 'memory', label: 'Memory', examples: ['memory.count', 'memory.facts.count', 'memory.item.<id>.exists'] },
        { namespace: 'variable', label: 'Variable', examples: ['variable.my_counter'] },
        { namespace: 'count', label: 'Count', examples: ['count.entities', 'count.rules.enabled', 'count.timers.active'] },
        { namespace: 'event', label: 'Event', examples: ['event.type', 'event.source', 'event.data.entity_id', 'timer.finished', 'alarm.finished'] },
      ],
      operators: [
        ['equals', 'equals'], ['not_equals', 'does not equal'], ['changed_to', 'changed to'],
        ['changed_from', 'changed from'], ['greater_than', 'is greater than'], ['less_than', 'is less than'],
        ['contains', 'contains'], ['for_duration', 'for duration'], ['within', 'within'],
        ['has_been', 'has been'], ['hasnt_happened', "hasn't happened"],
      ].map(([id, label]) => ({ id, label })),
      actions: [
        { id: 'tool.call', label: 'Call a tool' },
        { id: 'variable.set', label: 'Set a variable' },
        { id: 'timer.start', label: 'Start a timer' },
        { id: 'timer.cancel', label: 'Cancel a timer' },
        { id: 'rule.enable', label: 'Enable a rule' },
        { id: 'rule.disable', label: 'Disable a rule' },
        { id: 'carvis.wake', label: 'Wake Carvis' },
        { id: 'hud.set_widget', label: 'Show HUD text' },
        { id: 'hud.show_camera', label: 'Show HUD camera' },
        { id: 'hud.show_notification', label: 'Show HUD notification' },
        { id: 'speech.say', label: 'Speak text' },
      ],
      tools,
      options: {
        entities,
        locations: entities.filter((entity) => entity.domain === 'person' || entity.domain === 'device_tracker'),
        weather: entities.filter((entity) => entity.domain === 'weather'),
        mediaPlayers: entities.filter((entity) => entity.domain === 'media_player'),
        tts: entities.filter((entity) => entity.domain === 'tts'),
        atlasProjects: clone(this.atlas?.snapshot?.projects || []),
        atlasTasks: clone(this.atlas?.snapshot?.tasks || []),
        // Event *types actually observed*, not just the shape of the `event.*`
        // namespace. A protocol whose WHEN matches an invented event type is
        // valid, saves cleanly, and then silently never fires — which is the
        // worst failure this engine can have, because it looks like success.
        // This is the one thing the retired `watch.list_events` tool provided
        // that nothing else did, so it moved here rather than being lost.
        events: this.#eventChoices(),
      },
      limits: {
        maxActionRisk: MAX_RULE_ACTION_RISK,
        whileMinRepeatMs: MIN_WHILE_REPEAT_MS,
        whileDefaultRepeatMs: DEFAULT_WHILE_REPEAT_MS,
        whileMaxIterations: MAX_WHILE_ITERATIONS,
      },
    };
  }

  state() {
    const rules = this.list();
    const timers = this.listTimers({ activeOnly: true });
    const runs = this.store.listRuns({ limit: 20 }).map(publicRun);
    return {
      started: this.started,
      rules: {
        total: rules.length,
        enabled: rules.filter((rule) => rule.enabled).length,
        failed: rules.filter((rule) => rule.lastError).length,
        items: rules,
      },
      timers: timers.filter((timer) => timer.kind === 'timer'),
      alarms: timers.filter((timer) => timer.kind === 'alarm'),
      variables: this.variables(),
      recentRuns: runs,
    };
  }

  #changed(type, payload) {
    try {
      this.onChange({ type, ...clone(payload) });
    } catch (err) {
      log('warn', `Could not publish ${type}: ${err.message}`);
    }
  }
}

export { publicRule, publicTimer };
