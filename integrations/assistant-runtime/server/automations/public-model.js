import { summarizeRule } from '../rules/index.js';
import { clone, nowIso } from './rule-helpers.js';

export function publicRule(row) {
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

export function publicTimer(timer, now = Date.now()) {
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

export function publicRun(run) {
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
