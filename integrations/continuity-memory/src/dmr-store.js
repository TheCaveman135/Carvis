/**
 * Deep Memory Retention (DMR)
 *
 * A local event-sourced memory store designed to sit behind Carvis's existing
 * MemoryStore contract.  It retains the *timeline* of a changing fact instead
 * of overwriting the older version, records supporting evidence, learns only
 * tentative patterns, and emits a compact, inspectable context packet.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  cleanText,
  currentIntent,
  dayClass,
  dayKey,
  extractEntities,
  fingerprint,
  hash,
  historicalIntent,
  inferClaim,
  normalize,
  stableJson,
  timeBucket,
  tokenize,
} from './lexical.js';
import {
  buildNote,
  buildReflection,
  evolveNote,
  normalizeNamespace,
  noteAffinity,
} from './evolution.js';

import { diversifyCandidates, scoreCandidates } from './retrieval.js';
import { migrateDatabase } from './schema.js';
import { json, legacyShape, nodeFromRow } from './records.js';

const KINDS = new Set(['fact', 'preference', 'rule', 'observation']);
const STATES = new Set(['active', 'superseded', 'contested', 'archived']);
const DAY = 86_400_000;

const SOURCE_AUTHORITY = {
  owner: 1,
  import: 0.95,
  system: 0.85,
  carvis: 0.65,
  inference: 0.45,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function nowId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

function nonEmpty(value, fallback = '') {
  const clean = cleanText(value);
  return clean || fallback;
}

function sourceAuthority(source, supplied) {
  if (Number.isFinite(Number(supplied))) return clamp(Number(supplied), 0, 1);
  return SOURCE_AUTHORITY[source] ?? 0.55;
}

function confidenceLabel(value) {
  if (value >= 0.9) return 'high';
  if (value >= 0.7) return 'medium';
  return 'tentative';
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function dynamicIn(values) {
  return values.length ? `(${values.map(() => '?').join(',')})` : '(NULL)';
}

export class DMRStore {
  constructor({ dbPath = path.resolve('dmr.db'), now = () => Date.now(), logger = () => {} } = {}) {
    this.dbPath = dbPath;
    this.now = now;
    this.logger = logger;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrateDatabase(this.db);
    // The memory can include personal context.  The database does not need to
    // be world-readable merely because Node created it that way by default.
    this.#protectFiles();
  }

  close() {
    this.db.close();
  }

  #transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      this.#protectFiles();
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  #protectFiles() {
    if (this.dbPath === ':memory:') return;
    for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      if (existsSync(file)) {
        try { chmodSync(file, 0o600); } catch { /* best-effort platform permission */ }
      }
    }
  }

  #event(type, data, occurredAt = this.now()) {
    this.db.prepare('INSERT INTO dmr_events (id, type, occurred_at, data) VALUES (?, ?, ?, ?)')
      .run(nowId('evt'), type, occurredAt, JSON.stringify(data ?? {}));
  }

  #node(id) {
    return nodeFromRow(this.db.prepare('SELECT * FROM dmr_memories WHERE id = ?').get(id));
  }

  #addEvidence({ memoryId, episodeId = null, source, stance = 'supports', quote, observedAt, confidence, metadata = {} }) {
    this.db.prepare(
      `INSERT INTO dmr_evidence
         (id, memory_id, episode_id, source, stance, quote, observed_at, confidence, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nowId('evidence'), memoryId, episodeId, source, stance, cleanText(quote, 8_000), observedAt,
      clamp(confidence, 0, 1), JSON.stringify(metadata ?? {}),
    );
  }

  #upsertEntity(canonical, now) {
    const clean = normalize(canonical).replace(/\s+/g, '_').slice(0, 128);
    if (!clean) return null;
    const existing = this.db.prepare('SELECT id FROM dmr_entities WHERE canonical = ?').get(clean);
    if (existing) {
      this.db.prepare('UPDATE dmr_entities SET updated_at = ? WHERE id = ?').run(now, existing.id);
      return existing.id;
    }
    const id = `entity_${hash(clean, 18)}`;
    this.db.prepare(
      'INSERT INTO dmr_entities (id, canonical, type, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, clean, clean.includes('.') ? 'home_entity' : 'named_entity', now, now, '{}');
    return id;
  }

  #upsertLink(left, right, relation, weight, now) {
    if (!left || !right || left === right) return;
    const [memoryA, memoryB] = [left, right].sort();
    this.db.prepare(
      `INSERT INTO dmr_links (memory_a, memory_b, relation, weight, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_a, memory_b, relation) DO UPDATE SET
         weight = MIN(1.0, dmr_links.weight + excluded.weight * 0.15),
         updated_at = excluded.updated_at`,
    ).run(memoryA, memoryB, relation, clamp(weight, 0, 1), now, now);
  }

  #recordNoteRevision(memoryId, reason, now) {
    const node = this.#node(memoryId);
    if (!node) return;
    this.db.prepare(
      `INSERT INTO dmr_note_revisions
        (id, memory_id, revision, reason, context_text, keywords, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nowId('note_revision'), node.id, node.revision, cleanText(reason, 160), node.contextText,
      JSON.stringify(node.keywords), JSON.stringify(node.tags), now,
    );
  }

  #evolveMemoryNote(memoryId, { sharedKeywords = [], relatedText = '' } = {}, now) {
    const node = this.#node(memoryId);
    if (!node) return false;
    const evolved = evolveNote(node, { sharedKeywords, relatedText });
    const changed = evolved.contextText !== node.contextText
      || stableJson(evolved.keywords) !== stableJson(node.keywords)
      || stableJson(evolved.tags) !== stableJson(node.tags);
    if (!changed) return false;
    this.db.prepare(
      `UPDATE dmr_memories
          SET context_text = ?, keywords = ?, tags = ?, revision = revision + 1
        WHERE id = ?`,
    ).run(evolved.contextText, JSON.stringify(evolved.keywords), JSON.stringify(evolved.tags), memoryId);
    this.#recordNoteRevision(memoryId, 'semantic link evolution', now);
    return true;
  }

  #attachSemanticLinks(memoryId, note, now) {
    const peers = this.db.prepare(
      `SELECT * FROM dmr_memories
        WHERE namespace = ? AND id != ? AND state IN ('active', 'contested')
        ORDER BY updated_at DESC LIMIT 120`,
    ).all(note.namespace, memoryId).map(nodeFromRow);
    const related = peers.map((peer) => ({ peer, ...noteAffinity(note, peer) }))
      .filter((item) => item.score >= 0.22 || item.shared.length >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    for (const item of related) {
      this.#upsertLink(memoryId, item.peer.id, 'semantic-neighbor', Math.max(0.28, item.score), now);
      this.#evolveMemoryNote(memoryId, { sharedKeywords: item.shared, relatedText: item.peer.text }, now);
      this.#evolveMemoryNote(item.peer.id, { sharedKeywords: item.shared, relatedText: note.text }, now);
    }
    return related.length;
  }

  #attachContext(memoryId, episodeId, entityNames, now, namespace = 'owner') {
    if (episodeId) {
      const peers = this.db.prepare(
        'SELECT memory_id FROM dmr_episode_members WHERE episode_id = ? AND memory_id != ? ORDER BY added_at DESC LIMIT 12',
      ).all(episodeId, memoryId);
      for (const peer of peers) this.#upsertLink(memoryId, peer.memory_id, 'co-episode', 0.72, now);
      this.db.prepare(
        'INSERT OR IGNORE INTO dmr_episode_members (episode_id, memory_id, added_at) VALUES (?, ?, ?)',
      ).run(episodeId, memoryId, now);
    }

    for (const entityName of entityNames) {
      const entityId = this.#upsertEntity(entityName, now);
      if (!entityId) continue;
      const peers = this.db.prepare(
        `SELECT me.memory_id
           FROM dmr_memory_entities me
           JOIN dmr_memories m ON m.id = me.memory_id
          WHERE me.entity_id = ? AND me.memory_id != ? AND m.state != 'archived' AND m.namespace = ?
          ORDER BY m.updated_at DESC LIMIT 10`,
      ).all(entityId, memoryId, namespace);
      this.db.prepare('INSERT OR IGNORE INTO dmr_memory_entities (memory_id, entity_id) VALUES (?, ?)')
        .run(memoryId, entityId);
      for (const peer of peers) this.#upsertLink(memoryId, peer.memory_id, 'shared-entity', 0.46, now);
    }
  }

  /** Create a bounded episode to bind several observations into one memory scene. */
  beginEpisode({ id = nowId('episode'), source = 'owner', title = 'Untitled episode', startedAt = this.now(), summary = '', metadata = {} } = {}) {
    const record = {
      id: cleanText(id, 80),
      source: cleanText(source, 40) || 'owner',
      title: cleanText(title, 200) || 'Untitled episode',
      startedAt: Number(startedAt) || this.now(),
      summary: cleanText(summary, 2_000),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    };
    return this.#transaction(() => {
      this.db.prepare(
        `INSERT INTO dmr_episodes (id, source, title, started_at, ended_at, summary, metadata)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(record.id, record.source, record.title, record.startedAt, record.summary, JSON.stringify(record.metadata));
      this.#event('episode.started', record, record.startedAt);
      return { ...record, endedAt: null };
    });
  }

  endEpisode(id, { endedAt = this.now(), summary } = {}) {
    return this.#transaction(() => {
      const previous = this.db.prepare('SELECT * FROM dmr_episodes WHERE id = ?').get(id);
      if (!previous) return { ok: false, error: `No episode ${id}` };
      const end = Math.max(Number(endedAt) || this.now(), Number(previous.started_at));
      this.db.prepare(
        'UPDATE dmr_episodes SET ended_at = ?, summary = COALESCE(?, summary) WHERE id = ?',
      ).run(end, summary == null ? null : cleanText(summary, 2_000), id);
      this.#event('episode.ended', { id, endedAt: end }, end);
      return { ok: true, id, endedAt: end };
    });
  }

  /**
   * Capture a claim without erasing its predecessor. A new owner-level fact
   * about the same temporal slot supersedes the old fact; a lower-authority
   * conflicting inference leaves both visible as contested instead.
   */
  capture(input = {}) {
    const text = cleanText(input.text, 4_000);
    if (!text) throw new Error('A memory needs text');
    const kind = input.kind || 'fact';
    if (!KINDS.has(kind)) throw new Error(`kind must be one of: ${[...KINDS].join(', ')}`);
    const source = cleanText(input.source || 'carvis', 40) || 'carvis';
    const occurredAt = Number(input.occurredAt ?? input.ts) || this.now();
    const claim = input.claim && typeof input.claim === 'object' ? input.claim : inferClaim(text, kind);
    const subject = cleanText(claim.subject, 120) || 'memory';
    const predicate = cleanText(claim.predicate, 180) || `statement:${fingerprint(text)}`;
    const object = cleanText(claim.object, 500) || normalize(text);
    const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
    const namespace = normalizeNamespace(input.namespace || metadata.namespace || 'owner');
    const rawSlotKey = cleanText(claim.slotKey, 500) || `${kind}|${subject}|${predicate}`;
    const rawIdentityKey = cleanText(claim.identityKey, 700) || `${rawSlotKey}|${object}`;
    const slotKey = `${namespace}|${rawSlotKey}`;
    const identityKey = `${namespace}|${rawIdentityKey}`;
    const authority = sourceAuthority(source, input.authority);
    const confidence = clamp(input.confidence ?? authority, 0, 1);
    const pinned = Boolean(input.pinned);
    const durable = input.durable == null ? kind !== 'observation' : Boolean(input.durable);
    const entities = [...new Set([
      ...ensureArray(input.entities).map((entity) => cleanText(entity, 128)).filter(Boolean),
      ...extractEntities(text),
      ...(subject !== 'memory' && !subject.includes('statement:') ? [subject] : []),
    ])].slice(0, 24);
    const note = {
      text,
      subject,
      predicate,
      ...buildNote({
        text, kind, source, subject, predicate, object, namespace, entities,
        keywords: input.keywords || metadata.keywords,
        tags: input.tags || metadata.tags,
        contextText: input.contextText || metadata.contextText,
      }),
    };

    return this.#transaction(() => {
      const exact = this.db.prepare(
        `SELECT * FROM dmr_memories
          WHERE identity_key = ? AND namespace = ? AND state IN ('active', 'contested')
          ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'contested' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1`,
      ).get(identityKey, namespace);
      if (exact) {
        const existing = nodeFromRow(exact);
        this.#addEvidence({
          memoryId: existing.id, episodeId: input.episodeId || null, source, quote: input.evidence || text,
          observedAt: occurredAt, confidence, metadata,
        });
        this.db.prepare(
          `UPDATE dmr_memories
              SET updated_at = ?, confidence = MAX(confidence, ?), salience = MIN(1.0, salience + 0.045)
            WHERE id = ?`,
        ).run(occurredAt, confidence, existing.id);
        this.#evolveMemoryNote(existing.id, { sharedKeywords: note.keywords }, occurredAt);
        this.#attachContext(existing.id, input.episodeId || null, entities, occurredAt, namespace);
        this.#attachSemanticLinks(existing.id, this.#node(existing.id), occurredAt);
        this.#event('memory.reinforced', { memoryId: existing.id, source, episodeId: input.episodeId || null }, occurredAt);
        return { memory: legacyShape(this.#node(existing.id)), node: this.#node(existing.id), status: 'reinforced', transitions: [] };
      }

      const id = cleanText(input.id, 100) || nowId('memory');
      let state = STATES.has(input.state) ? input.state : 'active';
      const transitions = [];
      const supersedePriorIds = [];
      const contestPriorIds = [];
      const sameSlot = claim.slotSpecific || input.slotSpecific
        ? this.db.prepare(
          `SELECT * FROM dmr_memories
            WHERE slot_key = ? AND namespace = ? AND id != ? AND state IN ('active', 'contested')
            ORDER BY valid_from DESC`,
        ).all(slotKey, namespace, id).map(nodeFromRow)
        : [];

      const forced = new Set(ensureArray(input.supersedeIds).map(String));
      for (const prior of sameSlot) {
        const ownerMayReplace = source === 'owner';
        const strongerEvidence = authority > prior.authority + 0.05;
        const explicitReplacement = forced.has(prior.id) || input.resolve === true;
        if (ownerMayReplace || strongerEvidence || explicitReplacement) {
          supersedePriorIds.push(prior.id);
          transitions.push({ from: prior.id, to: id, type: 'superseded' });
        } else {
          // A model observation may be useful, but it is not allowed to erase
          // an owner statement. Show the uncertainty rather than bluffing.
          state = 'contested';
          if (prior.state === 'active') contestPriorIds.push(prior.id);
          transitions.push({ from: prior.id, to: id, type: 'contested' });
        }
      }

      const forcedPrior = [...forced].filter((priorId) => !sameSlot.some((node) => node.id === priorId));
      for (const priorId of forcedPrior) {
        supersedePriorIds.push(priorId);
        transitions.push({ from: priorId, to: id, type: 'edited' });
      }

      this.db.prepare(
        `INSERT INTO dmr_memories
          (id, kind, text, normalized, source, authority, confidence, state, pinned, durable,
           created_at, updated_at, valid_from, valid_to, used_at, use_count, salience, subject,
           predicate, object, slot_key, identity_key, namespace, keywords, tags, context_text, revision,
           superseded_by, legacy_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, kind, text, normalize(text), source, authority, confidence, state, pinned ? 1 : 0,
        durable ? 1 : 0, occurredAt, occurredAt, Number(input.validFrom) || occurredAt,
        null, null, 0, clamp(input.salience ?? (pinned ? 0.95 : confidence * 0.72), 0.05, 1),
        subject, predicate, object, slotKey, identityKey, namespace, JSON.stringify(note.keywords),
        JSON.stringify(note.tags), note.contextText, 1, null, input.legacyId || null, JSON.stringify(metadata),
      );
      // `superseded_by` is a foreign key; the successor must exist before a
      // predecessor may point at it. Keeping this transition after the insert
      // also makes the change atomic in the enclosing transaction.
      for (const priorId of new Set(supersedePriorIds)) {
        this.db.prepare(
          `UPDATE dmr_memories
              SET state = 'superseded', valid_to = ?, updated_at = ?, superseded_by = ?
            WHERE id = ? AND state != 'archived'`,
        ).run(occurredAt, occurredAt, id, priorId);
      }
      for (const priorId of new Set(contestPriorIds)) {
        this.db.prepare("UPDATE dmr_memories SET state = 'contested', updated_at = ? WHERE id = ? AND state = 'active'")
          .run(occurredAt, priorId);
      }
      this.#addEvidence({
        memoryId: id, episodeId: input.episodeId || null, source, stance: input.stance || 'supports',
        quote: input.evidence || text, observedAt: occurredAt, confidence, metadata,
      });
      this.#recordNoteRevision(id, 'initial atomic note', occurredAt);
      this.#attachContext(id, input.episodeId || null, entities, occurredAt, namespace);
      const semanticLinks = this.#attachSemanticLinks(id, note, occurredAt);
      this.#event('memory.captured', { memoryId: id, kind, source, state, namespace, semanticLinks, transitions }, occurredAt);
      const node = this.#node(id);
      return { memory: legacyShape(node), node, status: transitions.length ? state === 'contested' ? 'contested' : 'superseded_previous' : 'created', transitions };
    });
  }

  /** The current Carvis contract calls this `remember`. */
  remember(input = {}) {
    return this.capture(input);
  }

  /**
   * Add a concrete owner-requested action to DMR's pattern ledger. Patterns
   * are evidence-backed suggestions only; this method has no ability to act.
   */
  observeAction({ action, context = {}, timestamp = this.now(), source = 'owner', outcome = true, metadata = {} } = {}) {
    if (!action || typeof action !== 'object') throw new Error('observeAction needs an action object');
    if (!outcome) return { status: 'ignored', reason: 'unsuccessful actions are not habits' };
    const at = Number(timestamp) || this.now();
    const cleanAction = {
      tool: cleanText(action.tool || action.name, 120),
      target: cleanText(action.target || action.entityId || action.entity_id, 160),
      verb: cleanText(action.verb || action.command || action.state || action.action, 120),
      arguments: action.arguments && typeof action.arguments === 'object' ? action.arguments : {},
    };
    if (!cleanAction.tool && !cleanAction.verb) throw new Error('action needs a tool or verb');
    const actionKey = stableJson(cleanAction);
    const contextShape = {
      scene: cleanText(context.scene, 80),
      condition: cleanText(context.condition, 120),
      entities: ensureArray(context.entities).map((item) => cleanText(item, 100)).filter(Boolean).sort().slice(0, 8),
    };
    const observationDayClass = context.dayClass || dayClass(at);
    const bucket = Number.isInteger(context.bucket) ? context.bucket : timeBucket(at);
    const contextKey = stableJson(contextShape);
    // Time window is part of a routine; weekday/weekend is retained as
    // evidence but not made a hard partition, so an every-evening routine can
    // accumulate evidence across a calendar week.
    const signature = hash(`${actionKey}|${contextKey}|${bucket}`, 28);
    const day = dayKey(at);

    return this.#transaction(() => {
      const duplicate = this.db.prepare(
        `SELECT id FROM dmr_pattern_observations
          WHERE signature = ? AND day_key = ? AND ABS(observed_at - ?) < 600000 LIMIT 1`,
      ).get(signature, day, at);
      if (duplicate) return { status: 'ignored', reason: 'duplicate observation', pattern: this.#pattern(signature) };

      this.db.prepare(
        `INSERT INTO dmr_pattern_observations
          (id, signature, action_key, context_key, day_key, bucket, day_class, source, outcome, observed_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, ?)`,
      ).run(nowId('pattern_observation'), signature, actionKey, contextKey, day, bucket, observationDayClass,
        cleanText(source, 40) || 'owner', at, JSON.stringify({ action: cleanAction, context: { ...contextShape, dayClass: observationDayClass, bucket }, ...metadata }));
      const pattern = this.#recomputePattern(signature, at);
      this.#event('pattern.observed', { signature, patternId: pattern?.id, action: cleanAction }, at);
      return { status: pattern?.state === 'tentative' ? 'tentative' : 'collecting', pattern };
    });
  }

  #pattern(signature) {
    const row = this.db.prepare('SELECT * FROM dmr_patterns WHERE signature = ?').get(signature);
    return row ? this.#patternFromRow(row) : null;
  }

  #patternFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      signature: row.signature,
      state: row.state,
      narrative: row.narrative,
      actionKey: row.action_key,
      contextKey: row.context_key,
      observations: Number(row.observations),
      distinctDays: Number(row.distinct_days),
      support: Number(row.support),
      confidence: Number(row.confidence),
      firstSeen: Number(row.first_seen),
      lastSeen: Number(row.last_seen),
      dismissedAt: row.dismissed_at == null ? null : Number(row.dismissed_at),
      metadata: json(row.metadata, {}),
    };
  }

  #recomputePattern(signature, now) {
    const items = this.db.prepare(
      'SELECT * FROM dmr_pattern_observations WHERE signature = ? ORDER BY observed_at',
    ).all(signature);
    if (!items.length) return null;
    const first = items[0];
    const action = json(first.metadata, {}).action || {};
    const context = json(first.metadata, {}).context || {};
    const distinctDays = new Set(items.map((item) => item.day_key)).size;
    // Competing means the same target/tool/time bucket but a different outcome
    // shape. It keeps a conflicted "sometimes on, sometimes off" action from
    // being sold to the owner as a dependable routine.
    const comparable = this.db.prepare(
      `SELECT action_key, day_key, metadata FROM dmr_pattern_observations
        WHERE bucket = ? AND observed_at >= ?`,
    ).all(first.bucket, now - 90 * DAY).filter((item) => {
      const candidate = json(item.metadata, {}).action || {};
      return candidate.tool === action.tool && candidate.target === action.target;
    });
    const support = clamp(items.length / (comparable.length || items.length), 0, 1);
    const confidence = clamp(support * Math.min(1, distinctDays / 5) * Math.min(1, items.length / 5), 0, 1);
    const state = distinctDays >= 3 && support >= 0.72 ? 'tentative' : 'collecting';
    const actionDescription = action.target
      ? ({ on: `turn on ${action.target}`, off: `turn off ${action.target}` }[action.verb]
        || `${action.verb || action.tool || 'act on'} ${action.target}`)
      : (action.verb || action.tool || 'perform an action');
    const hour = String(Number(first.bucket) * 3).padStart(2, '0');
    const endHour = String(Number(first.bucket) * 3 + 3).padStart(2, '0');
    const condition = [context.scene, context.condition].filter(Boolean).join('; ');
    const observedDayClasses = new Set(items.map((item) => item.day_class));
    const schedule = observedDayClasses.size > 1 ? 'across the week' : `on ${first.day_class}s`;
    const narrative = `${actionDescription || 'A repeated action'} between ${hour}:00–${endHour}:00 ${schedule}, observed on ${distinctDays} separate day${distinctDays === 1 ? '' : 's'}${condition ? ` when ${condition}` : ''}.`;
    const id = `pattern_${hash(signature, 16)}`;
    const previous = this.#pattern(signature);
    this.db.prepare(
      `INSERT INTO dmr_patterns
        (id, signature, state, narrative, action_key, context_key, observations, distinct_days, support,
         confidence, first_seen, last_seen, dismissed_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(signature) DO UPDATE SET
         state = CASE WHEN dmr_patterns.dismissed_at IS NULL THEN excluded.state ELSE 'dismissed' END,
         narrative = excluded.narrative, observations = excluded.observations,
         distinct_days = excluded.distinct_days, support = excluded.support, confidence = excluded.confidence,
         last_seen = excluded.last_seen, metadata = excluded.metadata`,
    ).run(id, signature, state, narrative, first.action_key, first.context_key, items.length, distinctDays,
      support, confidence, Number(first.observed_at), Number(items.at(-1).observed_at), JSON.stringify({ action, context }));
    const pattern = this.#pattern(signature);
    if (!previous || previous.state !== pattern.state) this.#event('pattern.updated', { id: pattern.id, state: pattern.state }, now);
    return pattern;
  }

  dismissPattern(id) {
    return this.#transaction(() => {
      const row = this.db.prepare('SELECT * FROM dmr_patterns WHERE id = ?').get(id);
      if (!row) return { ok: false, error: `No pattern ${id}` };
      const at = this.now();
      this.db.prepare("UPDATE dmr_patterns SET state = 'dismissed', dismissed_at = ? WHERE id = ?").run(at, id);
      this.#event('pattern.dismissed', { id }, at);
      return { ok: true, pattern: this.#patternFromRow(this.db.prepare('SELECT * FROM dmr_patterns WHERE id = ?').get(id)) };
    });
  }

  listPatterns({ includeDismissed = false, limit = 20 } = {}) {
    const take = clamp(limit, 1, 100);
    const query = includeDismissed
      ? 'SELECT * FROM dmr_patterns ORDER BY last_seen DESC LIMIT ?'
      : "SELECT * FROM dmr_patterns WHERE state != 'dismissed' ORDER BY last_seen DESC LIMIT ?";
    return this.db.prepare(query).all(take).map((row) => this.#patternFromRow(row));
  }

  #reflectionFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      namespace: row.namespace,
      facetType: row.facet_type,
      facetKey: row.facet_key,
      title: row.title,
      summary: row.summary,
      keywords: json(row.keywords, []),
      memberIds: json(row.member_ids, []),
      confidence: Number(row.confidence),
      active: Boolean(row.active),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  #reflectInternal({ namespace, now = this.now() } = {}) {
    const scope = namespace == null ? null : normalizeNamespace(namespace);
    const rows = this.db.prepare(
      `SELECT * FROM dmr_memories
        WHERE state != 'archived' ${scope ? 'AND namespace = ?' : ''}
        ORDER BY valid_from`,
    ).all(...(scope ? [scope] : [])).map(nodeFromRow);
    const byId = new Map(rows.map((memory) => [memory.id, memory]));
    const groups = new Map();
    const add = (namespaceValue, facetType, facetKey, memory) => {
      const cleanKey = cleanText(facetKey, 180);
      if (!cleanKey) return;
      const key = `${namespaceValue}\u0000${facetType}\u0000${cleanKey}`;
      if (!groups.has(key)) groups.set(key, { namespace: namespaceValue, facetType, facetKey: cleanKey, members: [] });
      groups.get(key).members.push(memory);
    };
    for (const memory of rows) {
      if (memory.subject !== 'memory' && !String(memory.predicate).startsWith('statement:')) {
        add(memory.namespace, 'thread', `${memory.subject} / ${memory.predicate}`, memory);
      }
    }
    const entities = this.#entityNamesFor(rows.map((memory) => memory.id));
    for (const [memoryId, names] of entities) {
      const memory = byId.get(memoryId);
      if (!memory) continue;
      for (const name of names) add(memory.namespace, 'entity', name, memory);
    }

    if (scope) this.db.prepare('UPDATE dmr_reflections SET active = 0 WHERE namespace = ?').run(scope);
    else this.db.prepare('UPDATE dmr_reflections SET active = 0').run();
    const stats = { created: 0, updated: 0, unchanged: 0, total: 0 };
    for (const group of groups.values()) {
      const uniqueMembers = [...new Map(group.members.map((memory) => [memory.id, memory])).values()];
      if (uniqueMembers.length < 2) continue;
      const reflection = buildReflection({ ...group, members: uniqueMembers });
      if (!reflection.summary) continue;
      const existing = this.db.prepare(
        'SELECT * FROM dmr_reflections WHERE namespace = ? AND facet_type = ? AND facet_key = ?',
      ).get(reflection.namespace, reflection.facetType, reflection.facetKey);
      const memberJson = JSON.stringify(reflection.memberIds);
      const keywordJson = JSON.stringify(reflection.keywords);
      if (!existing) {
        const id = `reflection_${hash(`${reflection.namespace}|${reflection.facetType}|${reflection.facetKey}`, 20)}`;
        this.db.prepare(
          `INSERT INTO dmr_reflections
            (id, namespace, facet_type, facet_key, title, summary, keywords, member_ids, confidence,
             active, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        ).run(id, reflection.namespace, reflection.facetType, reflection.facetKey, reflection.title,
          reflection.summary, keywordJson, memberJson, reflection.confidence, now, now);
        this.db.prepare(
          `INSERT INTO dmr_reflection_revisions
            (id, reflection_id, revision, summary, member_ids, created_at) VALUES (?, ?, 1, ?, ?, ?)`,
        ).run(nowId('reflection_revision'), id, reflection.summary, memberJson, now);
        stats.created += 1;
      } else if (existing.summary !== reflection.summary || existing.member_ids !== memberJson) {
        const revision = Number(existing.revision) + 1;
        this.db.prepare(
          `UPDATE dmr_reflections
              SET title = ?, summary = ?, keywords = ?, member_ids = ?, confidence = ?, active = 1,
                  revision = ?, updated_at = ?
            WHERE id = ?`,
        ).run(reflection.title, reflection.summary, keywordJson, memberJson, reflection.confidence,
          revision, now, existing.id);
        this.db.prepare(
          `INSERT INTO dmr_reflection_revisions
            (id, reflection_id, revision, summary, member_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(nowId('reflection_revision'), existing.id, revision, reflection.summary, memberJson, now);
        stats.updated += 1;
      } else {
        this.db.prepare('UPDATE dmr_reflections SET active = 1, updated_at = ? WHERE id = ?').run(now, existing.id);
        stats.unchanged += 1;
      }
      stats.total += 1;
    }
    return stats;
  }

  /** Rebuild derived continuity summaries without sending memory to a model or cloud. */
  reflect({ namespace, now = this.now() } = {}) {
    return this.#transaction(() => {
      const result = this.#reflectInternal({ namespace, now });
      this.#event('memory.reflected', { namespace: namespace || '*', ...result }, now);
      return result;
    });
  }

  listReflections({ namespaces, includeInactive = false, limit = 50 } = {}) {
    const scopes = (namespaces == null ? [] : Array.isArray(namespaces) ? namespaces : [namespaces])
      .map(normalizeNamespace);
    const clauses = [includeInactive ? '1 = 1' : 'active = 1'];
    const params = [];
    if (scopes.length) {
      clauses.push(`namespace IN ${dynamicIn(scopes)}`);
      params.push(...scopes);
    }
    params.push(clamp(limit, 1, 500));
    return this.db.prepare(
      `SELECT * FROM dmr_reflections WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...params).map((row) => this.#reflectionFromRow(row));
  }

  noteHistory(memoryId) {
    return this.db.prepare(
      'SELECT * FROM dmr_note_revisions WHERE memory_id = ? ORDER BY revision',
    ).all(String(memoryId)).map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      revision: Number(row.revision),
      reason: row.reason,
      contextText: row.context_text,
      keywords: json(row.keywords, []),
      tags: json(row.tags, []),
      createdAt: Number(row.created_at),
    }));
  }

  reflectionHistory(reflectionId) {
    return this.db.prepare(
      'SELECT * FROM dmr_reflection_revisions WHERE reflection_id = ? ORDER BY revision',
    ).all(String(reflectionId)).map((row) => ({
      id: row.id,
      reflectionId: row.reflection_id,
      revision: Number(row.revision),
      summary: row.summary,
      memberIds: json(row.member_ids, []),
      createdAt: Number(row.created_at),
    }));
  }

  /** Keep DMR's evidence graph useful as it ages without evicting memories. */
  consolidate({ now = this.now() } = {}) {
    return this.#transaction(() => {
      const before = this.db.prepare("SELECT COUNT(*) AS count FROM dmr_memories WHERE state = 'active'").get().count;
      const active = this.db.prepare("SELECT id, salience, updated_at, durable, pinned FROM dmr_memories WHERE state IN ('active', 'contested')").all();
      let adjusted = 0;
      for (const item of active) {
        if (item.pinned) continue;
        const ageDays = Math.max(0, now - Number(item.updated_at)) / DAY;
        const floor = item.durable ? 0.18 : 0.08;
        const next = Math.max(floor, Number(item.salience) * Math.exp(-ageDays / (item.durable ? 540 : 90)));
        if (Math.abs(next - Number(item.salience)) > 0.002) {
          this.db.prepare('UPDATE dmr_memories SET salience = ?, updated_at = updated_at WHERE id = ?').run(next, item.id);
          adjusted += 1;
        }
      }
      const signatures = this.db.prepare('SELECT DISTINCT signature FROM dmr_pattern_observations').all();
      for (const row of signatures) this.#recomputePattern(row.signature, now);
      const reflections = this.#reflectInternal({ now });
      const after = this.db.prepare("SELECT COUNT(*) AS count FROM dmr_memories WHERE state = 'active'").get().count;
      this.#event('memory.consolidated', { adjusted, activeBefore: before, activeAfter: after, reflections }, now);
      return { adjusted, activeBefore: before, activeAfter: after, patterns: signatures.length, reflections };
    });
  }

  #eligibleRows(kinds, options = {}) {
    if (typeof options === 'boolean') options = { includeHistorical: options };
    const { includeHistorical = false, asOf = null, namespaces = null } = options;
    const wanted = ensureArray(kinds).filter((kind) => KINDS.has(kind));
    const scopes = (namespaces == null ? [] : Array.isArray(namespaces) ? namespaces : [namespaces])
      .map(normalizeNamespace);
    const clauses = [wanted.length ? `kind IN ${dynamicIn(wanted)}` : '1 = 1'];
    const params = [...wanted];
    if (scopes.length) {
      clauses.push(`namespace IN ${dynamicIn(scopes)}`);
      params.push(...scopes);
    }
    if (asOf != null) {
      const at = asOf instanceof Date
        ? asOf.getTime()
        : (Number.isFinite(Number(asOf)) ? Number(asOf) : Date.parse(String(asOf)));
      if (!Number.isFinite(at)) throw new Error('asOf must be a timestamp, Date, or ISO date string');
      clauses.push("state != 'archived'", 'valid_from <= ?', '(valid_to IS NULL OR valid_to > ?)');
      params.push(at, at);
    } else {
      clauses.push(includeHistorical ? "state != 'archived'" : "state IN ('active', 'contested')");
    }
    return this.db.prepare(`SELECT * FROM dmr_memories WHERE ${clauses.join(' AND ')}`).all(...params).map(nodeFromRow);
  }

  #entityNamesFor(memoryIds) {
    if (!memoryIds.length) return new Map();
    const rows = this.db.prepare(
      `SELECT me.memory_id, e.canonical
         FROM dmr_memory_entities me JOIN dmr_entities e ON e.id = me.entity_id
        WHERE me.memory_id IN ${dynamicIn(memoryIds)}`,
    ).all(...memoryIds);
    const map = new Map(memoryIds.map((id) => [id, new Set()]));
    for (const row of rows) map.get(row.memory_id)?.add(row.canonical);
    return map;
  }

  #linkedCandidateIds(seedIds) {
    if (!seedIds.length) return new Map();
    const rows = this.db.prepare(
      `SELECT memory_a, memory_b, weight FROM dmr_links
        WHERE memory_a IN ${dynamicIn(seedIds)} OR memory_b IN ${dynamicIn(seedIds)}
        ORDER BY weight DESC LIMIT 80`,
    ).all(...seedIds, ...seedIds);
    const boosts = new Map();
    const seeds = new Set(seedIds);
    for (const row of rows) {
      const other = seeds.has(row.memory_a) ? row.memory_b : row.memory_a;
      if (!seeds.has(other)) boosts.set(other, Math.max(boosts.get(other) || 0, Number(row.weight)));
    }
    return boosts;
  }

  /**
   * Explainable retrieval. It mixes lexical relevance, time state, source
   * authority, reinforced salience, entities and graph links; it never hides a
   * contested memory that is directly relevant.
   */
  retrieve({
    query = '', limit = 10, kinds = ['fact'], includeHistorical, namespaces = null,
    asOf = null, now = this.now(), audit = true,
  } = {}) {
    const text = cleanText(query, 2_000);
    const wantsHistory = asOf != null || (includeHistorical ?? historicalIntent(text));
    const wantsCurrent = asOf == null && currentIntent(text);
    const asOfTime = asOf == null ? null : (asOf instanceof Date
      ? asOf.getTime()
      : (Number.isFinite(Number(asOf)) ? Number(asOf) : Date.parse(String(asOf))));
    const rows = this.#eligibleRows(kinds, { includeHistorical: wantsHistory, namespaces, asOf });
    const entitiesByNode = this.#entityNamesFor(rows.map((row) => row.id));
    const candidates = scoreCandidates(rows, {
      text, entitiesByNode, asOfTime, now, wantsCurrent, wantsHistory,
    });
    // One-hop associative recall lets a new question recover the surrounding
    // episode ("where was the printer when we discussed calibration?") without
    // spraying the full memory graph into the prompt.
    const seedIds = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 8).map((item) => item.node.id);
    const graphBoosts = this.#linkedCandidateIds(seedIds);
    const nodesById = new Map(rows.map((node) => [node.id, node]));
    for (const [id, weight] of graphBoosts) {
      const node = nodesById.get(id);
      if (!node) continue;
      const existing = candidates.get(id);
      if (existing) {
        existing.score += weight * 0.7;
        existing.reasons.push('connected memory');
      } else {
        candidates.set(id, {
          node,
          score: weight * 0.65 + node.confidence * 0.2 + node.salience * 0.15,
          lexical: 0,
          terms: [],
          reasons: ['associated with a directly relevant memory'],
          entities: entitiesByNode.get(id) || new Set(),
        });
      }
    }

    const selected = diversifyCandidates(candidates.values(), clamp(limit, 1, 50));

    const result = selected.map((item) => ({
      memory: legacyShape(item.node),
      node: item.node,
      score: item.score,
      reasons: item.reasons,
      matchedTerms: item.terms,
    }));
    if (audit) this.#auditRetrieval(text, result, now);
    return result;
  }

  #auditRetrieval(query, result, now) {
    // Keep a short audit tail. It shows *why* DMR supplied a memory, without
    // storing a model prompt or any private model reasoning.
    this.db.prepare('INSERT INTO dmr_retrieval_audit (id, query, created_at, result) VALUES (?, ?, ?, ?)')
      .run(nowId('retrieval'), cleanText(query, 2_000), now, JSON.stringify(result.map((item) => ({
        id: item.node.id, score: item.score, reasons: item.reasons,
      }))));
    this.db.prepare(
      `DELETE FROM dmr_retrieval_audit WHERE id NOT IN
       (SELECT id FROM dmr_retrieval_audit ORDER BY created_at DESC LIMIT 500)`,
    ).run();
  }

  /** Carvis-compatible search: return memory records, not internal score rows. */
  search(query, limit = 10, kinds = ['fact']) {
    return this.retrieve({ query, limit, kinds, audit: false }).map((item) => item.memory);
  }

  #patternContext(query, limit = 3) {
    const terms = new Set(tokenize(query));
    const patterns = this.listPatterns({ limit: 100 }).filter((pattern) => pattern.state === 'tentative');
    const scored = patterns.map((pattern) => {
      const payload = `${pattern.narrative} ${pattern.actionKey} ${pattern.contextKey}`;
      const shared = tokenize(payload).filter((term) => terms.has(term)).length;
      return { pattern, score: shared + pattern.confidence * 0.4, shared };
    }).filter((item) => !terms.size || item.shared > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.pattern);
    return scored;
  }

  #reflectionContext(query, { namespaces = null, limit = 3 } = {}) {
    const terms = new Set(tokenize(query));
    return this.listReflections({ namespaces, limit: 200 }).map((reflection) => {
      const payload = `${reflection.title} ${reflection.summary} ${reflection.keywords.join(' ')}`;
      const shared = tokenize(payload).filter((term) => terms.has(term)).length;
      return { reflection, score: shared + reflection.confidence * 0.35, shared };
    }).filter((item) => !terms.size || item.shared > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.reflection);
  }

  #renderBullets(nodes, charBudget, { labelState = false } = {}) {
    const lines = [];
    let used = 0;
    for (const node of nodes) {
      const qualifier = labelState ? ` [${node.state}; ${confidenceLabel(node.confidence)} confidence]` : '';
      const line = `- ${node.text}${qualifier}`;
      if (used + line.length > charBudget && lines.length) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines;
  }

  /**
   * Produce the stable Carvis interface plus richer trace data. `facts` is a
   * carefully ordered packet: live truths first, connected history second,
   * patterns only as non-authorizing suggestions, and ambiguity never buried.
   */
  assembleContext({
    query = '', factLimit = 8, charBudget = 5_200, namespaces = null, asOf = null, now = this.now(), patternFilter = null,
  } = {}) {
    const rowOptions = { namespaces, asOf };
    const activeRules = this.#eligibleRows(['rule'], rowOptions)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    const activePreferences = this.#eligibleRows(['preference'], rowOptions)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    const retrieved = this.retrieve({ query, limit: factLimit, kinds: ['fact', 'observation'], namespaces, asOf, now });
    const current = retrieved.filter((item) => item.node.state === 'active');
    const contested = retrieved.filter((item) => item.node.state === 'contested');
    const historical = retrieved.filter((item) => item.node.state === 'superseded');
    const patterns = this.#patternContext(query).filter(pattern => !patternFilter || patternFilter(pattern));
    const reflections = asOf == null ? this.#reflectionContext(query, { namespaces }) : [];

    const rulesLines = this.#renderBullets(activeRules, Math.min(2_000, Math.floor(charBudget * 0.26)));
    const preferenceLines = this.#renderBullets(activePreferences, Math.min(2_000, Math.floor(charBudget * 0.3)));
    const facts = [];
    let remaining = Math.max(800, charBudget - rulesLines.join('\n').length - preferenceLines.join('\n').length);
    const addSection = (heading, nodes, options = {}) => {
      if (!nodes.length || remaining < 80) return;
      const lines = this.#renderBullets(nodes, remaining - heading.length - 2, options);
      if (!lines.length) return;
      facts.push(heading, ...lines);
      remaining -= heading.length + lines.join('\n').length + 2;
    };
    if (asOf != null) {
      const at = asOf instanceof Date
        ? asOf.getTime()
        : (Number.isFinite(Number(asOf)) ? Number(asOf) : Date.parse(String(asOf)));
      addSection(`[TRUTHS VALID AT ${new Date(at).toISOString()}]`, retrieved.map((item) => item.node));
    } else {
      addSection('[CURRENT RELEVANT TRUTHS]', current.map((item) => item.node), { labelState: true });
      addSection('[CONNECTED HISTORY — use only when timing matters]', historical.map((item) => item.node), { labelState: true });
    }
    if (reflections.length && remaining > 220) {
      addSection('[DERIVED CONTINUITY — inspectable synthesis, not new evidence]', reflections.map((item) => ({
        text: item.summary, state: 'derived', confidence: item.confidence,
      })), { labelState: true });
    }
    if (patterns.length && remaining > 180) {
      const lines = patterns.map((pattern) => `- ${pattern.narrative} [tentative pattern; evidence ${Math.round(pattern.support * 100)}%; never authorization]`);
      facts.push('[TENTATIVE RECURRING PATTERNS — suggest, do not execute]', ...lines);
      remaining -= lines.join('\n').length;
    }
    addSection('[UNRESOLVED CONFLICTS — verify rather than assume]', contested.map((item) => item.node), { labelState: true });

    const usedIds = [...new Set([
      ...activeRules.map((node) => node.id),
      ...activePreferences.map((node) => node.id),
      ...retrieved.map((item) => item.node.id),
    ])];
    return {
      rules: rulesLines.join('\n'),
      preferences: preferenceLines.join('\n'),
      facts: facts.join('\n'),
      usedIds,
      trace: {
        query: cleanText(query),
        namespaces: (namespaces == null ? [] : Array.isArray(namespaces) ? namespaces : [namespaces]).map(normalizeNamespace),
        asOf: asOf == null ? null : new Date(Number.isFinite(Number(asOf)) ? Number(asOf) : Date.parse(String(asOf))).toISOString(),
        retrieval: retrieved.map((item) => ({ id: item.node.id, score: item.score, reasons: item.reasons })),
        reflections: reflections.map((item) => ({ id: item.id, revision: item.revision, memberIds: item.memberIds })),
        patterns: patterns.map((pattern) => ({ id: pattern.id, confidence: pattern.confidence, support: pattern.support })),
      },
    };
  }

  /** The exact name consumed by Carvis.#systemPrompt. */
  promptSections(probe = '') {
    return this.assembleContext({ query: probe });
  }

  markUsed(ids) {
    const memoryIds = [...new Set(ensureArray(ids).map(String).filter(Boolean))];
    if (!memoryIds.length) return;
    const at = this.now();
    this.#transaction(() => {
      const update = this.db.prepare(
        'UPDATE dmr_memories SET used_at = ?, use_count = use_count + 1, salience = MIN(1.0, salience + 0.025) WHERE id = ?',
      );
      for (const id of memoryIds) update.run(at, id);
      this.#event('memory.used', { memoryIds }, at);
    });
  }

  rules({ namespaces = null } = {}) {
    return this.#eligibleRows(['rule'], { namespaces })
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map(legacyShape);
  }

  all({ includeHistory = false, namespaces = null, asOf = null } = {}) {
    return this.#eligibleRows([...KINDS], { includeHistorical: includeHistory, namespaces, asOf })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .map(legacyShape);
  }

  review({ includeHistory = true, namespaces = null, asOf = null, limit = 500 } = {}) {
    const memories = this.#eligibleRows([...KINDS], { includeHistorical: includeHistory, namespaces, asOf })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, clamp(limit, 1, 2_000));
    const evidence = this.db.prepare(
      `SELECT * FROM dmr_evidence WHERE memory_id IN ${dynamicIn(memories.map((item) => item.id))}
       ORDER BY observed_at DESC`,
    ).all(...memories.map((item) => item.id));
    const evidenceByMemory = new Map(memories.map((item) => [item.id, []]));
    for (const item of evidence) evidenceByMemory.get(item.memory_id)?.push({
      id: item.id, source: item.source, stance: item.stance, quote: item.quote,
      observedAt: Number(item.observed_at), confidence: Number(item.confidence), metadata: json(item.metadata, {}),
    });
    return memories.map((memory) => ({ ...memory, evidence: evidenceByMemory.get(memory.id) || [] }));
  }

  get(id) {
    const node = this.#node(id);
    return node ? legacyShape(node) : null;
  }

  /** Resolve an imported/mirrored Carvis id without exposing SQL to adapters. */
  getByLegacyId(legacyId, { includeHistory = false } = {}) {
    const state = includeHistory ? "state != 'archived'" : "state IN ('active', 'contested')";
    const row = this.db.prepare(
      `SELECT * FROM dmr_memories WHERE legacy_id = ? AND ${state}
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(String(legacyId));
    const node = nodeFromRow(row);
    return node ? legacyShape(node) : null;
  }

  /** Owner deletion physically removes the selected memory and its evidence. */
  forget(id, { by = 'owner' } = {}) {
    return this.#transaction(() => {
      const node = this.#node(id);
      if (!node) return { ok: false, error: `No memory ${id}` };
      if (by === 'carvis' && node.source === 'owner') {
        return { ok: false, error: 'That memory was written by the owner; only they can remove it' };
      }
      this.db.prepare('DELETE FROM dmr_memories WHERE id = ?').run(id);
      this.#event('memory.forgotten', { memoryId: id, by }, this.now());
      return { ok: true, memory: legacyShape(node) };
    });
  }

  /**
   * An edit creates a successor and keeps the original only when needed for
   * historical provenance. It is never silently rewritten in place.
   */
  update(id, fields = {}) {
    const previous = this.#node(id);
    if (!previous) return { ok: false, error: `No memory ${id}` };
    const text = fields.text == null ? previous.text : cleanText(fields.text, 4_000);
    if (!text) return { ok: false, error: 'A memory needs text' };
    const kind = fields.kind ?? previous.kind;
    if (!KINDS.has(kind)) return { ok: false, error: `kind must be one of: ${[...KINDS].join(', ')}` };
    const namespace = normalizeNamespace(fields.namespace ?? previous.namespace);
    // Pinning is an annotation, not a new claim. Retaining the same identity
    // avoids manufacturing a false timeline merely because the owner starred it.
    if (text === previous.text && kind === previous.kind && namespace === previous.namespace) {
      return this.#transaction(() => {
        const at = this.now();
        const pinned = fields.pinned == null ? previous.pinned : Boolean(fields.pinned);
        this.db.prepare('UPDATE dmr_memories SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, at, id);
        this.#event('memory.annotated', { memoryId: id, pinned }, at);
        return { ok: true, memory: legacyShape(this.#node(id)), previous: legacyShape(previous), status: 'updated' };
      });
    }
    const result = this.capture({
      text, kind, source: previous.source, pinned: fields.pinned ?? previous.pinned,
      authority: previous.authority, confidence: previous.confidence, legacyId: previous.legacyId,
      namespace, keywords: fields.keywords, tags: fields.tags, contextText: fields.contextText,
      metadata: { ...previous.metadata, editedFrom: id }, supersedeIds: [id], resolve: true,
    });
    return { ok: true, memory: result.memory, previous: legacyShape(previous), status: result.status };
  }

  importLegacy(memories, { label = 'Carvis legacy memory import' } = {}) {
    const items = ensureArray(memories);
    const episode = this.beginEpisode({ source: 'import', title: label, summary: 'Read-only import from the existing Carvis memory integration.' });
    const result = [];
    try {
      for (const item of items) {
        if (!item?.text) continue;
        const duplicate = this.db.prepare('SELECT id FROM dmr_memories WHERE legacy_id = ? LIMIT 1').get(item.id);
        if (duplicate) { result.push({ legacyId: item.id, status: 'already_imported', memoryId: duplicate.id }); continue; }
        const imported = this.capture({
          text: item.text,
          kind: KINDS.has(item.kind) ? item.kind : 'fact',
          source: 'import', authority: item.source === 'owner' ? 0.98 : 0.72,
          confidence: item.source === 'owner' ? 0.98 : 0.72,
          pinned: Boolean(item.pinned), occurredAt: Number(item.updated_at || item.ts) || this.now(),
          validFrom: Number(item.ts) || this.now(), legacyId: item.id || null, episodeId: episode.id,
          metadata: { importedSource: item.source || 'unknown', importedAt: this.now() },
        });
        result.push({ legacyId: item.id, status: imported.status, memoryId: imported.node.id });
      }
    } finally {
      this.endEpisode(episode.id, { summary: `Imported ${result.length} legacy memory record(s).` });
    }
    return result;
  }

  /** Read a legacy Carvis SQLite database without modifying it. */
  importCarvisDatabase(carvisDbPath) {
    const source = new DatabaseSync(carvisDbPath, { readOnly: true });
    try {
      const rows = source.prepare('SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC').all();
      return this.importLegacy(rows, { label: `Carvis database import: ${path.basename(carvisDbPath)}` });
    } finally {
      source.close();
    }
  }

  state() {
    const totals = this.db.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN kind = 'fact' THEN 1 ELSE 0 END) AS facts,
        SUM(CASE WHEN kind = 'preference' THEN 1 ELSE 0 END) AS preferences,
        SUM(CASE WHEN kind = 'rule' THEN 1 ELSE 0 END) AS rules,
        SUM(CASE WHEN state = 'superseded' THEN 1 ELSE 0 END) AS historical,
        SUM(CASE WHEN state = 'contested' THEN 1 ELSE 0 END) AS contested
       FROM dmr_memories WHERE state != 'archived'`,
    ).get();
    const patterns = this.db.prepare("SELECT COUNT(*) AS count FROM dmr_patterns WHERE state = 'tentative'").get().count;
    const reflections = this.db.prepare('SELECT COUNT(*) AS count FROM dmr_reflections WHERE active = 1').get().count;
    const namespaces = this.db.prepare("SELECT COUNT(DISTINCT namespace) AS count FROM dmr_memories WHERE state != 'archived'").get().count;
    return {
      available: true,
      dbPath: this.dbPath,
      total: Number(totals.total || 0),
      facts: Number(totals.facts || 0),
      preferences: Number(totals.preferences || 0),
      rules: Number(totals.rules || 0),
      historical: Number(totals.historical || 0),
      contested: Number(totals.contested || 0),
      tentativePatterns: Number(patterns || 0),
      reflections: Number(reflections || 0),
      namespaces: Number(namespaces || 0),
      model: 'local temporal evolving evidence graph',
    };
  }

  retrievalAudit({ limit = 50 } = {}) {
    return this.db.prepare('SELECT * FROM dmr_retrieval_audit ORDER BY created_at DESC LIMIT ?').all(clamp(limit, 1, 500))
      .map((row) => ({ id: row.id, query: row.query, createdAt: Number(row.created_at), result: json(row.result, []) }));
  }
}

export { KINDS, legacyShape };
