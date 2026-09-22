import { body, fail, json } from "../responses.js";
import { text } from "../../validation.js";
import {
  hasAccount,
  createAccount,
  verifyPassword,
  issueSession,
  sessionCookie,
} from "../../auth.js";

// These endpoints run before the owner-session gate, after origin validation.
export async function accountRoutes({
  req,
  res,
  path,
  store,
  limiter,
  allowRemoteSetup,
  secureCookies,
}) {
  if (path === "/api/setup" && req.method === "POST") {
    if (hasAccount(store.config))
      throw fail("This installation is already set up.", 409);
    if (
      !allowRemoteSetup &&
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      )
    )
      throw fail(
        "Complete first-time setup from this computer using localhost.",
        403,
      );
    const b = await body(req);
    if (hasAccount(store.config))
      throw fail("This installation is already set up.", 409);
    const displayName = text(b.displayName || "", 80);
    const account = createAccount(b.username, b.password);
    store.config.auth = account;
    store.config.profile.displayName = displayName;
    store.saveConfig();
    return json(
      res,
      200,
      { success: true },
      {
        "Set-Cookie": sessionCookie(issueSession(store.config), {
          secure: secureCookies || !!req.socket.encrypted,
        }),
      },
    );
  }
  if (path === "/api/login" && req.method === "POST") {
    const b = await body(req),
      ip = req.socket.remoteAddress,
      gate = limiter.check(ip);
    if (!gate.ok)
      return json(
        res,
        429,
        { error: "Too many attempts. Try again later." },
        { "Retry-After": String(gate.retryAfterSeconds) },
      );
    if (!verifyPassword(store.config, b.username, b.password)) {
      limiter.fail(ip);
      throw fail("Incorrect username or password.", 401);
    }
    limiter.succeed(ip);
    return json(
      res,
      200,
      { success: true },
      {
        "Set-Cookie": sessionCookie(issueSession(store.config), {
          secure: secureCookies || !!req.socket.encrypted,
        }),
      },
    );
  }
  return false;
}
