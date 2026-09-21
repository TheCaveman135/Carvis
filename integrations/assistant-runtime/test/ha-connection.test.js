import test from 'node:test';
import assert from 'node:assert/strict';
import { HAClient } from '../server/ha.js';

class Socket extends EventTarget {
  static instances = [];
  constructor() { super(); this.readyState = 1; this.sent = []; Socket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  reply(request, result = []) { this.message({ type: 'result', id: request.id, success: true, result }); }
}
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(t) {
  Socket.instances = [];
  t.mock.method(globalThis, 'WebSocket', function () { return new Socket(); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ha = new HAClient();
  ha.configure('http://ha.test', 'test-token');
  t.after(() => ha.disconnect());
  return ha;
}

test('a failed HA bootstrap reconnects and successfully restores state and subscriptions', async (t) => {
  const ha = setup(t);
  const first = ha.ws;
  first.message({ type: 'auth_ok' });
  first.message({ type: 'result', id: first.sent[0].id, success: false, error: { message: 'temporarily unavailable' } });
  await drain();
  assert.equal(first.readyState, 3);
  t.mock.timers.tick(2000);
  const next = ha.ws;
  assert.notEqual(next, first);
  next.message({ type: 'auth_ok' });
  next.reply(next.sent[0], [{ entity_id: 'light.test', state: 'off' }]);
  await drain();
  for (const request of next.sent.filter((r) => r.type.startsWith('config/'))) next.reply(request);
  await drain();
  for (const request of next.sent.filter((r) => r.type === 'subscribe_events')) next.reply(request);
  await drain();
  assert.equal(ha.status, 'connected');
  assert.equal(ha.states.get('light.test').state, 'off');
  assert.equal(next.sent.filter((r) => r.type === 'subscribe_events').length, 4);
  assert.equal(ha.pending.size, 0);
});

test('late messages and bootstrap failure from an old HA socket cannot poison its replacement', async (t) => {
  const ha = setup(t);
  const old = ha.ws;
  old.message({ type: 'auth_ok' });
  ha.reconnect();
  const next = ha.ws;
  old.message({ type: 'auth_invalid' });
  old.message({ type: 'event', event: { event_type: 'state_changed', data: { entity_id: 'light.old', new_state: { state: 'on' } } } });
  await drain();
  assert.equal(ha.ws, next);
  assert.equal(ha.status, 'connecting');
  assert.equal(ha.closedByUs, false);
  assert.equal(ha.states.has('light.old'), false);
});

test('HA send failure cleans pending requests immediately', async (t) => {
  const ha = setup(t);
  ha.ws.send = () => { throw new Error('transport failed'); };
  await assert.rejects(ha.send({ type: 'ping' }), /transport failed/);
  assert.equal(ha.pending.size, 0);
});

test('equivalent HA URLs do not interrupt a working connection', (t) => {
  const ha = setup(t);
  const ws = ha.ws;
  ha.configure('http://ha.test/', 'test-token');
  assert.equal(ha.ws, ws);
});

test('invalid HA authentication still waits for configuration instead of retrying', async (t) => {
  const ha = setup(t);
  ha.ws.message({ type: 'auth_invalid' });
  t.mock.timers.tick(120000);
  await drain();
  assert.equal(Socket.instances.length, 1);
  assert.equal(ha.status, 'error');
  assert.equal(ha.ws, null);
});

test('an unresponsive HA connection is detected and replaced after a missed pong', async (t) => {
  const ha = setup(t);
  const ws = ha.ws;
  ws.message({ type: 'auth_ok' });
  ws.reply(ws.sent[0]);
  await drain();
  for (const request of ws.sent.filter((r) => r.type.startsWith('config/'))) ws.reply(request);
  await drain();
  for (const request of ws.sent.filter((r) => r.type === 'subscribe_events')) ws.reply(request);
  await drain();
  assert.equal(ha.status, 'connected');
  t.mock.timers.tick(30000);
  assert.equal(ws.sent.at(-1).type, 'ping');
  ws.message({ type: 'pong', id: ws.sent.at(-1).id });
  await drain();
  assert.equal(ha.pending.size, 0);
  t.mock.timers.tick(30000);
  assert.equal(ha.pending.size, 1);
  t.mock.timers.tick(20000);
  await drain();
  assert.equal(ws.readyState, 3);
  assert.equal(ha.pending.size, 0);
  t.mock.timers.tick(2000);
  assert.notEqual(ha.ws, ws);
  assert.equal(ha.status, 'connecting');
});
