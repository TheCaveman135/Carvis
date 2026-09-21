/**
 * Browser login and device-token authentication.
 *
 * The G2 app keeps using its configured bearer token. Human WebUI sessions
 * use a signed HttpOnly cookie, so a phone on the tailnet needs an account
 * rather than inheriting trust merely by being able to reach Carvis.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'carvis_session';
const SESSION_DAYS = 30;
const HASH_BYTES = 64;

/**
 * Small in-memory brake around the deliberately expensive scrypt verifier.
 *
 * This is keyed by the socket peer rather than a user-supplied header. Carvis
 * is reached directly over the tailnet, so trusting X-Forwarded-For here would
 * let a caller rotate keys and defeat the limit. A restart clears the window;
 * that is acceptable because this protects one personal service from bursts,
 * rather than trying to be a distributed account lockout system.
 */
export class LoginAttemptLimiter {
  constructor({ maxFailures = 8, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
    this.maxFailures = Math.max(1, Math.trunc(maxFailures));
    this.windowMs = Math.max(1_000, Math.trunc(windowMs));
    this.now = now;
    this.failures = new Map();
  }

  check(key) {
    const id = String(key || 'unknown');
    const at = this.now();
    const recent = (this.failures.get(id) || []).filter((ts) => at - ts < this.windowMs);
    if (recent.length) this.failures.set(id, recent);
    else this.failures.delete(id);
    if (recent.length < this.maxFailures) return { ok: true, retryAfterSeconds: 0 };
    const retryAfterMs = Math.max(1, this.windowMs - (at - recent[0]));
    return { ok: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1_000) };
  }

  fail(key) {
    const id = String(key || 'unknown');
    const gate = this.check(id);
    const recent = this.failures.get(id) || [];
    recent.push(this.now());
    this.failures.set(id, recent.slice(-this.maxFailures));
    return gate;
  }

  succeed(key) {
    this.failures.delete(String(key || 'unknown'));
  }
}

export function hasAccount(config) {
  const auth = config?.auth || {};
  return Boolean(auth.username && auth.passwordHash && auth.sessionSecret);
}

/** Browser setup/login must come from the Carvis page itself, not an embedded cross-origin page. */
export function isSameOriginRequest(req) {
  if (internalRequest(req)) return true;
  const origin = String(req?.headers?.origin || '').trim();
  // Direct command-line setup is useful for recovery; browsers always include
  // Origin on these JSON POSTs, so an absent Origin is not a browser bypass.
  if (!origin) return true;
  const host = String(req?.headers?.host || '').trim();
  return Boolean(host) && (origin === `http://${host}` || origin === `https://${host}`);
}

export function validateAccountInput(username, password) {
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(user)) {
    return { ok: false, error: 'Username must be 3–64 letters, numbers, dots, dashes, or underscores.' };
  }
  if (pass.length < 12 || pass.length > 256) {
    return { ok: false, error: 'Password must be 12–256 characters.' };
  }
  return { ok: true, username: user, password: pass };
}

export function createAccount(username, password) {
  const checked = validateAccountInput(username, password);
  if (!checked.ok) throw new Error(checked.error);
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(checked.password, salt, HASH_BYTES).toString('base64url');
  return {
    username: checked.username,
    passwordHash: `scrypt:${salt}:${hash}`,
    sessionSecret: randomBytes(32).toString('base64url'),
  };
}

export function verifyPassword(config, username, password) {
  const auth = config?.auth || {};
  const userOk = safeEqual(String(username || '').trim(), String(auth.username || ''));
  const parts = String(auth.passwordHash || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'base64url');
  const actual = scryptSync(String(password || ''), parts[1], HASH_BYTES);
  return userOk && expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function issueSession(config) {
  if (!hasAccount(config)) throw new Error('Carvis has not been set up yet.');
  const payload = Buffer.from(JSON.stringify({
    user: config.auth.username,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
    nonce: randomBytes(12).toString('base64url'),
  })).toString('base64url');
  const signature = sign(payload, config.auth.sessionSecret);
  return `${payload}.${signature}`;
}

export function sessionUser(req, config) {
  if (!hasAccount(config)) return null;
  const token = parseCookies(req?.headers?.cookie || '')[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, config.auth.sessionSecret))) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!body || typeof body !== 'object' || Date.now() > Number(body.exp)) return null;
    return safeEqual(String(body.user || ''), String(config.auth.username || '')) ? config.auth.username : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token, { maxAge = SESSION_DAYS * 24 * 60 * 60 } = {}) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.max(0, Math.round(maxAge))}; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

function parseCookies(header) {
  const out = {};
  for (const piece of String(header).split(';')) {
    const index = piece.indexOf('=');
    if (index <= 0) continue;
    const key = piece.slice(0, index).trim();
    const value = piece.slice(index + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function sign(payload, secret) {
  return createHmac('sha256', String(secret || '')).update(payload).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenMatches(presented, expected) {
  return Boolean(presented && expected && safeEqual(presented, expected));
}

/** A G2 bearer token or a signed browser session is required after setup. */
export function isAuthorisedRequest(req, config) {
  if (internalRequest(req)) return true;
  const header = String(req?.headers?.authorization || '');
  const presented = header.replace(/^Bearer\s+/i, '').trim();
  return tokenMatches(presented, String(config?.glasses?.token || '')) || Boolean(sessionUser(req, config));
}

export function internalRequest(req) {
  const expected=process.env.CARVIS_RUNTIME_SECRET;
  const provided=req?.headers?.['x-carvis-internal'];
  return typeof expected==='string' && expected.length>=32 && typeof provided==='string' && safeEqual(provided,expected);
}
