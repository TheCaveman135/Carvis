import assert from 'node:assert/strict';
import test from 'node:test';

import { CarvisDmrAdapter, DMRStore } from '../src/index.js';

function legacyStub() {
  const items = [];
  return {
    items,
    remember(input) {
      const memory = {
        id: `legacy_${items.length + 1}`,
        ts: Date.now(), updated_at: Date.now(), kind: input.kind || 'fact', text: input.text,
        source: input.source || 'carvis', pinned: Boolean(input.pinned), use_count: 0,
      };
      items.push(memory);
      return { memory, status: 'created' };
    },
    all: () => items.map((item) => ({ ...item })),
    search(query, limit) { return items.filter((item) => item.text.toLowerCase().includes(query.toLowerCase())).slice(0, limit); },
    promptSections: () => ({ rules: '', preferences: '', facts: '', usedIds: [] }),
    markUsed() {},
    rules: () => items.filter((item) => item.kind === 'rule'),
    forget(id) {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return { ok: false, error: `No memory ${id}` };
      const [memory] = items.splice(index, 1);
      return { ok: true, memory };
    },
    update(id, fields) {
      const memory = items.find((item) => item.id === id);
      if (!memory) return { ok: false, error: `No memory ${id}` };
      Object.assign(memory, fields, { updated_at: Date.now() });
      return { ok: true, memory };
    },
  };
}

test('shadow adapter preserves Carvis return shape while enriching DMR', () => {
  const dmr = new DMRStore({ dbPath: ':memory:' });
  try {
    const legacy = legacyStub();
    const adapter = new CarvisDmrAdapter({ dmr, legacy, mode: 'shadow' });
    const saved = adapter.remember({ text: 'I prefer quiet replies at night.', kind: 'preference', source: 'owner' });
    assert.equal(saved.memory.id, 'legacy_1');
    assert.equal(legacy.items.length, 1);
    assert.equal(dmr.state().preferences, 1);

    const packet = adapter.promptSections('Turn on the bedside lamp');
    assert.match(packet.preferences, /quiet replies/);
    assert.equal(adapter.state().rollout, 'shadow');
  } finally {
    dmr.close();
  }
});

test('legacy import is idempotent and does not need access to the Carvis database', () => {
  const dmr = new DMRStore({ dbPath: ':memory:' });
  try {
    const legacy = legacyStub();
    legacy.remember({ text: 'The P2S printer lives in the garage.', kind: 'fact', source: 'owner' });
    const adapter = new CarvisDmrAdapter({ dmr, legacy });
    assert.equal(adapter.adoptLegacy()[0].status, 'created');
    assert.equal(adapter.adoptLegacy()[0].status, 'already_imported');
    assert.equal(dmr.search('P2S printer').length, 1);
  } finally {
    dmr.close();
  }
});

test('shadow deletion resolves a legacy id and removes both copies', () => {
  const dmr = new DMRStore({ dbPath: ':memory:' });
  try {
    const legacy = legacyStub();
    const adapter = new CarvisDmrAdapter({ dmr, legacy, mode: 'shadow' });
    const saved = adapter.remember({ text: 'Remove this private note.', kind: 'fact', source: 'owner' });
    assert.equal(adapter.forget(saved.memory.id, { by: 'owner' }).ok, true);
    assert.equal(legacy.items.length, 0);
    assert.equal(dmr.state().total, 0);
  } finally {
    dmr.close();
  }
});
