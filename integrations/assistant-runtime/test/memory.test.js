import test from 'node:test';
import assert from 'node:assert/strict';

import { fingerprint, jaccard, tokenize } from '../server/memory.js';

/**
 * The pure memory matching helpers; runtime persistence is tested separately.
 */

test('a reworded claim collapses to the same fingerprint', () => {
  assert.equal(
    fingerprint('The sample printer lives in the garage'),
    fingerprint('the garage is where the sample printer lives'),
  );
});

test('negation survives the fingerprint', () => {
  // The whole point. These share every content token, and collapsing them would
  // let Carvis overwrite a preference with its exact opposite and report
  // success — the store would then confidently assert the reverse of the truth.
  const likes = fingerprint('likes the heater on at night');
  const dislikes = fingerprint('does not like the heater on at night');
  assert.notEqual(likes, dislikes);

  for (const negative of ["doesn't like the heater on", 'never wants the heater on', 'hates the heater on']) {
    assert.ok(fingerprint(negative).startsWith('neg:'), `${negative} should read as negated`);
  }
});

test('stopwords and short tokens are dropped, so phrasing does not matter', () => {
  assert.deepEqual(tokenize('The printer is in my garage'), ['printer', 'garage']);
  assert.deepEqual(tokenize('a an and the of to'), []);
});

test('spatial and state words are never treated as noise', () => {
  // These read like function words and are not. Stopwording them would collapse
  // opposite preferences onto one fingerprint, letting either silently
  // overwrite the other — the same failure negation-detection exists to stop.
  const pairs = [
    ['likes the blinds down', 'likes the blinds up'],
    ['leaves the garage door open', 'leaves the garage door shut'],
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(fingerprint(left), fingerprint(right), `${left} vs ${right} must stay distinct`);
  }
});

test('jaccard separates the same idea from a different one', () => {
  const near = jaccard('goes to bed around midnight', 'goes to bed near midnight');
  const far = jaccard('goes to bed around midnight', 'the printer is in the garage');
  assert.ok(near >= 0.8, `reworded should clear the 0.8 near-duplicate bar, got ${near}`);
  assert.equal(far, 0);
});

test('jaccard is defined when a side has no scoreable tokens', () => {
  assert.equal(jaccard('', 'anything at all'), 0);
  assert.equal(jaccard('the of and', 'printer garage'), 0);
});
