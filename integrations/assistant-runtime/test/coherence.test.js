import test from 'node:test';
import assert from 'node:assert/strict';

import { coherent } from '../server/voice.js';

test('clear commands and questions pass regardless of length', () => {
  assert.equal(coherent('bring up the living room camera'), true);
  assert.equal(coherent('what is the P2S printer doing?'), true);
  assert.equal(coherent('turn it off'), true); // short, but has a verb
  assert.equal(coherent('lock it'), true);
});

test('short fragments, Unicode and mixed-case names reach triage', () => {
  for (const text of ['Hmm.', 'room camera.', 'no', 'yes', 'thanks', 'iPhone', 'YouTube', 'café', 'Let’s watch it', 'display lovingangled kimMarp']) {
    assert.equal(coherent(text), true, text);
  }
  for (const text of ['...', '🎵', '—']) assert.equal(coherent(text), false, text);
});

test('a VAD-truncated sentence is not, by itself, incoherent', () => {
  // Cut off mid-sentence by trailingSilenceMs, not garbled — has a verb and
  // enough words to pass on that basis alone.
  assert.equal(coherent('What the printer came out of my...'), true);
});

test('a fuzzy wake-word hit always passes, before any other check', () => {
  // The whole reason fuzzyWake is threaded in: an attempted address should
  // never be dropped as junk merely for being short.
  assert.equal(coherent('Harvest', { fuzzyWake: true }), true);
  assert.equal(coherent('Ca', { fuzzyWake: true }), true);
});

test('very low ASR confidence is junk even with a verb present', () => {
  assert.equal(coherent('turn off the lights', { confidence: 0.05 }), false);
  assert.equal(coherent('turn off the lights', { confidence: 0.6 }), true);
});

test('confidence null (unknown) never penalizes — absence is not evidence', () => {
  assert.equal(coherent('bring up the living room camera', { confidence: null }), true);
});

test('empty or whitespace-only text is junk', () => {
  assert.equal(coherent(''), false);
  assert.equal(coherent('   '), false);
});

test('a repeated-sentence hallucination loop is junk, even at high reported confidence', () => {
  // The real shape pulled from this app's own transcripts table under the old
  // Whisper engine: the same sentence, verbatim, dozens of times in a row.
  const looped = 'The P2S printer is a very good device. '.repeat(2) + "It's a very good device. ".repeat(30);
  assert.equal(coherent(looped, { confidence: 0.95 }), false);
});

test('a sentence said twice is not, by itself, a hallucination loop', () => {
  // Two is a stutter or a deliberate repeat ("lock it, lock it"); three+ in a
  // row is the actual failure shape this filter targets.
  assert.equal(coherent('Turn off the lights. Turn off the lights.'), true);
});
