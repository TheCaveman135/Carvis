/** SQLite schema and idempotent upgrades for both fresh and legacy DMR stores. */
export function migrateDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dmr_memories (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      text           TEXT NOT NULL,
      normalized     TEXT NOT NULL,
      source         TEXT NOT NULL,
      authority      REAL NOT NULL,
      confidence     REAL NOT NULL,
      state          TEXT NOT NULL,
      pinned         INTEGER NOT NULL DEFAULT 0,
      durable        INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      valid_from     INTEGER NOT NULL,
      valid_to       INTEGER,
      used_at        INTEGER,
      use_count      INTEGER NOT NULL DEFAULT 0,
      salience       REAL NOT NULL DEFAULT 0.5,
      subject        TEXT NOT NULL,
      predicate      TEXT NOT NULL,
      object         TEXT NOT NULL,
      slot_key       TEXT NOT NULL,
      identity_key   TEXT NOT NULL,
      namespace      TEXT NOT NULL DEFAULT 'owner',
      keywords       TEXT NOT NULL DEFAULT '[]',
      tags           TEXT NOT NULL DEFAULT '[]',
      context_text   TEXT NOT NULL DEFAULT '',
      revision       INTEGER NOT NULL DEFAULT 1,
      superseded_by  TEXT,
      legacy_id      TEXT,
      metadata       TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(superseded_by) REFERENCES dmr_memories(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS dmr_memories_identity ON dmr_memories(identity_key, state);
    CREATE INDEX IF NOT EXISTS dmr_memories_slot ON dmr_memories(slot_key, state, valid_from DESC);
    CREATE INDEX IF NOT EXISTS dmr_memories_kind ON dmr_memories(kind, state, pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS dmr_memories_legacy ON dmr_memories(legacy_id);

    CREATE TABLE IF NOT EXISTS dmr_episodes (
      id             TEXT PRIMARY KEY,
      source         TEXT NOT NULL,
      title          TEXT NOT NULL,
      started_at     INTEGER NOT NULL,
      ended_at       INTEGER,
      summary        TEXT NOT NULL DEFAULT '',
      metadata       TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS dmr_episodes_started ON dmr_episodes(started_at DESC);

    CREATE TABLE IF NOT EXISTS dmr_evidence (
      id             TEXT PRIMARY KEY,
      memory_id      TEXT NOT NULL,
      episode_id     TEXT,
      source         TEXT NOT NULL,
      stance         TEXT NOT NULL,
      quote          TEXT NOT NULL,
      observed_at    INTEGER NOT NULL,
      confidence     REAL NOT NULL,
      metadata       TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(memory_id) REFERENCES dmr_memories(id) ON DELETE CASCADE,
      FOREIGN KEY(episode_id) REFERENCES dmr_episodes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS dmr_evidence_memory ON dmr_evidence(memory_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS dmr_evidence_episode ON dmr_evidence(episode_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS dmr_episode_members (
      episode_id     TEXT NOT NULL,
      memory_id      TEXT NOT NULL,
      added_at       INTEGER NOT NULL,
      PRIMARY KEY(episode_id, memory_id),
      FOREIGN KEY(episode_id) REFERENCES dmr_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY(memory_id) REFERENCES dmr_memories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dmr_entities (
      id             TEXT PRIMARY KEY,
      canonical      TEXT NOT NULL UNIQUE,
      type           TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      metadata       TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS dmr_memory_entities (
      memory_id      TEXT NOT NULL,
      entity_id      TEXT NOT NULL,
      PRIMARY KEY(memory_id, entity_id),
      FOREIGN KEY(memory_id) REFERENCES dmr_memories(id) ON DELETE CASCADE,
      FOREIGN KEY(entity_id) REFERENCES dmr_entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS dmr_memory_entities_entity ON dmr_memory_entities(entity_id, memory_id);

    CREATE TABLE IF NOT EXISTS dmr_links (
      memory_a       TEXT NOT NULL,
      memory_b       TEXT NOT NULL,
      relation       TEXT NOT NULL,
      weight         REAL NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY(memory_a, memory_b, relation),
      FOREIGN KEY(memory_a) REFERENCES dmr_memories(id) ON DELETE CASCADE,
      FOREIGN KEY(memory_b) REFERENCES dmr_memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS dmr_links_a ON dmr_links(memory_a, weight DESC);
    CREATE INDEX IF NOT EXISTS dmr_links_b ON dmr_links(memory_b, weight DESC);

    CREATE TABLE IF NOT EXISTS dmr_pattern_observations (
      id             TEXT PRIMARY KEY,
      signature      TEXT NOT NULL,
      action_key     TEXT NOT NULL,
      context_key    TEXT NOT NULL,
      day_key        TEXT NOT NULL,
      bucket         INTEGER NOT NULL,
      day_class      TEXT NOT NULL,
      source         TEXT NOT NULL,
      outcome        TEXT NOT NULL,
      observed_at    INTEGER NOT NULL,
      metadata       TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS dmr_pattern_obs_signature ON dmr_pattern_observations(signature, observed_at DESC);
    CREATE INDEX IF NOT EXISTS dmr_pattern_obs_action ON dmr_pattern_observations(action_key, bucket, observed_at DESC);

    CREATE TABLE IF NOT EXISTS dmr_patterns (
      id             TEXT PRIMARY KEY,
      signature      TEXT NOT NULL UNIQUE,
      state          TEXT NOT NULL,
      narrative      TEXT NOT NULL,
      action_key     TEXT NOT NULL,
      context_key    TEXT NOT NULL,
      observations   INTEGER NOT NULL,
      distinct_days  INTEGER NOT NULL,
      support        REAL NOT NULL,
      confidence     REAL NOT NULL,
      first_seen     INTEGER NOT NULL,
      last_seen      INTEGER NOT NULL,
      dismissed_at   INTEGER,
      metadata       TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS dmr_patterns_state ON dmr_patterns(state, last_seen DESC);

    CREATE TABLE IF NOT EXISTS dmr_events (
      id             TEXT PRIMARY KEY,
      type           TEXT NOT NULL,
      occurred_at    INTEGER NOT NULL,
      data           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dmr_events_time ON dmr_events(occurred_at DESC);

    CREATE TABLE IF NOT EXISTS dmr_retrieval_audit (
      id             TEXT PRIMARY KEY,
      query          TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      result          TEXT NOT NULL
    );

    /* A-MEM-inspired evolving note metadata. Claim text remains immutable;
       only the derived context/tags evolve, with every revision retained. */
    CREATE TABLE IF NOT EXISTS dmr_note_revisions (
      id             TEXT PRIMARY KEY,
      memory_id      TEXT NOT NULL,
      revision       INTEGER NOT NULL,
      reason         TEXT NOT NULL,
      context_text   TEXT NOT NULL,
      keywords       TEXT NOT NULL,
      tags           TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      FOREIGN KEY(memory_id) REFERENCES dmr_memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS dmr_note_revisions_memory
      ON dmr_note_revisions(memory_id, revision DESC);

    /* Background reflections are replaceable derived context. Their own
       revision ledger makes self-organization inspectable and reversible. */
    CREATE TABLE IF NOT EXISTS dmr_reflections (
      id             TEXT PRIMARY KEY,
      namespace      TEXT NOT NULL,
      facet_type     TEXT NOT NULL,
      facet_key      TEXT NOT NULL,
      title          TEXT NOT NULL,
      summary        TEXT NOT NULL,
      keywords       TEXT NOT NULL,
      member_ids     TEXT NOT NULL,
      confidence     REAL NOT NULL,
      active         INTEGER NOT NULL DEFAULT 1,
      revision       INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      UNIQUE(namespace, facet_type, facet_key)
    );
    CREATE INDEX IF NOT EXISTS dmr_reflections_scope
      ON dmr_reflections(namespace, updated_at DESC);
    CREATE TABLE IF NOT EXISTS dmr_reflection_revisions (
      id             TEXT PRIMARY KEY,
      reflection_id  TEXT NOT NULL,
      revision       INTEGER NOT NULL,
      summary        TEXT NOT NULL,
      member_ids     TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      FOREIGN KEY(reflection_id) REFERENCES dmr_reflections(id) ON DELETE CASCADE
    );
  `);
  ensureColumn(db, 'dmr_memories', 'namespace', "TEXT NOT NULL DEFAULT 'owner'");
  ensureColumn(db, 'dmr_memories', 'keywords', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'dmr_memories', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'dmr_memories', 'context_text', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'dmr_memories', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'dmr_reflections', 'active', 'INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE INDEX IF NOT EXISTS dmr_memories_namespace ON dmr_memories(namespace, state, updated_at DESC)');
  // Older DMR databases predate namespaces. Scope their conflict keys once so
  // an identical claim in two workspaces can coexist without interference.
  db.exec(`
    UPDATE dmr_memories
       SET namespace = 'owner'
     WHERE namespace IS NULL OR namespace = '';
    UPDATE dmr_memories
       SET slot_key = namespace || '|' || slot_key,
           identity_key = namespace || '|' || identity_key
     WHERE substr(slot_key, 1, length(namespace) + 1) != namespace || '|';
  `);
}

function ensureColumn(db, table, column, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}
