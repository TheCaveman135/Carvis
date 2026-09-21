import test from 'node:test';
import assert from 'node:assert/strict';

import { GlassesDisplay, normalizeReport } from '../server/glasses-display.js';

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function report(overrides = {}) {
  return {
    clientId: 'g2-install-a',
    clientKind: 'g2',
    sessionId: 'g2-session-a',
    sessionStartedAt: 800,
    seq: 1,
    active: true,
    renderedAt: 900,
    mode: 'grid',
    status: '◉ Carvis',
    body: '',
    hudRevision: 7,
    slots: [
      {
        slot: 1,
        kind: 'camera',
        title: 'Living Room',
        value: 'frame displayed',
        entityId: 'camera.living_room',
        imageRevision: 123,
        frameBase64: ONE_PIXEL_PNG,
      },
      null,
      null,
      null,
    ],
    ...overrides,
  };
}

test('no intended HUD is presented as actual before a G2 reports', () => {
  const display = new GlassesDisplay();
  assert.deepEqual(display.state(), {
    connection: 'never',
    connected: false,
    active: false,
    lastSeen: null,
    ageMs: null,
    staleAfterMs: 35_000,
    display: null,
  });
});

test('a bridge-confirmed camera report exposes its exact PNG without putting bytes in state', () => {
  let now = 1_000;
  const display = new GlassesDisplay({ now: () => now });
  const result = display.report(report());

  assert.equal(result.accepted, true);
  assert.equal(result.state.connection, 'live');
  const slot = result.state.display.slots[0];
  assert.equal(slot.imageRevision, 123);
  assert.ok(slot.frameId);
  assert.equal('frameBase64' in slot, false);
  assert.deepEqual(display.frame(slot.frameId).bytes, Buffer.from(ONE_PIXEL_PNG, 'base64'));

  now += 35_001;
  assert.equal(display.state().connection, 'stale');
});

test('an older report can refresh liveness but cannot roll the actual screen backward', () => {
  let now = 10_000;
  const display = new GlassesDisplay({ now: () => now });
  display.report(report({ seq: 2, mode: 'confirmation', body: 'Accept this?', slots: [null, null, null, null] }));

  now += 1_000;
  const replay = display.report(report({ seq: 1, mode: 'grid' }));
  assert.equal(replay.accepted, false);
  assert.equal(replay.state.lastSeen, now);
  assert.equal(replay.state.display.seq, 2);
  assert.equal(replay.state.display.mode, 'confirmation');
  assert.equal(replay.state.display.body, 'Accept this?');
});

test('a new app session from the same G2 can start at sequence one and explicit backgrounding is inactive', () => {
  const display = new GlassesDisplay();
  display.report(report({ seq: 9 }));
  const next = display.report(
    report({
      sessionId: 'g2-session-b',
      sessionStartedAt: 901,
      seq: 1,
      active: false,
      mode: 'log',
      body: 'Nothing yet.',
      slots: [null, null, null, null],
    }),
  );

  assert.equal(next.accepted, true);
  assert.equal(next.state.connection, 'inactive');
  assert.equal(next.state.display.sessionId, 'g2-session-b');
  assert.equal(next.state.display.mode, 'log');
});

test('an older session or concurrent simulator cannot overwrite a live physical G2 mirror', () => {
  let now = 1_000;
  const display = new GlassesDisplay({ now: () => now });
  display.report(report({ seq: 4, mode: 'grid' }));

  const oldSameInstall = display.report(
    report({ sessionId: 'g2-session-old', sessionStartedAt: 700, seq: 99, mode: 'log', body: 'old', slots: [null, null, null, null] }),
  );
  assert.equal(oldSameInstall.accepted, false);
  assert.equal(oldSameInstall.state.display.sessionId, 'g2-session-a');

  const simulator = display.report(
    report({ clientId: 'sim-install', clientKind: 'simulator', sessionId: 'sim-session', sessionStartedAt: 1_001, seq: 1, mode: 'confirmation', body: 'sim', slots: [null, null, null, null] }),
  );
  assert.equal(simulator.accepted, false);
  assert.equal(simulator.state.display.clientKind, 'g2');

  const newG2 = display.report(
    report({ clientId: 'g2-install-b', clientKind: 'g2', sessionId: 'g2-session-b', sessionStartedAt: 1_002, seq: 1, mode: 'idle', body: '.', slots: [null, null, null, null] }),
  );
  assert.equal(newG2.accepted, false);

  now += 35_001;
  const afterStale = display.report(
    report({ clientId: 'g2-install-b', clientKind: 'g2', sessionId: 'g2-session-b', sessionStartedAt: 1_002, seq: 1, mode: 'idle', body: '.', slots: [null, null, null, null] }),
  );
  assert.equal(afterStale.accepted, true);
  assert.equal(afterStale.state.display.clientId, 'g2-install-b');
});

test('display reports are strictly bounded and require exactly four ordered slots', () => {
  assert.throws(() => normalizeReport(report({ slots: [] })), /exactly four slots/);
  assert.throws(
    () => normalizeReport(report({ slots: [null, { slot: 4, kind: 'text', title: '', value: '' }, null, null] })),
    /out of order/,
  );
  assert.throws(() => normalizeReport(report({ mode: 'wishful-thinking' })), /unsupported display mode/);
});

test('a one-dot idle page is a valid bridge-confirmed display state', () => {
  const normalized = normalizeReport(
    report({ mode: 'idle', status: '', body: '.', hudRevision: 0, slots: [null, null, null, null] }),
  );
  assert.equal(normalized.mode, 'idle');
  assert.equal(normalized.body, '.');
});

test('a blank idle report stays blank and indicator state survives grid reports', () => {
  const report = {sessionId:'indicator-session',seq:1,mode:'idle',body:'',status:'',slots:[null,null,null,null]};
  assert.equal(normalizeReport(report).indicator,false);
  assert.equal(normalizeReport({...report,body:'.'}).indicator,true);
  assert.equal(normalizeReport({...report,mode:'grid',indicator:true}).indicator,true);
  assert.equal(normalizeReport({...report,body:'.',indicator:false}).indicator,false);
});
