/**
 * Carvis's own store.
 *
 * `config.json` was fine for settings and hopeless for everything this layer
 * needs: a protocol must survive a reboot, an audit log must be appendable
 * without rewriting the file, and cost records accumulate forever.
 *
 * This uses `node:sqlite`, which ships with Node — so the store costs no new
 * dependency. Atlas remains the memory system for anything about *you*: your
 * projects, notes, and what you decided. What lives here is Carvis's own
 * operational state — what it is waiting on, what it did, and what that cost.
 * The split is the one in the spec: Atlas remembers, Carvis notices.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ROOT } from './config.js';
import { buildTraceView } from './trace.js';

const DB_PATH = path.join(ROOT, 'carvis.db');

let db = null;

export function open() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  // WAL keeps the long-poll readers from blocking the event writers.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(handle) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      source      TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      data        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_ts   ON events (ts DESC);
    CREATE INDEX IF NOT EXISTS events_type ON events (type, ts DESC);

    CREATE TABLE IF NOT EXISTS watches (
      id           TEXT PRIMARY KEY,
      created_by   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      source       TEXT NOT NULL,
      condition    TEXT NOT NULL,
      reason       TEXT NOT NULL,
      payload      TEXT NOT NULL,
      expires      TEXT NOT NULL,
      expires_at   INTEGER,
      status       TEXT NOT NULL,
      fired_at     INTEGER,
      fire_count   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS watches_status ON watches (status);

    CREATE TABLE IF NOT EXISTS schedules (
      id          TEXT PRIMARY KEY,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      due_at      INTEGER NOT NULL,
      reason      TEXT NOT NULL,
      payload     TEXT NOT NULL,
      repeat_sec  INTEGER,
      status      TEXT NOT NULL,
      fired_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules (status, due_at);

    /* Declarative automations. The definition column is a validated, versioned rule
       program; the remaining columns are operational truth for the editor and
       trace, never a second source of rule semantics. */
    CREATE TABLE IF NOT EXISTS automation_rules (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      archived          INTEGER NOT NULL DEFAULT 0,
      revision          INTEGER NOT NULL DEFAULT 1,
      definition        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      created_by        TEXT NOT NULL,
      last_evaluated_at INTEGER,
      last_fired_at     INTEGER,
      fire_count        INTEGER NOT NULL DEFAULT 0,
      while_iterations  INTEGER NOT NULL DEFAULT 0,
      last_match        INTEGER,
      last_outcome      TEXT,
      last_error        TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_rules_enabled ON automation_rules (enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS automation_runs (
      id          TEXT PRIMARY KEY,
      rule_id     TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      trigger     TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      actions     TEXT NOT NULL,
      error       TEXT,
      ms          INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(rule_id) REFERENCES automation_rules(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS automation_runs_rule ON automation_runs (rule_id, ts DESC);
    CREATE INDEX IF NOT EXISTS automation_runs_ts ON automation_runs (ts DESC);

    CREATE TABLE IF NOT EXISTS automation_variables (
      name       TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_timers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      due_at      INTEGER NOT NULL,
      repeat_ms   INTEGER,
      status      TEXT NOT NULL,
      payload     TEXT NOT NULL,
      rule_id     TEXT,
      paused_remaining_ms INTEGER,
      fired_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS automation_timers_due ON automation_timers (status, due_at);
    CREATE INDEX IF NOT EXISTS automation_timers_name ON automation_timers (name, status);

    /* Only references used by saved rules are written here. This is enough to
       make WITHIN / HAS BEEN / FOR DURATION survive a restart without turning
       every noisy HA sensor into an unbounded second history database. */
    CREATE TABLE IF NOT EXISTS automation_value_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ref        TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      from_value TEXT,
      to_value   TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_value_history_ref
      ON automation_value_history (ref, ts DESC);

    CREATE TABLE IF NOT EXISTS invocations (
      id             TEXT PRIMARY KEY,
      ts             INTEGER NOT NULL,
      trigger_type   TEXT NOT NULL,
      trigger        TEXT NOT NULL,
      role           TEXT NOT NULL,
      provider       TEXT NOT NULL,
      model          TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      rounds         INTEGER NOT NULL DEFAULT 0,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      cached_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd       REAL    NOT NULL DEFAULT 0,
      ms             INTEGER NOT NULL DEFAULT 0,
      outcome        TEXT NOT NULL,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS invocations_ts ON invocations (ts DESC);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id            TEXT PRIMARY KEY,
      invocation_id TEXT,
      ts            INTEGER NOT NULL,
      tool          TEXT NOT NULL,
      arguments     TEXT NOT NULL,
      risk          INTEGER NOT NULL,
      authorization TEXT NOT NULL,
      result        TEXT,
      ok            INTEGER NOT NULL,
      ms            INTEGER NOT NULL DEFAULT 0,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS tool_calls_ts  ON tool_calls (ts DESC);
    CREATE INDEX IF NOT EXISTS tool_calls_inv ON tool_calls (invocation_id);

    /* Observable model-round metadata. This deliberately contains no model
       text, prompt, or hidden reasoning — only the externally verifiable
       shape and timing of each round. */
    CREATE TABLE IF NOT EXISTS invocation_steps (
      id            TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL,
      step          INTEGER NOT NULL,
      round_number  INTEGER NOT NULL DEFAULT 0,
      ts            INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      role          TEXT,
      provider      TEXT,
      model         TEXT,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      tool_count    INTEGER NOT NULL DEFAULT 0,
      outcome       TEXT NOT NULL,
      detail        TEXT,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS invocation_steps_inv ON invocation_steps (invocation_id, step);

    /* The display survives a restart. A widget you asked for an hour ago
       vanishing because the server bounced is the thing bindings exist to
       stop happening. */
    CREATE TABLE IF NOT EXISTS hud_slots (
      slot       INTEGER PRIMARY KEY,
      type       TEXT NOT NULL,
      data       TEXT NOT NULL,
      binding    TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      expires_at INTEGER
    );

    /* Idempotency: a retried watch must not create the same task four times. */
    CREATE TABLE IF NOT EXISTS idempotency (
      key    TEXT PRIMARY KEY,
      ts     INTEGER NOT NULL,
      result TEXT
    );

    /* What Carvis has learned about the owner.
       Split by what a memory DOES, not by topic. A fact answers questions and is
       retrieved per turn. A preference changes how Carvis behaves — when it
       interrupts, what it confirms, how it phrases things — so it rides with the
       persona on every turn instead of waiting to be matched. */
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      ts          INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      text        TEXT NOT NULL,
      source      TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      pinned      INTEGER NOT NULL DEFAULT 0,
      /* When this last reached a prompt. A memory that silently shapes
         behaviour is one the owner cannot audit; this is what makes a wrong
         one visible in the dashboard rather than merely present. */
      used_at     INTEGER,
      use_count   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memories_kind ON memories (kind, pinned DESC, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS memories_fingerprint ON memories (fingerprint);

    /* Every heard utterance with the routing decision it actually got.
       This was memory-only until the owner explicitly approved persisting it,
       because a coherence filter cannot be tuned on the handful of utterances
       that survive a restart. Text only — the audio is still unlinked the
       moment it is transcribed (server/stt.js). */
    CREATE TABLE IF NOT EXISTS transcripts (
      id         TEXT PRIMARY KEY,
      ts         INTEGER NOT NULL,
      source     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      text       TEXT NOT NULL,
      confidence REAL,
      outcome    TEXT NOT NULL,
      detail     TEXT,
      reply      TEXT,
      actions    TEXT
    );
    CREATE INDEX IF NOT EXISTS transcripts_ts      ON transcripts (ts DESC);
    CREATE INDEX IF NOT EXISTS transcripts_outcome ON transcripts (outcome, ts DESC);
  `);

  // Existing databases predate round-level tool attribution. SQLite's ALTER
  // TABLE only adds one column at a time, so keep this tiny compatibility
  // migration separate from the create script above.
  ensureColumn(handle, 'tool_calls', 'round_number', 'INTEGER');
  ensureColumn(handle, 'automation_rules', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(handle, 'automation_rules', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(handle, 'automation_rules', 'while_iterations', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(handle, 'automation_timers', 'paused_remaining_ms', 'INTEGER');
  handle.exec('CREATE INDEX IF NOT EXISTS tool_calls_inv_round ON tool_calls (invocation_id, round_number, ts)');
}

function ensureColumn(handle, table, column, declaration) {
  const columns = handle.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

/* ── events ──────────────────────────────────────────────────── */

export function recordEvent(event) {
  open()
    .prepare('INSERT OR IGNORE INTO events (id, type, source, ts, data) VALUES (?, ?, ?, ?, ?)')
    .run(event.id, event.type, event.source, event.timestamp, JSON.stringify(event.data ?? {}));
}

export function recentEvents(limit = 50) {
  return open()
    .prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?')
    .all(limit)
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

/** Events are for recent awareness, not history — trim so the file stays small. */
export function pruneEvents(keep = 5000) {
  open()
    .prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY ts DESC LIMIT ?)')
    .run(keep);
}

/*
 * The `watches` and `schedules` tables are intentionally still created above
 * and left in place: they hold a real record of what Carvis did before
 * Protocols replaced them, and dropping them would destroy that history for no
 * benefit. Nothing reads or writes them anymore — every deferred action is a
 * protocol, timer, or alarm now.
 */

/* ── declarative automations ────────────────────────────────── */

function hydrateAutomationRule(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(row.enabled),
    archived: Boolean(row.archived),
    last_match: row.last_match == null ? null : Boolean(row.last_match),
    definition: parseStoredJson(row.definition, {}),
  };
}

export function saveAutomationRule(rule, { expectedRevision = null, resetRuntime = true } = {}) {
  const now = Date.now();
  const id = String(rule.id || `rule_${randomUUID().slice(0, 10)}`);
  const current = open().prepare('SELECT created_at, created_by, revision FROM automation_rules WHERE id = ?').get(id);
  if (current && expectedRevision != null && Number(expectedRevision) !== Number(current.revision)) {
    const err = new Error(`automation changed elsewhere (expected revision ${expectedRevision}, current ${current.revision})`);
    err.code = 'revision_conflict';
    err.currentRevision = current.revision;
    throw err;
  }
  const revision = current ? Number(current.revision || 1) + 1 : 1;
  const { createdBy: _createdBy, revision: _revision, ...program } = rule;
  const definition = { ...program, id, enabled: rule.enabled !== false };
  const definitionJson = JSON.stringify(definition);
  open()
    .prepare(
      `INSERT INTO automation_rules
         (id, name, enabled, archived, revision, definition, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         enabled = excluded.enabled,
         archived = 0,
         revision = excluded.revision,
         definition = excluded.definition,
         updated_at = excluded.updated_at,
         while_iterations = CASE WHEN ? THEN 0 ELSE automation_rules.while_iterations END,
         last_evaluated_at = CASE WHEN ? THEN NULL ELSE automation_rules.last_evaluated_at END,
         last_fired_at = CASE WHEN ? THEN NULL ELSE automation_rules.last_fired_at END,
         fire_count = CASE WHEN ? THEN 0 ELSE automation_rules.fire_count END,
         last_match = CASE WHEN ? THEN NULL ELSE automation_rules.last_match END,
         last_outcome = CASE WHEN ? THEN NULL ELSE automation_rules.last_outcome END,
         last_error = CASE WHEN ? THEN NULL ELSE automation_rules.last_error END`,
    )
    .run(
      id,
      String(rule.name || 'Untitled automation').slice(0, 120),
      rule.enabled === false ? 0 : 1,
      revision,
      definitionJson,
      current?.created_at ?? now,
      now,
      current?.created_by ?? String(rule.createdBy || rule.metadata?.createdBy || 'carvis').slice(0, 40),
      resetRuntime ? 1 : 0,
      resetRuntime ? 1 : 0,
      resetRuntime ? 1 : 0,
      resetRuntime ? 1 : 0,
      resetRuntime ? 1 : 0,
      resetRuntime ? 1 : 0,
      resetRuntime ? 1 : 0,
    );
  return getAutomationRule(id);
}

export function getAutomationRule(id) {
  return hydrateAutomationRule(open().prepare('SELECT * FROM automation_rules WHERE id = ?').get(String(id || '')));
}

export function listAutomationRules({ enabledOnly = false, includeArchived = false, limit = 200 } = {}) {
  const take = Math.max(1, Math.min(500, Number(limit) || 200));
  const clauses = [];
  if (enabledOnly) clauses.push('enabled = 1');
  if (!includeArchived) clauses.push('archived = 0');
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = open().prepare(`SELECT * FROM automation_rules${where} ORDER BY updated_at DESC LIMIT ?`).all(take);
  return rows.map(hydrateAutomationRule);
}

export function setAutomationRuleEnabled(id, enabled) {
  const result = open()
    .prepare('UPDATE automation_rules SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), String(id || ''));
  if (!result.changes) return null;
  const row = getAutomationRule(id);
  // Keep the public definition in lockstep with the indexed enabled column.
  if (row) saveAutomationRule(
    { ...row.definition, id: row.id, name: row.name, enabled: Boolean(enabled), createdBy: row.created_by },
    { resetRuntime: false },
  );
  return getAutomationRule(id);
}

export function deleteAutomationRule(id) {
  return open().prepare('DELETE FROM automation_rules WHERE id = ?').run(String(id || '')).changes > 0;
}

export function archiveAutomationRule(id) {
  return open()
    .prepare('UPDATE automation_rules SET archived = 1, enabled = 0, updated_at = ? WHERE id = ? AND archived = 0')
    .run(Date.now(), String(id || '')).changes > 0;
}

export function updateAutomationRuleEvaluation(id, { matched, fired = false, outcome = null, error = null, whileIterations } = {}) {
  const now = Date.now();
  const hasWhileIterations = Number.isSafeInteger(whileIterations) && whileIterations >= 0;
  open()
    .prepare(
      `UPDATE automation_rules
          SET last_evaluated_at = ?,
              last_match = ?,
              last_fired_at = CASE WHEN ? THEN ? ELSE last_fired_at END,
              fire_count = fire_count + CASE WHEN ? THEN 1 ELSE 0 END,
              last_outcome = COALESCE(?, last_outcome),
              last_error = ?,
              while_iterations = CASE WHEN ? THEN ? ELSE while_iterations END
        WHERE id = ?`,
    )
    .run(
      now,
      matched == null ? null : matched ? 1 : 0,
      fired ? 1 : 0,
      now,
      fired ? 1 : 0,
      outcome,
      error,
      hasWhileIterations ? 1 : 0,
      hasWhileIterations ? whileIterations : 0,
      String(id || ''),
    );
}

export function recordAutomationRun(run) {
  const row = {
    id: run.id || `run_${randomUUID().slice(0, 12)}`,
    rule_id: run.ruleId,
    ts: run.ts ?? Date.now(),
    trigger: JSON.stringify(run.trigger ?? {}),
    outcome: run.outcome || 'ok',
    actions: JSON.stringify(run.actions ?? []),
    error: run.error ?? null,
    ms: run.ms ?? 0,
  };
  open()
    .prepare(
      `INSERT INTO automation_runs (id, rule_id, ts, trigger, outcome, actions, error, ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.rule_id, row.ts, row.trigger, row.outcome, row.actions, row.error, row.ms);
  return { ...row, trigger: run.trigger ?? {}, actions: run.actions ?? [] };
}

export function listAutomationRuns({ ruleId = '', limit = 100 } = {}) {
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = ruleId
    ? open().prepare('SELECT * FROM automation_runs WHERE rule_id = ? ORDER BY ts DESC LIMIT ?').all(ruleId, take)
    : open().prepare('SELECT * FROM automation_runs ORDER BY ts DESC LIMIT ?').all(take);
  return rows.map((row) => ({
    ...row,
    trigger: parseStoredJson(row.trigger, {}),
    actions: parseStoredJson(row.actions, []),
  }));
}

/**
 * Bound append-only operational detail without erasing active state or the
 * owner's rule definitions. Ninety days remains available for diagnosis, and
 * hard row ceilings protect a fast WHILE rule from growing SQLite forever.
 */
export function pruneAutomationOperationalHistory({
  now = Date.now(),
  days = 90,
  maxRuns = 20_000,
  maxTerminalTimers = 5_000,
} = {}) {
  const handle = open();
  const cutoff = Number(now) - Math.max(1, Number(days) || 90) * 86_400_000;
  const runAge = handle.prepare('DELETE FROM automation_runs WHERE ts < ?').run(cutoff).changes;
  const runCap = handle.prepare(
    `DELETE FROM automation_runs
      WHERE id NOT IN (SELECT id FROM automation_runs ORDER BY ts DESC LIMIT ?)`,
  ).run(Math.max(100, Math.trunc(Number(maxRuns) || 20_000))).changes;
  const timerAge = handle.prepare(
    `DELETE FROM automation_timers
      WHERE status IN ('fired', 'cancelled')
        AND COALESCE(fired_at, due_at, created_at) < ?`,
  ).run(cutoff).changes;
  const timerCap = handle.prepare(
    `DELETE FROM automation_timers
      WHERE status IN ('fired', 'cancelled')
        AND id NOT IN (
          SELECT id FROM automation_timers
          WHERE status IN ('fired', 'cancelled')
          ORDER BY COALESCE(fired_at, due_at, created_at) DESC
          LIMIT ?
        )`,
  ).run(Math.max(100, Math.trunc(Number(maxTerminalTimers) || 5_000))).changes;
  return { runs: runAge + runCap, timers: timerAge + timerCap };
}

export function setAutomationVariable(name, value, updatedBy = 'carvis') {
  const key = String(name || '').trim();
  open()
    .prepare(
      `INSERT INTO automation_variables (name, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(key, JSON.stringify(value), Date.now(), String(updatedBy || 'carvis').slice(0, 40));
  return getAutomationVariable(key);
}

export function getAutomationVariable(name) {
  const row = open().prepare('SELECT * FROM automation_variables WHERE name = ?').get(String(name || ''));
  return row ? { ...row, value: parseStoredJson(row.value) } : null;
}

export function listAutomationVariables() {
  return open().prepare('SELECT * FROM automation_variables ORDER BY name').all().map((row) => ({
    ...row,
    value: parseStoredJson(row.value),
  }));
}

export function deleteAutomationVariable(name) {
  return open().prepare('DELETE FROM automation_variables WHERE name = ?').run(String(name || '')).changes > 0;
}

export function incrementAutomationVariable(name, amount = 1, updatedBy = 'carvis') {
  const key = String(name || '').trim();
  const delta = Number(amount);
  if (!key || !Number.isFinite(delta)) throw new Error('increment needs a variable name and finite amount');
  const now = Date.now();
  open()
    .prepare(
      `INSERT INTO automation_variables (name, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         value = CAST(COALESCE(automation_variables.value, '0') AS REAL) + ?,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by
       WHERE json_type(automation_variables.value) IN ('integer', 'real')`,
    )
    .run(key, JSON.stringify(delta), now, String(updatedBy || 'carvis').slice(0, 40), delta);
  const current = getAutomationVariable(key);
  if (typeof current?.value !== 'number' || !Number.isFinite(current.value)) {
    throw new Error(`${key} is not a numeric variable`);
  }
  return current;
}

function hydrateAutomationTimer(row) {
  return row ? { ...row, payload: parseStoredJson(row.payload, {}) } : null;
}

export function createAutomationTimer(timer) {
  const row = {
    id: timer.id || `${timer.kind === 'alarm' ? 'alarm' : 'timer'}_${randomUUID().slice(0, 10)}`,
    name: String(timer.name || (timer.kind === 'alarm' ? 'Alarm' : 'Timer')).slice(0, 120),
    kind: timer.kind === 'alarm' ? 'alarm' : 'timer',
    created_at: Date.now(),
    due_at: Number(timer.dueAt),
    repeat_ms: timer.repeatMs == null ? null : Number(timer.repeatMs),
    status: 'active',
    payload: JSON.stringify(timer.payload ?? {}),
    rule_id: timer.ruleId || null,
  };
  open()
    .prepare(
      `INSERT INTO automation_timers
         (id, name, kind, created_at, due_at, repeat_ms, status, payload, rule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.name, row.kind, row.created_at, row.due_at, row.repeat_ms, row.status, row.payload, row.rule_id);
  return hydrateAutomationTimer(row);
}

export function dueAutomationTimers(now = Date.now()) {
  return open()
    .prepare("SELECT * FROM automation_timers WHERE status = 'active' AND due_at <= ? ORDER BY due_at")
    .all(now)
    .map(hydrateAutomationTimer);
}

export function listAutomationTimers({ activeOnly = false, kind = '', limit = 200 } = {}) {
  const take = Math.max(1, Math.min(500, Number(limit) || 200));
  const clauses = [];
  const params = [];
  if (activeOnly) clauses.push("status IN ('active', 'paused')");
  if (kind) { clauses.push('kind = ?'); params.push(kind); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  return open().prepare(`SELECT * FROM automation_timers${where} ORDER BY due_at ASC LIMIT ?`).all(...params, take).map(hydrateAutomationTimer);
}

export function getAutomationTimer(idOrName) {
  const key = String(idOrName || '');
  return hydrateAutomationTimer(
    open().prepare(
      `SELECT * FROM automation_timers
        WHERE id = ? OR name = ?
        ORDER BY CASE status
          WHEN 'active' THEN 0
          WHEN 'paused' THEN 1
          WHEN 'fired' THEN 2
          ELSE 3
        END, created_at DESC
        LIMIT 1`,
    ).get(key, key),
  );
}

export function markAutomationTimerFired(id, repeatMs = null) {
  const now = Date.now();
  if (repeatMs && Number(repeatMs) > 0) {
    // Advance from the prior deadline, skipping missed periods after downtime,
    // rather than drifting every recurring alarm by the poll interval.
    const current = getAutomationTimer(id);
    let next = current?.due_at || now;
    while (next <= now) next += Number(repeatMs);
    open().prepare("UPDATE automation_timers SET fired_at = ?, due_at = ?, status = 'active' WHERE id = ?").run(now, next, id);
  } else {
    open().prepare("UPDATE automation_timers SET fired_at = ?, status = 'fired' WHERE id = ?").run(now, id);
  }
  return getAutomationTimer(id);
}

/**
 * Atomically move a calendar-backed recurring alarm to its next occurrence.
 *
 * Marking it fired and then snoozing it in two writes creates a crash window
 * where a daily alarm is stranded as `fired` forever.  This one statement is
 * the durable state transition for a successfully delivered occurrence.
 */
export function rescheduleAutomationTimer(id, dueAt, now = Date.now()) {
  const due = Number(dueAt);
  if (!Number.isFinite(due) || due <= Number(now)) return null;
  const result = open()
    .prepare("UPDATE automation_timers SET status = 'active', due_at = ?, fired_at = ?, paused_remaining_ms = NULL WHERE id = ? AND status = 'active'")
    .run(due, Number(now), String(id || ''));
  return result.changes ? getAutomationTimer(id) : null;
}

export function cancelAutomationTimer(idOrName) {
  const key = String(idOrName || '');
  const result = open()
    .prepare("UPDATE automation_timers SET status = 'cancelled' WHERE status IN ('active', 'paused') AND (id = ? OR name = ?)")
    .run(key, key);
  return result.changes;
}

export function pauseAutomationTimer(idOrName, now = Date.now()) {
  const timer = getAutomationTimer(idOrName);
  if (!timer || timer.status !== 'active') return null;
  const remaining = Math.max(0, timer.due_at - now);
  open()
    .prepare("UPDATE automation_timers SET status = 'paused', paused_remaining_ms = ? WHERE id = ?")
    .run(remaining, timer.id);
  return getAutomationTimer(timer.id);
}

export function resumeAutomationTimer(idOrName, now = Date.now()) {
  const key = String(idOrName || '');
  const timer = hydrateAutomationTimer(
    open().prepare("SELECT * FROM automation_timers WHERE status = 'paused' AND (id = ? OR name = ?) ORDER BY created_at DESC LIMIT 1").get(key, key),
  );
  if (!timer) return null;
  open()
    .prepare("UPDATE automation_timers SET status = 'active', due_at = ?, paused_remaining_ms = NULL WHERE id = ?")
    .run(now + Math.max(0, timer.paused_remaining_ms || 0), timer.id);
  return getAutomationTimer(timer.id);
}

export function snoozeAutomationTimer(idOrName, durationMs, now = Date.now()) {
  const timer = getAutomationTimer(idOrName);
  const delay = Math.max(1000, Number(durationMs) || 0);
  if (!timer || timer.kind !== 'alarm' || !['active', 'fired'].includes(timer.status)) return null;
  open()
    .prepare("UPDATE automation_timers SET status = 'active', due_at = ?, fired_at = NULL, paused_remaining_ms = NULL WHERE id = ? AND status IN ('active', 'fired')")
    .run(now + delay, timer.id);
  return getAutomationTimer(timer.id);
}

export function recordAutomationValueChange(ref, from, to, ts = Date.now()) {
  const key = String(ref || '').slice(0, 512);
  if (!key) return null;
  const result = open()
    .prepare('INSERT INTO automation_value_history (ref, ts, from_value, to_value) VALUES (?, ?, ?, ?)')
    // SQL NULL is the internal encoding for JavaScript undefined. A literal
    // JSON null remains the string "null", so state creation/deletion edges
    // survive without passing an unbindable undefined value to node:sqlite.
    .run(
      key,
      Number(ts) || Date.now(),
      from === undefined ? null : JSON.stringify(from),
      to === undefined ? null : JSON.stringify(to),
    );
  // Retain a bounded operational history. Thirty days covers practical
  // temporal rules while keeping high-churn tracked sensors finite.
  if (Number(result.lastInsertRowid) % 500 === 0) {
    open().prepare('DELETE FROM automation_value_history WHERE ts < ?').run(Date.now() - 30 * 86_400_000);
  }
  return Number(result.lastInsertRowid);
}

export function recentAutomationValueChanges(ref, limit = 500) {
  const take = Math.max(1, Math.min(5_000, Number(limit) || 500));
  return open()
    .prepare('SELECT ref, ts, from_value, to_value FROM automation_value_history WHERE ref = ? ORDER BY ts DESC LIMIT ?')
    .all(String(ref || ''), take)
    .map((row) => ({
      ref: row.ref,
      ts: row.ts,
      from: row.from_value == null ? undefined : parseStoredJson(row.from_value),
      to: row.to_value == null ? undefined : parseStoredJson(row.to_value),
    }));
}

/* ── observability ───────────────────────────────────────────── */

export function recordInvocation(inv) {
  open()
    .prepare(
      `INSERT INTO invocations
         (id, ts, trigger_type, trigger, role, provider, model, prompt_version,
          rounds, input_tokens, cached_tokens, output_tokens, cost_usd, ms, outcome, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ts = excluded.ts,
         trigger_type = excluded.trigger_type,
         trigger = excluded.trigger,
         role = excluded.role,
         provider = excluded.provider,
         model = excluded.model,
         prompt_version = excluded.prompt_version,
         rounds = excluded.rounds,
         input_tokens = excluded.input_tokens,
         cached_tokens = excluded.cached_tokens,
         output_tokens = excluded.output_tokens,
         cost_usd = excluded.cost_usd,
         ms = excluded.ms,
         outcome = excluded.outcome,
         error = excluded.error`,
    )
    .run(
      inv.id,
      inv.ts,
      inv.triggerType,
      JSON.stringify(inv.trigger ?? {}),
      inv.role,
      inv.provider,
      inv.model,
      inv.promptVersion,
      inv.rounds ?? 0,
      inv.inputTokens ?? 0,
      inv.cachedTokens ?? 0,
      inv.outputTokens ?? 0,
      inv.costUsd ?? 0,
      inv.ms ?? 0,
      inv.outcome,
      inv.error ?? null,
    );
}

/** One observable model-loop event. Never store model text or prompt content here. */
export function recordInvocationStep(step) {
  open()
    .prepare(
      `INSERT INTO invocation_steps
         (id, invocation_id, step, round_number, ts, kind, role, provider, model,
          duration_ms, tool_count, outcome, detail, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      step.id,
      step.invocationId,
      step.step,
      step.round ?? 0,
      step.ts,
      step.kind,
      step.role ?? null,
      step.provider ?? null,
      step.model ?? null,
      step.durationMs ?? 0,
      step.toolCount ?? 0,
      step.outcome,
      step.detail ?? null,
      step.error ?? null,
    );
}

export function recordToolCall(call) {
  open()
    .prepare(
      `INSERT INTO tool_calls
         (id, invocation_id, ts, tool, arguments, risk, authorization, result, ok, ms, error, round_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      call.id,
      call.invocationId ?? null,
      call.ts,
      call.tool,
      JSON.stringify(call.arguments ?? {}),
      call.risk,
      call.authorization,
      call.result ? JSON.stringify(call.result).slice(0, 4000) : null,
      call.ok ? 1 : 0,
      call.ms ?? 0,
      call.error ?? null,
      call.round ?? null,
    );
}

function parseStoredJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    // Early builds capped JSON strings by character count. A truncated value
    // is still useful as a diagnostic, but it is no longer valid JSON.
    return { _truncated: true };
  }
}

export function recentInvocations(limit = 30) {
  return open()
    .prepare('SELECT * FROM invocations ORDER BY ts DESC LIMIT ?')
    .all(limit)
    .map((row) => ({ ...row, trigger: parseStoredJson(row.trigger, {}) }));
}

export function recentToolCalls(limit = 50) {
  return open()
    .prepare('SELECT * FROM tool_calls ORDER BY ts DESC LIMIT ?')
    .all(limit)
    .map((row) => ({
      ...row,
      round: row.round_number ?? null,
      arguments: parseStoredJson(row.arguments, {}),
      result: parseStoredJson(row.result),
      ok: Boolean(row.ok),
    }));
}

/**
 * Read-only, privacy-filtered execution traces for the owner Web UI.
 * Keeping the query here means every path to the trace gets the same durable
 * audit history and the same server-side redaction.
 */
export function recentTrace(limit = 25) {
  const take = Math.max(1, Math.min(50, Number(limit) || 25));
  const handle = open();
  const invocations = handle
    .prepare('SELECT * FROM invocations ORDER BY ts DESC LIMIT ?')
    .all(take)
    .map((row) => ({ ...row, trigger: parseStoredJson(row.trigger, {}) }));
  const ids = invocations.map((row) => row.id);

  let steps = [];
  let attachedCalls = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    steps = handle
      .prepare(`SELECT * FROM invocation_steps WHERE invocation_id IN (${placeholders}) ORDER BY ts ASC, step ASC`)
      .all(...ids)
      // SQLite uses the descriptive column name; the trace boundary uses the
      // stable public `round` field alongside tool-call rows. Without this
      // mapping every persisted model step looked like round zero in the UI.
      .map((row) => ({ ...row, round: row.round_number ?? 0 }));
    attachedCalls = handle
      .prepare(`SELECT * FROM tool_calls WHERE invocation_id IN (${placeholders}) ORDER BY ts ASC`)
      .all(...ids)
      .map((row) => ({
        ...row,
        round: row.round_number ?? null,
        arguments: parseStoredJson(row.arguments, {}),
        result: parseStoredJson(row.result),
        ok: Boolean(row.ok),
      }));
  }

  const unattachedCalls = handle
    .prepare('SELECT * FROM tool_calls WHERE invocation_id IS NULL ORDER BY ts DESC LIMIT 20')
    .all()
    .map((row) => ({
      ...row,
      round: row.round_number ?? null,
      arguments: parseStoredJson(row.arguments, {}),
      result: parseStoredJson(row.result),
      ok: Boolean(row.ok),
    }));

  return buildTraceView({ invocations, steps, toolCalls: [...attachedCalls, ...unattachedCalls] });
}

/**
 * Spend, grouped so the dashboard can show where it went rather than one
 * number you cannot act on.
 */
export function costSummary() {
  const handle = open();
  const since = (ms) => Date.now() - ms;
  const day = handle
    .prepare(
      `SELECT role, provider, model,
              COUNT(*) AS calls,
              SUM(cost_usd) AS cost,
              SUM(input_tokens) AS input_tokens,
              SUM(cached_tokens) AS cached_tokens,
              SUM(output_tokens) AS output_tokens
         FROM invocations WHERE ts >= ? GROUP BY role, provider, model`,
    )
    .all(since(24 * 3600 * 1000));

  const month = handle.prepare('SELECT SUM(cost_usd) AS cost FROM invocations WHERE ts >= ?').get(since(30 * 24 * 3600 * 1000));
  const total = handle.prepare('SELECT SUM(cost_usd) AS cost, COUNT(*) AS calls FROM invocations').get();

  const dayCost = day.reduce((sum, r) => sum + (r.cost || 0), 0);
  return {
    today: dayCost,
    byRole: day,
    month: month?.cost || 0,
    // Straight-line from the last 30 days. Honest about being a projection.
    projectedMonth: (month?.cost || 0) > 0 ? ((month.cost || 0) / 30) * 30 : dayCost * 30,
    allTime: total?.cost || 0,
    invocations: total?.calls || 0,
  };
}

/* ── hud ─────────────────────────────────────────────────────── */

export function saveHudSlot(widget) {
  open()
    .prepare(
      `INSERT INTO hud_slots (slot, type, data, binding, created_at, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         type = excluded.type, data = excluded.data, binding = excluded.binding,
         created_at = excluded.created_at, created_by = excluded.created_by,
         expires_at = excluded.expires_at`,
    )
    .run(
      widget.slot,
      widget.type,
      JSON.stringify(widget.data ?? {}),
      widget.binding ? JSON.stringify(widget.binding) : null,
      widget.created_at,
      widget.created_by,
      widget.expires_at ?? null,
    );
}

export function deleteHudSlot(slot) {
  open().prepare('DELETE FROM hud_slots WHERE slot = ?').run(slot);
}

export function clearHudSlots() {
  open().prepare('DELETE FROM hud_slots').run();
}

export function loadHudSlots() {
  return open()
    .prepare('SELECT * FROM hud_slots')
    .all()
    .map((row) => ({
      slot: row.slot,
      type: row.type,
      data: JSON.parse(row.data),
      binding: row.binding ? JSON.parse(row.binding) : null,
      created_at: row.created_at,
      updated_at: row.created_at,
      created_by: row.created_by,
      expires_at: row.expires_at,
    }));
}

/* ── memories ────────────────────────────────────────────────── */

export function insertMemory(memory) {
  open()
    .prepare(
      `INSERT INTO memories
         (id, ts, updated_at, kind, text, source, fingerprint, pinned, used_at, use_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    )
    .run(
      memory.id,
      memory.ts,
      memory.updated_at,
      memory.kind,
      memory.text,
      memory.source,
      memory.fingerprint,
      memory.pinned ? 1 : 0,
    );
}

export function updateMemory(id, fields) {
  open()
    .prepare(
      `UPDATE memories
          SET text = ?, kind = ?, fingerprint = ?, pinned = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(fields.text, fields.kind, fields.fingerprint, fields.pinned ? 1 : 0, fields.updated_at, id);
}

/** Fire-and-forget: usage accounting must never fail a turn. */
export function touchMemories(ids, at) {
  if (!ids.length) return;
  const statement = open().prepare('UPDATE memories SET used_at = ?, use_count = use_count + 1 WHERE id = ?');
  for (const id of ids) statement.run(at, id);
}

export function deleteMemory(id) {
  return open().prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

export function loadMemories() {
  return open()
    .prepare('SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC')
    .all()
    .map((row) => ({
      id: row.id,
      ts: row.ts,
      updated_at: row.updated_at,
      kind: row.kind,
      text: row.text,
      source: row.source,
      fingerprint: row.fingerprint,
      pinned: Boolean(row.pinned),
      used_at: row.used_at,
      use_count: row.use_count,
    }));
}

/* ── transcripts ─────────────────────────────────────────────── */

/**
 * Upsert one heard utterance. Called on arrival and again as its routing
 * decision resolves, so the row always reflects the final outcome rather than
 * whatever was known when the utterance first landed.
 */
export function saveTranscript(entry) {
  open()
    .prepare(
      `INSERT INTO transcripts
         (id, ts, source, kind, text, confidence, outcome, detail, reply, actions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         outcome = excluded.outcome,
         detail  = excluded.detail,
         reply   = excluded.reply,
         actions = excluded.actions`,
    )
    .run(
      entry.id,
      entry.ts,
      entry.source,
      entry.kind,
      String(entry.text ?? '').slice(0, 2000),
      typeof entry.confidence === 'number' ? entry.confidence : null,
      entry.outcome,
      entry.detail ? String(entry.detail).slice(0, 500) : null,
      entry.reply ? String(entry.reply).slice(0, 1000) : null,
      JSON.stringify(entry.actions ?? []),
    );
}

/** Newest first. `outcome` narrows to one routing decision when given. */
export function loadTranscripts({ limit = 200, outcome = '' } = {}) {
  const sql = outcome
    ? 'SELECT * FROM transcripts WHERE outcome = ? ORDER BY ts DESC LIMIT ?'
    : 'SELECT * FROM transcripts ORDER BY ts DESC LIMIT ?';
  const rows = outcome
    ? open().prepare(sql).all(outcome, limit)
    : open().prepare(sql).all(limit);
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    source: row.source,
    kind: row.kind,
    text: row.text,
    confidence: row.confidence,
    outcome: row.outcome,
    detail: row.detail || '',
    reply: row.reply || '',
    actions: parseStoredJson(row.actions, []),
  }));
}

/** Drop everything older than `days`, so the corpus stays a tuning set. */
export function pruneTranscripts(days = 90) {
  const cutoff = Date.now() - days * 86_400_000;
  return open().prepare('DELETE FROM transcripts WHERE ts < ?').run(cutoff).changes;
}

/** The owner's Clear button — every persisted row, not just the in-memory ring. */
export function deleteAllTranscripts() {
  return open().prepare('DELETE FROM transcripts').run().changes;
}

/* ── idempotency ─────────────────────────────────────────────── */

// Comfortably longer than any real tool call should take. A claim older than
// this with no result yet did not fail cleanly — the process most likely
// crashed or restarted mid-call — so it is reclaimable rather than stuck.
const IDEMPOTENCY_STALE_MS = 120_000;

/**
 * `{done: true, result}` for a genuinely completed call — safe to dedupe.
 * `{done: false, inFlight: true}` for a claim still within the staleness
 * window — a concurrent retry should fail fast, not execute twice or claim
 * a success that hasn't happened. `null` when the key is fresh or the prior
 * claim is stale enough to reclaim (crashed before it could release itself).
 */
export function claimIdempotency(key) {
  const handle = open();
  const existing = handle.prepare('SELECT ts, result FROM idempotency WHERE key = ?').get(key);
  if (existing) {
    if (existing.result) return { done: true, result: JSON.parse(existing.result) };
    if (Date.now() - existing.ts < IDEMPOTENCY_STALE_MS) return { done: false, inFlight: true };
    handle.prepare('UPDATE idempotency SET ts = ? WHERE key = ?').run(Date.now(), key);
    return null;
  }
  handle.prepare('INSERT INTO idempotency (key, ts, result) VALUES (?, ?, NULL)').run(key, Date.now());
  return null;
}

export function completeIdempotency(key, result) {
  open().prepare('UPDATE idempotency SET result = ? WHERE key = ?').run(JSON.stringify(result), key);
}

/**
 * A failed attempt (thrown, or resolved `{success:false}`) releases its claim
 * so the next retry gets a clean shot instead of finding a `NULL`-result row
 * indistinguishable from "already done" once it reaches `gateway.call()`.
 */
export function releaseIdempotency(key) {
  open().prepare('DELETE FROM idempotency WHERE key = ?').run(key);
}

export function close() {
  db?.close();
  db = null;
}

export { DB_PATH };
