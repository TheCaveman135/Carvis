import test from 'node:test';
import assert from 'node:assert/strict';

import { AtlasClient } from '../server/atlas.js';

function client() {
  return new AtlasClient(() => ({
    atlas: {
      enabled: true,
      endpoints: ['http://192.0.2.10:8420/', 'http://127.0.0.1:18420'],
      baseUrl: 'http://192.0.2.10:8420',
      keychainService: 'test-only',
    },
  }));
}

test('Atlas route ordering is stable and never probes a duplicate address', () => {
  const atlas = client();
  assert.deepEqual(atlas.endpoints, ['http://192.0.2.10:8420', 'http://127.0.0.1:18420']);
  atlas.activeEndpoint = 'http://127.0.0.1:18420';
  assert.deepEqual(atlas.endpoints, ['http://127.0.0.1:18420', 'http://192.0.2.10:8420']);
});

test('an exact Atlas title clears the retrieval floor even in a tiny corpus', () => {
  const atlas = client();
  atlas.snapshot.projects = [
    { id: 'calendar', title: 'Calendar', summary_md: '', body_md: '', updated_at: new Date().toISOString() },
    { id: 'other', title: 'Home', summary_md: 'Calendar integration', body_md: '', updated_at: new Date().toISOString() },
  ];
  const hits = atlas.retrieve({ query: 'Calendar' });
  assert.equal(hits[0]?.id, 'calendar');
  assert.ok(hits[0].score >= 3);
});
