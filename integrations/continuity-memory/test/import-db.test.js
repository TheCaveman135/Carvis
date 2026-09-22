import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { DMRStore } from '../src/index.js';

test('Carvis database import opens the source read-only and leaves it untouched', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dmr-import-'));
  const carvisDb = path.join(directory, 'carvis.db');
  const dmrDb = path.join(directory, 'dmr.db');
  try {
    const legacy = new DatabaseSync(carvisDb);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, ts INTEGER, updated_at INTEGER, kind TEXT, text TEXT,
        source TEXT, fingerprint TEXT, pinned INTEGER, used_at INTEGER, use_count INTEGER
      );
    `);
    legacy.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'mem_legacy', 1, 2, 'fact', 'The P2S printer lives in the garage.', 'owner', 'pos:p2s printer garage', 0, null, 0,
    );
    legacy.close();
    const before = statSync(carvisDb).mtimeMs;

    const dmr = new DMRStore({ dbPath: dmrDb });
    try {
      const imported = dmr.importCarvisDatabase(carvisDb);
      assert.equal(imported[0].status, 'created');
      assert.equal(dmr.search('P2S printer').length, 1);
    } finally {
      dmr.close();
    }
    assert.equal(statSync(carvisDb).mtimeMs, before);
    assert.equal(statSync(dmrDb).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
