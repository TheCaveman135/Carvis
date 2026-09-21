import test from 'node:test';
import assert from 'node:assert/strict';

import { isExpired, nextDeadline } from '../server/hud.js';

/**
 * These cover the pure half of HUD lifetimes only. `Hud` itself writes to
 * db.js, which hardcodes the owner's real database path with no override, so
 * constructing one here would mutate live state.
 */

test('expiry is passing the deadline, not reaching it', () => {
  const at = 1_000_000;

  // Strict `>`: the glasses run the same comparison against the same field,
  // and disagreeing by one millisecond blanks a widget on the lenses while the
  // server still reports it live.
  assert.equal(isExpired({ expires_at: at }, at - 1), false);
  assert.equal(isExpired({ expires_at: at }, at), false);
  assert.equal(isExpired({ expires_at: at }, at + 1), true);
});

test('something with no deadline never expires', () => {
  assert.equal(isExpired({ expires_at: null }, Date.now()), false);
  assert.equal(isExpired({}, Date.now()), false);
  assert.equal(isExpired(null, Date.now()), false);
});

test('overlays expire on `until`, widgets on `expires_at`', () => {
  assert.equal(isExpired({ until: 500 }, 501), true);
  assert.equal(isExpired({ until: 500 }, 499), false);
});

test('the next deadline is the soonest across slots, overlay and reply line', () => {
  const slots = new Map([
    [1, { expires_at: 900 }],
    [2, { expires_at: null }],
    [3, { expires_at: 300 }],
  ]);

  assert.equal(nextDeadline(slots), 300);
  // The reply line is the shortest-lived channel on the display, so it has to
  // be able to win — this is the argument the timer would otherwise miss.
  assert.equal(nextDeadline(slots, { until: 200 }), 200);
  assert.equal(nextDeadline(slots, { until: 200 }, { until: 50 }), 50);
  assert.equal(nextDeadline(slots, null, { until: 50 }), 50);
});

test('nothing on a clock means no timer to arm', () => {
  assert.equal(nextDeadline(new Map()), null);
  assert.equal(nextDeadline(new Map([[1, { expires_at: null }]])), null);
  assert.equal(nextDeadline(new Map(), null, null), null);
});

test('a plain array of slots works as well as the live Map', () => {
  // hud.state() hands out an array with nulls for empty slots; the timer must
  // tolerate that shape rather than only the internal Map.
  assert.equal(nextDeadline([null, { expires_at: 700 }, null, { expires_at: 400 }]), 400);
  assert.equal(nextDeadline([null, null, null, null]), null);
});

test('media binding follows track changes, labels pause, and clears stale tracks when idle', async () => {
 const {BINDINGS}=await import('../server/hud.js');const id='media_player.spotify';
 const state={state:'playing',attributes:{media_title:'First',media_artist:'Artist'}};
 const context={ha:{states:new Map([[id,state]]),friendlyName:()=> 'Spotify'}};
 const read=()=>BINDINGS.device_state.resolve(context,{entity_id:id});
 assert.equal(read().value,'First — Artist');state.attributes.media_title='Second';assert.equal(read().value,'Second — Artist');
 state.state='paused';assert.equal(read().value,'Paused: Second — Artist');state.state='idle';assert.equal(read().value,'idle');
});
