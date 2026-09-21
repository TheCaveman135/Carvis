import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAccount,
  hasAccount,
  isAuthorisedRequest,
  isSameOriginRequest,
  issueSession,
  LoginAttemptLimiter,
  sessionUser,
  validateAccountInput,
  verifyPassword,
} from '../server/auth.js';

function request({ cookie = '', origin, authorization } = {}) {
  return {
    headers: {
      host: '192.0.2.20:8787',
      ...(cookie ? { cookie } : {}),
      ...(origin === undefined ? {} : { origin }),
      ...(authorization === undefined ? {} : { authorization }),
    },
  };
}

function config() {
  return {
    glasses: { token: 'g2-token' },
    auth: createAccount('owner', 'a properly long test password'),
  };
}

test('first-account input has a deliberate username and password floor', () => {
  assert.equal(validateAccountInput('ab', 'a properly long test password').ok, false);
  assert.equal(validateAccountInput('owner', 'short').ok, false);
  assert.deepEqual(validateAccountInput('example.user', 'a properly long test password').ok, true);
});

test('passwords are salted and verified without storing plaintext', () => {
  const account = createAccount('owner', 'a properly long test password');
  const cfg = { glasses: { token: 'g2-token' }, auth: account };
  assert.equal(hasAccount(cfg), true);
  assert.match(account.passwordHash, /^scrypt:/);
  assert.doesNotMatch(account.passwordHash, /properly long test password/);
  assert.equal(verifyPassword(cfg, 'owner', 'a properly long test password'), true);
  assert.equal(verifyPassword(cfg, 'owner', 'the wrong password is also long'), false);
  assert.equal(verifyPassword(cfg, 'not-owner', 'a properly long test password'), false);
});

test('a signed browser session authorizes only its configured account', () => {
  const cfg = config();
  const token = issueSession(cfg);
  const req = request({ cookie: `carvis_session=${token}` });
  assert.equal(sessionUser(req, cfg), 'owner');
  assert.equal(isAuthorisedRequest(req, cfg), true);
  assert.equal(isAuthorisedRequest(request(), cfg), false);
  assert.equal(isAuthorisedRequest(request({ authorization: 'Bearer g2-token' }), cfg), true);
  assert.equal(isAuthorisedRequest(request({ cookie: 'carvis_session=forged.token' }), cfg), false);
});

test('browser setup/login rejects a cross-origin page', () => {
  assert.equal(isSameOriginRequest(request({ origin: 'http://192.0.2.20:8787' })), true);
  assert.equal(isSameOriginRequest(request({ origin: 'https://evil.example' })), false);
});

test('login attempts are bounded per socket peer and success clears the window', () => {
  let now = 1_000;
  const limiter = new LoginAttemptLimiter({ maxFailures: 2, windowMs: 5_000, now: () => now });
  assert.equal(limiter.check('peer-a').ok, true);
  limiter.fail('peer-a');
  limiter.fail('peer-a');
  assert.deepEqual(limiter.check('peer-a'), { ok: false, retryAfterSeconds: 5 });
  assert.equal(limiter.check('peer-b').ok, true);
  limiter.succeed('peer-a');
  assert.equal(limiter.check('peer-a').ok, true);
  limiter.fail('peer-a');
  now += 5_001;
  assert.equal(limiter.check('peer-a').ok, true);
});
