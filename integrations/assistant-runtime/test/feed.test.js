import test from 'node:test';
import assert from 'node:assert/strict';
import { Feed } from '../server/feed.js';

test('a synchronous speech failure cannot hide a feed entry or strand a waiting display', async () => {
  const feed = new Feed(() => ({ glasses: { feedSize: 60 } }), {
    onEntry: () => { throw new Error('speaker offline'); },
  });
  const waiting = feed.wait(0);
  const entry = feed.push('reply', 'Your timer is finished.');
  assert.deepEqual(await waiting, [entry]);
  assert.deepEqual(feed.since(0), [entry]);
  assert.equal(feed.waiters.size, 0);
});

test('speech receives the whole reply while the wearable feed stays bounded', async () => {
  const text = 'A long useful answer. '.repeat(70).trim();
  let spoken;
  const feed = new Feed(() => ({ glasses: { feedSize: 60 } }), { onEntry: (entry) => {spoken=entry.text;} });
  const entry = feed.push('reply',text);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(spoken,text);
  assert.equal(entry.text.length,500);
  assert.equal(entry.fullText,text);
});
