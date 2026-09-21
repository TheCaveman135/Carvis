/**
 * Owner login and signed HttpOnly browser sessions.
 */
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const COOKIE_NAME = "carvis_session";
const SESSION_DAYS = 30;
const HASH_BYTES = 64;

/**
 * Small in-memory brake around the deliberately expensive scrypt verifier.
 *
 * Key by the socket peer, not a user-supplied forwarding header. A restart
 * clears the window. This limits bursts against a single-owner installation.
 */
export class LoginAttemptLimiter {
  constructor({
    maxFailures = 8,
    windowMs = 15 * 60_000,
    now = () => Date.now(),
  } = {}) {
    this.maxFailures = Math.max(1, Math.trunc(maxFailures));
    this.windowMs = Math.max(1_000, Math.trunc(windowMs));
    this.now = now;
    this.failures = new Map();
  }

  check(key) {
    const id = String(key || "unknown");
    const at = this.now();
    const recent = (this.failures.get(id) || []).filter(
      (ts) => at - ts < this.windowMs,
    );
    if (recent.length) this.failures.set(id, recent);
    else this.failures.delete(id);
    if (recent.length < this.maxFailures)
      return { ok: true, retryAfterSeconds: 0 };
    const retryAfterMs = Math.max(1, this.windowMs - (at - recent[0]));
    return { ok: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1_000) };
  }

  fail(key) {
    const id = String(key || "unknown");
    const gate = this.check(id);
    const recent = this.failures.get(id) || [];
    recent.push(this.now());
    this.failures.set(id, recent.slice(-this.maxFailures));
    return gate;
  }

  succeed(key) {
    this.failures.delete(String(key || "unknown"));
  }
}

export function hasAccount(config) {
  const auth = config?.auth || {};
  return Boolean(auth.username && auth.passwordHash && auth.sessionSecret);
}

/** Browser setup/login must come from the Carvis page itself, not an embedded cross-origin page. */
export function isSameOriginRequest(req) {
  const origin = String(req?.headers?.origin || "").trim();
  // Direct command-line setup is useful for recovery; browsers always include
  // Origin on these JSON POSTs, so an absent Origin is not a browser bypass.
  if (!origin) return true;
  const host = String(req?.headers?.host || "").trim();
  return (
    Boolean(host) &&
    (origin === `http://${host}` || origin === `https://${host}`)
  );
}

export function validateAccountInput(username, password) {
  const user = String(username || "").trim();
  const pass = String(password || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(user)) {
    return {
      ok: false,
      error:
        "Username must be 3–64 letters, numbers, dots, dashes, or underscores.",
    };
  }
  if (pass.length < 12 || pass.length > 256) {
    return { ok: false, error: "Password must be 12–256 characters." };
  }
  return { ok: true, username: user, password: pass };
}

export function createAccount(username, password) {
  const checked = validateAccountInput(username, password);
  if (!checked.ok) throw new Error(checked.error);
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(checked.password, salt, HASH_BYTES).toString(
    "base64url",
  );
  return {
    username: checked.username,
    passwordHash: `scrypt:${salt}:${hash}`,
    sessionSecret: randomBytes(32).toString("base64url"),
  };
}

export function verifyPassword(config, username, password) {
  const auth = config?.auth || {};
  const userOk = safeEqual(
    String(username || "").trim(),
    String(auth.username || ""),
  );
  const parts = String(auth.passwordHash || "").split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2], "base64url");
  if (typeof password !== "string" || password.length > 256) return false;
  const actual = scryptSync(password, parts[1], HASH_BYTES);
  return (
    userOk &&
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

export function issueSession(config) {
  if (!hasAccount(config)) throw new Error("Carvis has not been set up yet.");
  const payload = Buffer.from(
    JSON.stringify({
      user: config.auth.username,
      exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
      nonce: randomBytes(12).toString("base64url"),
    }),
  ).toString("base64url");
  const signature = sign(payload, config.auth.sessionSecret);
  return `${payload}.${signature}`;
}

export function sessionUser(req, config) {
  if (!hasAccount(config)) return null;
  const token = parseCookies(req?.headers?.cookie || "")[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    !safeEqual(signature, sign(payload, config.auth.sessionSecret))
  )
    return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!body || typeof body !== "object" || Date.now() > Number(body.exp))
      return null;
    return safeEqual(
      String(body.user || ""),
      String(config.auth.username || ""),
    )
      ? config.auth.username
      : null;
  } catch {
    return null;
  }
}

export function sessionCookie(
  token,
  { maxAge = SESSION_DAYS * 24 * 60 * 60, secure = false } = {},
) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.max(0, Math.round(maxAge))}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

function parseCookies(header) {
  const out = {};
  for (const piece of String(header).split(";")) {
    const index = piece.indexOf("=");
    if (index <= 0) continue;
    const key = piece.slice(0, index).trim();
    const value = piece.slice(index + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function sign(payload, secret) {
  return createHmac("sha256", String(secret || ""))
    .update(payload)
    .digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
