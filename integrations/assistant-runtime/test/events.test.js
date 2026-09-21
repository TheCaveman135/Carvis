import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHaChange } from '../server/events.js';

test('only terminal lock states become semantic lock events', () => {
  const state = (value) => ({ state: value, attributes: { friendly_name: 'Apartment door' } });
  assert.equal(
    normalizeHaChange('lock.example_entry', state('unlocking'), state('locked'), 'Home'),
    null,
  );
  assert.equal(
    normalizeHaChange('lock.example_entry', state('locking'), state('unlocked'), 'Home'),
    null,
  );
  assert.equal(
    normalizeHaChange('lock.example_entry', state('jammed'), state('locked'), 'Home'),
    null,
  );
  assert.equal(
    normalizeHaChange('lock.example_entry', state('unlocked'), state('locking'), 'Home')?.type,
    'home.lock.unlocked',
  );
  assert.equal(
    normalizeHaChange('lock.example_entry', state('locked'), state('unlocking'), 'Home')?.type,
    'home.lock.locked',
  );
});
