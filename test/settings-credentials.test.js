import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { createAccount, issueSession } from '../server/auth.js';

test('model settings and shared keys use one OpenAI credential, with provider-isolated discovery', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'carvis-key-settings-'));
  const requests = [];
  const app = await createApp({
    dataDirectory: directory,
    modules: [],
    fetcher: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
      return Response.json({ data: [{ id: 'fixture-model' }] });
    },
  });
  app.store.config.auth = createAccount('fixture-owner', 'fixture-password-only');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.registry.close();
    await new Promise(resolve => app.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { cookie: `carvis_session=${issueSession(app.store.config)}`, 'content-type': 'application/json' };
  const post = async (path, data) => {
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  app.store.config.model.apiKey = 'fixture-legacy-openai';
  await post('/api/settings', { model: { provider: 'compatible', baseUrl: 'https://compatible.example/v1' } });
  assert.equal(app.store.config.apiKeys.openai, 'fixture-legacy-openai');
  assert.equal(app.store.config.model.apiKey, '');
  await post('/api/settings', {
    apiKeys: { openai: 'fixture-shared-key' },
    model: { provider: 'compatible', baseUrl: 'https://compatible.example/v1', model: 'fixture-model', apiKey: 'fixture-compatible-key' },
  });
  await post('/api/models', { provider: 'openai', apiKey: '' });
  assert.deepEqual(requests.pop(), { url: 'https://api.openai.com/v1/models', authorization: 'Bearer fixture-shared-key' });
  await post('/api/models', { provider: 'compatible', baseUrl: 'https://another.example/v1' });
  assert.equal(requests.pop().authorization, undefined);

  const changed = await post('/api/settings', {
    model: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-replacement' },
  });
  assert.equal(changed.model.hasApiKey, true);
  assert.equal(app.store.config.apiKeys.openai, 'fixture-replacement');
  assert.equal(app.store.config.model.apiKey, '');
  assert.ok(!JSON.stringify(changed).includes('fixture-replacement'));
  await post('/api/models', {});
  assert.equal(requests.pop().authorization, 'Bearer fixture-replacement');

  await post('/api/settings', { apiKeys: { openai: 'fixture-rotated' } });
  await post('/api/models', {});
  assert.equal(requests.pop().authorization, 'Bearer fixture-rotated');
  const cleared = await post('/api/settings', { model: { clearApiKey: true } });
  assert.equal(cleared.model.hasApiKey, false);
  assert.equal(app.store.config.apiKeys.openai, null);
  assert.equal(app.store.config.model.apiKey, '');
});
