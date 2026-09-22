import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

function moduleUrl(name) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  let code = stripTypeScriptTypes(source, { mode: 'strip' });
  if (name === 'background-state') code = code.replace("'./config'", JSON.stringify(moduleUrl('config')));
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
const { BackgroundState, createRuntimeState } = await import(moduleUrl('background-state'));
const { DISPLAY, SETTINGS_REVISION, STORAGE_KEYS } = await import(moduleUrl('config'));
const entry = seq => ({ id: `entry-${seq}`, seq, ts: seq * 1000, kind: 'reply', text: `Reply ${seq}`, detail: '' });
const confirmation = expiresAt => ({ id: 'confirm', prompt: 'Confirm action?', detail: '', createdAt: 1, expiresAt });

test('background snapshots retain bounded history and pairing but never resume in-flight work', () => {
  const original = createRuntimeState();
  const source = new BackgroundState(original);
  Object.assign(original, {
    muted: false, seq: 100, entries: Array.from({ length: 100 }, (_, i) => entry(i)),
    lastError: 'x'.repeat(500), busy: true, connected: true, confirmationBusy: true,
    lastPollAt: 100, nextRetryAt: 200, confirmation: confirmation(Date.now() + 60_000), indicator: 'off',
  });
  source.connection = { baseUrl: 'https://carvis.example', token: 'fixture-token', revision: SETTINGS_REVISION, clientId: 'fixture-client' };
  const snapshot = JSON.stringify(source.snapshot());
  const restored = createRuntimeState();
  const destination = new BackgroundState(restored);
  Object.assign(restored, { busy: true, connected: true, confirmationBusy: true, lastPollAt: 999, nextRetryAt: 999 });
  assert.equal(destination.restoreFromStorage(snapshot), true);
  assert.equal(restored.muted, false);
  assert.equal(restored.seq, 100);
  assert.equal(restored.entries.length, DISPLAY.maxLines * 4);
  assert.equal(restored.entries.at(-1).seq, 99);
  assert.equal(restored.lastError.length, 300);
  assert.equal(restored.indicator, 'off');
  assert.deepEqual(restored.confirmation, original.confirmation);
  assert.deepEqual(destination.connection, source.connection);
  for (const key of ['busy', 'connected', 'confirmationBusy']) assert.equal(restored[key], false);
  for (const key of ['lastPollAt', 'nextRetryAt']) assert.equal(restored[key], 0);
});

test('malformed snapshots cannot revive stale confirmations or obsolete pairing settings', () => {
  const state = createRuntimeState();
  const background = new BackgroundState(state);
  for (const input of ['{', null, '[]', 'false']) assert.equal(background.restore(input), false);
  state.confirmation = confirmation(Date.now() + 60_000);
  background.restore({
    muted: 'yes', seq: -1, entries: [{ bad: true }, entry(3)],
    confirmation: confirmation(1), indicator: 'invalid',
    connection: { baseUrl: 'https://old.example', token: 'obsolete', revision: 'obsolete', clientId: 'old-client' },
  });
  assert.equal(state.muted, true);
  assert.equal(state.seq, 0);
  assert.deepEqual(state.entries, [entry(3)]);
  assert.equal(state.confirmation, null);
  assert.equal(state.indicator, 'muted');
  assert.equal(background.connection, null);
});

test('host restores take precedence over storage and notify late UI subscribers', () => {
  const state = createRuntimeState();
  const background = new BackgroundState(state);
  const host = {};
  let notified = 0;
  background.installHostHooks(host);
  host.__restoreState('{');
  assert.equal(background.hostRestored, false);
  assert.equal(background.restoreFromStorage({ seq: 4 }), true);
  host.__restoreState(JSON.stringify({ [STORAGE_KEYS.runtimeState]: { seq: 9, muted: false } }));
  assert.equal(background.hostRestored, true);
  assert.equal(background.restoreFromStorage({ seq: 2, muted: true }), false);
  assert.equal(state.seq, 9);
  assert.equal(state.muted, false);
  background.onHostRestored = () => notified++;
  host.__restoreState({ [STORAGE_KEYS.runtimeState]: { seq: 10 } });
  assert.equal(notified, 1);
  assert.equal(JSON.parse(host.__getStateSnapshot())[STORAGE_KEYS.runtimeState].seq, 10);
});
