import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DMRStore, inferClaim } from '../src/index.js';

const utc = (day, hour = 19) => Date.UTC(2026, 0, day, hour, 0, 0);

function createStore(now = utc(20)) {
  return new DMRStore({ dbPath: ':memory:', now: () => now });
}

test('a changing fact retains its prior truth and retrieves the right time slice', () => {
  const dmr = createStore();
  try {
    dmr.remember({
      text: 'The P2S printer lives in the garage.', kind: 'fact', source: 'owner', occurredAt: utc(1),
    });
    dmr.remember({
      text: 'The P2S printer lives in the studio.', kind: 'fact', source: 'owner', occurredAt: utc(12),
    });

    const now = dmr.retrieve({ query: 'Where is the P2S printer now?', limit: 3 });
    assert.equal(now[0].node.text, 'The P2S printer lives in the studio.');
    assert.equal(now[0].node.state, 'active');

    const past = dmr.retrieve({ query: 'Where was the P2S printer before?', limit: 3 });
    assert.ok(past.some((item) => item.node.text.includes('garage') && item.node.state === 'superseded'));
    assert.ok(past.some((item) => item.node.text.includes('studio') && item.node.state === 'active'));
    assert.equal(dmr.state().historical, 1);
  } finally {
    dmr.close();
  }
});

test('explicit as-of recall returns only facts valid at that instant', () => {
  const dmr = createStore();
  try {
    dmr.remember({ text: 'The P2S printer lives in the garage.', source: 'owner', occurredAt: utc(1) });
    dmr.remember({ text: 'The P2S printer lives in the studio.', source: 'owner', occurredAt: utc(12) });

    const beforeMove = dmr.retrieve({ query: 'P2S printer location', asOf: utc(6), limit: 4 });
    const afterMove = dmr.retrieve({ query: 'P2S printer location', asOf: new Date(utc(14)), limit: 4 });
    assert.deepEqual(beforeMove.map((item) => item.node.text), ['The P2S printer lives in the garage.']);
    assert.deepEqual(afterMove.map((item) => item.node.text), ['The P2S printer lives in the studio.']);
    assert.match(beforeMove[0].reasons.join(' '), /true at/);
  } finally {
    dmr.close();
  }
});

test('namespaces isolate otherwise identical claim slots', () => {
  const dmr = createStore();
  try {
    dmr.remember({
      text: 'The P2S printer lives in the garage.', source: 'owner', namespace: 'home/workshop', occurredAt: utc(1),
    });
    dmr.remember({
      text: 'The P2S printer lives in the lab.', source: 'owner', namespace: 'project/prototype', occurredAt: utc(2),
    });

    const home = dmr.retrieve({ query: 'P2S printer location', namespaces: 'home/workshop' });
    const project = dmr.retrieve({ query: 'P2S printer location', namespaces: ['project/prototype'] });
    assert.equal(home[0].node.text, 'The P2S printer lives in the garage.');
    assert.equal(project[0].node.text, 'The P2S printer lives in the lab.');
    assert.equal(dmr.state().historical, 0);
  } finally {
    dmr.close();
  }
});

