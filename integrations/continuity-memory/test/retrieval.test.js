import assert from 'node:assert/strict';
import test from 'node:test';
import { jaccard } from '../src/lexical.js';
import { diversifyCandidates } from '../src/retrieval.js';

// The straightforward definition is intentionally independent of the cached
// implementation: it protects both ranking order and audit scores as it evolves.
function referenceSelection(candidates, limit) {
  const remaining = [...candidates].sort((a, b) => b.score - a.score);
  const selected = [];
  while (remaining.length && selected.length < limit) {
    const scores = remaining.map(candidate => candidate.score - selected.reduce((overlap, chosen) => Math.max(
      overlap,
      jaccard(candidate.node.text, chosen.node.text),
      candidate.node.slotKey === chosen.node.slotKey ? 0.88 : 0,
    ), 0) * 1.18);
    const best = Math.max(...scores);
    const [choice] = remaining.splice(scores.indexOf(best), 1);
    selected.push({ ...choice, score: Number(choice.score.toFixed(3)), diversifiedScore: Number(best.toFixed(3)) });
  }
  return selected;
}

test('cached diversity selection preserves rankings and audit scores across ties and repeated claims', () => {
  const texts = ['', 'the and a', 'Printer garage calibration', 'Printer studio calibration', 'Printer garage calibration', 'Kitchen lights warm white', 'Office lights cool white'];
  const candidates = Array.from({ length: 90 }, (_, id) => ({
    node: { id, text: texts[id % texts.length], slotKey: `slot-${id % 9}` },
    score: (id % 11) / 7,
    reasons: [],
  }));
  const before = structuredClone(candidates);
  for (const limit of [1, 8, 30, 50, 100]) {
    assert.deepEqual(diversifyCandidates(candidates.values(), limit), referenceSelection(candidates, limit));
  }
  assert.deepEqual(candidates, before);
  assert.deepEqual(diversifyCandidates([], 8), []);
});