test('opening a pre-namespace database scopes old keys without duplicating its claim', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dmr-migration-'));
  const dbPath = path.join(directory, 'old-dmr.db');
  const text = 'The P2S printer lives in the garage.';
  const claim = inferClaim(text, 'fact');
  const rawSlot = claim.slotKey || `fact|${claim.subject}|${claim.predicate}`;
  const rawIdentity = claim.identityKey || `${rawSlot}|${claim.object}`;
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE dmr_memories (
      id TEXT PRIMARY KEY, kind TEXT, text TEXT, normalized TEXT, source TEXT, authority REAL,
      confidence REAL, state TEXT, pinned INTEGER, durable INTEGER, created_at INTEGER,
      updated_at INTEGER, valid_from INTEGER, valid_to INTEGER, used_at INTEGER, use_count INTEGER,
      salience REAL, subject TEXT, predicate TEXT, object TEXT, slot_key TEXT, identity_key TEXT,
      superseded_by TEXT, legacy_id TEXT, metadata TEXT
    )
  `);
  old.prepare(
    `INSERT INTO dmr_memories VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'old-memory', 'fact', text, text.toLowerCase(), 'owner', 1, 1, 'active', 0, 1,
    utc(1), utc(1), utc(1), null, null, 0, 0.8, claim.subject, claim.predicate, claim.object,
    rawSlot, rawIdentity, null, null, '{}',
  );
  old.close();

  const dmr = new DMRStore({ dbPath, now: () => utc(20) });
  try {
    const migrated = dmr.review()[0];
    assert.equal(migrated.namespace, 'owner');
    assert.match(migrated.slotKey, /^owner\|/);
    assert.equal(dmr.remember({ text, source: 'owner' }).status, 'reinforced');
    assert.equal(dmr.state().total, 1);
  } finally {
    dmr.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a fact can return to an earlier value without resurrecting stale timestamps', () => {
  const dmr = createStore();
  try {
    dmr.remember({ text: 'The P2S printer lives in the garage.', source: 'owner', occurredAt: utc(1) });
    dmr.remember({ text: 'The P2S printer lives in the studio.', source: 'owner', occurredAt: utc(2) });
    dmr.remember({ text: 'The P2S printer lives in the garage.', source: 'owner', occurredAt: utc(3) });
    const current = dmr.retrieve({ query: 'Where is the P2S printer now?', limit: 3 });
    assert.equal(current[0].node.text, 'The P2S printer lives in the garage.');
    assert.equal(current[0].node.state, 'active');
    assert.equal(dmr.review().filter((memory) => memory.text.includes('P2S printer')).length, 3);
  } finally {
    dmr.close();
  }
});

test('reversed location wording resolves to the same temporal slot', () => {
  const dmr = createStore();
  try {
    dmr.remember({ text: 'The P2S printer lives in the garage.', source: 'owner', occurredAt: utc(1) });
    dmr.remember({ text: 'The studio is where the P2S printer lives.', source: 'owner', occurredAt: utc(2) });
    const result = dmr.retrieve({ query: 'Where is the P2S printer now?', limit: 2 });
    assert.equal(result[0].node.text, 'The studio is where the P2S printer lives.');
    assert.equal(dmr.state().historical, 1);
  } finally {
    dmr.close();
  }
});

test('a lower-authority contradiction becomes visible rather than overwriting the owner', () => {
  const dmr = createStore();
  try {
    dmr.remember({ text: 'The P2S printer lives in the garage.', source: 'owner', occurredAt: utc(1) });
    const result = dmr.remember({
      text: 'The P2S printer lives in the studio.', source: 'carvis', confidence: 0.62, occurredAt: utc(2),
    });
    assert.equal(result.status, 'contested');
    assert.equal(dmr.state().contested, 2);
    const packet = dmr.promptSections('Where is the P2S printer now?');
    assert.match(packet.facts, /UNRESOLVED CONFLICTS/);
    assert.match(packet.facts, /garage/);
    assert.match(packet.facts, /studio/);
  } finally {
    dmr.close();
  }
});

test('an episode and shared entity establish associative context without full-history dumping', () => {
  const dmr = createStore();
  try {
    const episode = dmr.beginEpisode({ title: 'Printer calibration', source: 'owner', startedAt: utc(3) });
    dmr.remember({
      text: 'The P2S printer lives in the studio.', source: 'owner', episodeId: episode.id,
      entities: ['printer.p2s'], occurredAt: utc(3),
    });
    dmr.remember({
      text: 'The P2S printer needs a first-layer calibration after its move.', source: 'owner', episodeId: episode.id,
      entities: ['printer.p2s'], occurredAt: utc(3, 20),
    });
    dmr.endEpisode(episode.id, { endedAt: utc(3, 21) });

    const result = dmr.retrieve({ query: 'What context do we have for printer.p2s?', limit: 4 });
    assert.ok(result.some((item) => item.node.text.includes('first-layer calibration')));
    assert.ok(result.some((item) => item.reasons.some((reason) => /connected|shared entity/.test(reason))));
  } finally {
    dmr.close();
  }
});

test('atomic notes evolve through local links and reflection keeps an audit-friendly synthesis', () => {
  const dmr = createStore();
  try {
    const first = dmr.remember({
      text: 'The P2S printer lives in the studio.', source: 'owner', namespace: 'home/workshop',
      entities: ['printer.p2s'], occurredAt: utc(3),
    });
    dmr.remember({
      text: 'The P2S printer uses PLA filament.', source: 'owner', namespace: 'home/workshop',
      entities: ['printer.p2s'], occurredAt: utc(4),
    });

    const evolved = dmr.review({ namespaces: 'home/workshop' }).find((item) => item.id === first.node.id);
    assert.ok(evolved.revision > 1);
    assert.equal(evolved.text, 'The P2S printer lives in the studio.');
    assert.ok(evolved.tags.some((tag) => tag.startsWith('link:')));
    assert.ok(dmr.noteHistory(first.node.id).length > 1);

    const reflected = dmr.reflect({ namespace: 'home/workshop', now: utc(5) });
    assert.ok(reflected.total >= 1);
    const continuity = dmr.listReflections({ namespaces: 'home/workshop' })
      .find((item) => item.facetType === 'entity' && item.facetKey === 'printer.p2s');
    assert.ok(continuity);
    assert.match(continuity.summary, /studio/);
    assert.match(continuity.summary, /PLA filament/);
    assert.equal(dmr.reflectionHistory(continuity.id).length, 1);
    assert.match(dmr.assembleContext({ query: 'printer', namespaces: 'home/workshop' }).facts, /DERIVED CONTINUITY/);
  } finally {
    dmr.close();
  }
});

test('patterns require repeated distinct-day evidence and never become authorization', () => {
  const dmr = createStore();
  try {
    for (const day of [1, 3, 5]) {
      dmr.observeAction({
        action: { tool: 'ha.light.set', target: 'light.desk', verb: 'on', arguments: { brightness: 25 } },
        context: { scene: 'evening desk work' }, timestamp: utc(day), source: 'owner',
      });
    }
    const pattern = dmr.listPatterns()[0];
    assert.equal(pattern.state, 'tentative');
    assert.equal(pattern.distinctDays, 3);
    const packet = dmr.promptSections('Set up my desk evening routine');
    assert.match(packet.facts, /TENTATIVE RECURRING PATTERNS/);
    assert.match(packet.facts, /never authorization/);
    assert.doesNotMatch(dmr.promptSections('Where is the P2S printer now?').facts, /TENTATIVE RECURRING PATTERNS/);
    assert.equal(typeof dmr.observeAction, 'function');
    assert.equal('executeAction' in dmr, false);
  } finally {
    dmr.close();
  }
});

test('competing actions lower support instead of producing a confident habit', () => {
  const dmr = createStore();
  try {
    for (const day of [1, 3, 5]) {
      dmr.observeAction({ action: { tool: 'ha.media.control', target: 'media_player.spotify', verb: 'play' }, timestamp: utc(day) });
      dmr.observeAction({ action: { tool: 'ha.media.control', target: 'media_player.spotify', verb: 'pause' }, timestamp: utc(day, 20) });
    }
    assert.equal(dmr.listPatterns().some((pattern) => pattern.state === 'tentative'), false);
  } finally {
    dmr.close();
  }
});

test('owner deletion erases the selected memory and its recall path', () => {
  const dmr = createStore();
  try {
    const saved = dmr.remember({ text: 'The garage keypad code is remembered only temporarily.', source: 'owner' });
    assert.equal(dmr.search('garage keypad code').length, 1);
    assert.equal(dmr.forget(saved.memory.id, { by: 'owner' }).ok, true);
    assert.equal(dmr.search('garage keypad code').length, 0);
    assert.equal(dmr.state().total, 0);
  } finally {
    dmr.close();
  }
});

test('an edit preserves the predecessor as a dated historical record', () => {
  const dmr = createStore();
  try {
    const saved = dmr.remember({ text: 'The workshop speaker is in the garage.', source: 'owner', occurredAt: utc(1) });
    const changed = dmr.update(saved.memory.id, { text: 'The workshop speaker is in the studio.' });
    assert.equal(changed.ok, true);
    const review = dmr.review();
    assert.equal(review.filter((item) => item.text.includes('workshop speaker')).length, 2);
    assert.equal(review.filter((item) => item.state === 'superseded').length, 1);
  } finally {
    dmr.close();
  }
});
