import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, join, extname, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import { Registry } from "./registry.js";
import { Chat } from "./chat.js";
import { endpoint, text } from "./validation.js";
import {
  hasAccount,
  createAccount,
  verifyPassword,
  issueSession,
  sessionCookie,
  clearSessionCookie,
  sessionUser,
  isSameOriginRequest,
  LoginAttemptLimiter,
} from "./auth.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.3.0";
function fail(message, status = 400) {
  return Object.assign(Error(message), { status });
}
async function body(req, limit = 128000) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json"))
    throw fail("Send JSON content.", 415);
  let count = 0;
  const parts = [];
  for await (const part of req) {
    count += part.length;
    if (count > limit) throw fail("Request is too large.", 413);
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw fail("Invalid JSON request.");
  }
}
function sameSecret(a, b) {
  const aa = Buffer.from(a || ""),
    bb = Buffer.from(b || "");
  return !!aa.length && aa.length === bb.length && timingSafeEqual(aa, bb);
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}
function publicModel(m) {
  return {
    provider: m.provider,
    baseUrl: m.baseUrl,
    model: m.model,
    hasApiKey: !!m.apiKey,
  };
}
export async function createApp({
  dataDirectory = process.env.CARVIS_DATA_DIR || join(root, ".carvis"),
  modules,
  fetcher = fetch,
  round,
  allowedHosts,
  allowRemoteSetup = false,
  secureCookies = process.env.CARVIS_SECURE_COOKIES === "1",
} = {}) {
  const store = new Store(dataDirectory),
    registry = new Registry(store, { fetch: fetcher });
  if (modules) {
    for (const module of modules) registry.register(module);
  } else {
    for (const id of ["home-assistant", "apple-tv", "even-realities"]) {
      const { default: module } = await import(`./integrations/${id}.js`);
      registry.register({ ...module, fields: structuredClone(module.fields) });
    }
    const { registerAssistantServices } = await import('./integrations/assistant-services.js');
    registerAssistantServices(registry);
    await registry.load(
      process.env.CARVIS_INTEGRATIONS_DIR ||
        join(dataDirectory, "integrations"),
    );
  }
  const chat = new Chat(store, registry, { round });
  registry.chat = (request) => chat.send({ ...request, source: "device" });
  const limiter = new LoginAttemptLimiter();
  const hosts = new Set(
    allowedHosts || [
      "localhost",
      "127.0.0.1",
      "[::1]",
      ...(process.env.CARVIS_ALLOWED_HOSTS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ],
  );
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    let path = "";
    try {
      const parsed = new URL(req.url, "http://localhost");
      path = parsed.pathname;
      const host = new URL(`http://${req.headers.host || "invalid"}`).hostname;
      if (!hosts.has(host))
        throw fail(
          "Host not allowed. Configure CARVIS_ALLOWED_HOSTS for this address.",
          403,
        );
      const devicePath = path.startsWith("/api/integrations/even-realities/");
      const rawModule = registry.rawModule(req.method === 'OPTIONS' ? String(req.headers['access-control-request-method'] || 'GET') : req.method, path);
      const bearer = String(req.headers.authorization || "").replace(
        /^Bearer /i,
        "",
      );
      const glasses = store.config.integrations["even-realities"];
      const device = rawModule?.authorizeDevice?.(req, path) ||
        devicePath &&
        glasses?.enabled &&
        sameSecret(bearer, glasses.config?.pairingToken);
      if (req.method === "OPTIONS" && (devicePath || rawModule?.deviceRoute?.(String(req.headers['access-control-request-method'] || 'GET'), path))) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": req.headers.origin || "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Carvis-Core-Token",
          Vary: "Origin",
        });
        return res.end();
      }
      if (device) {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
        res.setHeader("Vary", "Origin");
      }
      const user = sessionUser(req, store.config);
      if (path === "/api/bootstrap" && req.method === "GET")
        return json(res, 200, {
          setupRequired: !hasAccount(store.config),
          authenticated: !!user,
          user,
          version: VERSION,
        });
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
        !device &&
        !isSameOriginRequest(req)
      )
        throw fail("Use the Carvis app to make this request.", 403);
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
      if (path.startsWith("/api/") && !user && !device)
        throw fail("Sign in to Carvis.", 401);
      if (rawModule) {
        if (!user && !device) throw fail('Sign in to Carvis.', 401);
        req.carvisAuthenticatedAs = device ? 'device' : 'owner';
        return await rawModule.rawRoute(req, res, parsed);
      }
      if (path === "/api/logout" && req.method === "POST")
        return json(
          res,
          200,
          { success: true },
          { "Set-Cookie": clearSessionCookie() },
        );
      if (path === "/api/state" && req.method === "GET")
        return json(res, 200, {
          profile: store.config.profile,
          model: publicModel(store.config.model),
          integrations: registry.list(),
          conversations: store.data.conversations
            .map(({ messages, ...c }) => c)
            .sort((a, b) => b.updatedAt - a.updatedAt),
          memory: store.data.memory,
          version: VERSION,
        });
      if (path === "/api/settings" && req.method === "POST") {
        const b = await body(req),
          next = structuredClone(store.config);
        if (b.profile) {
          for (const key of Object.keys(b.profile))
            if (!["displayName", "assistantName", "personality"].includes(key))
              throw fail("Unsupported profile setting.");
          for (const [key, value] of Object.entries(b.profile))
            next.profile[key] = text(value, key === "personality" ? 2000 : 80);
        }
        if (b.model) {
          for (const key of Object.keys(b.model))
            if (
              ![
                "provider",
                "baseUrl",
                "model",
                "apiKey",
                "clearApiKey",
              ].includes(key)
            )
              throw fail("Unsupported model setting.");
          if (
            b.model.provider &&
            !["openai", "compatible", "ollama"].includes(b.model.provider)
          )
            throw fail("Unknown model provider.");
          const old = next.model;
          next.model = {
            ...old,
            ...b.model,
            apiKey: b.model.clearApiKey ? "" : b.model.apiKey || old.apiKey,
          };
          delete next.model.clearApiKey;
          next.model.baseUrl = endpoint(next.model.baseUrl);
          if (
            (next.model.provider !== old.provider ||
              next.model.baseUrl !== endpoint(old.baseUrl)) &&
            !b.model.apiKey
          )
            next.model.apiKey = "";
          next.model.model = text(next.model.model, 120);
          next.model.apiKey = text(next.model.apiKey, 1000);
        }
        store.config = next;
        store.saveConfig();
        await registry.configurationChanged();
        return json(res, 200, {
          success: true,
          profile: next.profile,
          model: publicModel(next.model),
        });
      }
      if (path === "/api/conversations" && req.method === "POST") {
        await body(req);
        return json(res, 201, store.createConversation());
      }
      const conversationMatch =
        /^\/api\/conversations\/([\w-]+)(\/messages)?$/.exec(path);
      if (conversationMatch) {
        const id = conversationMatch[1];
        if (!conversationMatch[2]) {
          const c = store.conversation(id);
          if (req.method === "GET") return json(res, 200, c);
          if (chat.busy.has(id))
            throw fail("Wait for this reply to finish.", 409);
          if (req.method === "PATCH") {
            const b = await body(req);
            c.title = text(b.title, 120) || "Untitled conversation";
            store.saveData();
            return json(res, 200, c);
          }
          if (req.method === "DELETE") {
            store.data.conversations = store.data.conversations.filter(
              (c) => c.id !== id,
            );
            store.saveData();
            return json(res, 200, { success: true });
          }
        }
        if (conversationMatch[2] && req.method === "POST") {
          const b = await body(req);
          store.conversation(id);
          const controller = new AbortController();
          res.on("close", () => controller.abort());
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders();
          const emit = (event, data) => {
            if (!res.destroyed)
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write(": keepalive\n\n");
          }, 15000);
          heartbeat.unref();
          try {
            await chat.send({
              text: b.text,
              conversationId: id,
              emit,
              signal: controller.signal,
            });
          } catch (error) {
            emit("error", {
              error: controller.signal.aborted
                ? "Response stopped."
                : error.message,
            });
          } finally {
            clearInterval(heartbeat);
            res.end();
          }
          return;
        }
      }
      const confirmationMatch = /^\/api\/confirmations\/([\w-]+)$/.exec(path);
      if (confirmationMatch && req.method === "POST") {
        const b = await body(req);
        if (typeof b.accepted !== "boolean")
          throw fail("Choose accept or decline.");
        const result = await registry.confirm(
          confirmationMatch[1],
          b.accepted,
          { source: "chat" },
        );
        return json(res, 200, { success: result?.success !== false, result });
      }
      if (path === "/api/memory" && req.method === "POST") {
        const b = await body(req),
          value = text(b.text, 2000);
        if (!value) throw fail("Write something to remember.");
        if (store.data.memory.length >= 100)
          throw fail("Memory is full. Remove an old entry first.");
        const memory = { id: randomUUID(), text: value, createdAt: Date.now() };
        store.data.memory.push(memory);
        store.saveData();
        return json(res, 201, memory);
      }
      const memoryMatch = /^\/api\/memory\/([\w-]+)$/.exec(path);
      if (memoryMatch && req.method === "DELETE") {
        store.data.memory = store.data.memory.filter(
          (m) => m.id !== memoryMatch[1],
        );
        store.saveData();
        return json(res, 200, { success: true });
      }
      const integrationMatch =
        /^\/api\/integrations\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(path);
      if (integrationMatch) {
        const [, id, suffix = ""] = integrationMatch;
        if (!registry.modules.has(id))
          throw fail("Integration not found.", 404);
        if (device && ["", "/generate-secret", "/test"].includes(suffix))
          throw fail("Sign in to configure integrations.", 403);
        if (!suffix && req.method === "PUT")
          return json(res, 200, await registry.configure(id, await body(req)));
        if (suffix === "/test" && req.method === "POST")
          return json(res, 200, await registry.test(id));
        if (suffix === "/generate-secret" && req.method === "POST") {
          const b = await body(req);
          if (id !== "even-realities" || b.key !== "pairingToken")
            throw fail("Cannot generate this setting.");
          const value = randomBytes(32).toString("base64url");
          await registry.configure(id, { config: { pairingToken: value } });
          return json(res, 200, { value });
        }
        const request = {
          method: req.method,
          path: suffix,
          url: parsed,
          body: ["POST", "PUT", "PATCH"].includes(req.method)
            ? await body(
                req,
                id === "even-realities" && suffix === "/audio"
                  ? 1_600_000
                  : 128000,
              )
            : {},
          authenticatedAs: device ? "device" : "owner",
        };
        // Entity picker is owner-only and available before enabling HA.
        const result =
          id === "home-assistant" && suffix === "/entities" && !device
            ? await registry.modules
                .get(id)
                .route(request, registry.contextForTest(id))
            : await registry.route(id, request);
        if (result !== null && result !== undefined)
          return json(res, 200, result);
      }
      if (path.startsWith("/api/")) throw fail("API route not found.", 404);
      if (req.method !== "GET" && req.method !== "HEAD")
        throw fail("Method not allowed.", 405);
      const file =
        path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
      const target = resolve(root, "web", file);
      if (!target.startsWith(join(root, "web") + "/"))
        throw fail("Not found.", 404);
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) throw fail("Not found.", 404);
      const contentType =
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        }[extname(target)] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      });
      res.end(req.method === "HEAD" ? undefined : await readFile(target));
    } catch (error) {
      if (!res.headersSent)
        json(res, error.status || 400, { error: error.message });
      else res.end();
    }
  });
  await registry.start();
  server.on('close', () => registry.close().catch(() => {}));
  return { server, store, registry, chat };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { server, registry } = await createApp();
  const port = Number(process.env.PORT || 8788),
    host = process.env.HOST || "127.0.0.1";
  const addresses = [...new Set((process.env.CARVIS_LISTEN_HOSTS || host).split(',').map(value => value.trim()).filter(Boolean))];
  let shuttingDown = false;
  const retryTimers = new Set();
  const servers = addresses.map((address, index) => {
    const listener = index ? http.createServer(server.listeners('request')[0]) : server;
    const listen = () => {
      if (!shuttingDown) listener.listen(port, address);
    };
    listener.on('listening', () => console.log(`Carvis ${VERSION} is ready at http://${address}:${port}`));
    listener.on('error', error => {
      if (error.code === 'EADDRNOTAVAIL' && !shuttingDown) {
        // A configured VPN interface can appear after the service starts.
        // Keep available interfaces serving while waiting for that address.
        const timer = setTimeout(() => { retryTimers.delete(timer); listen(); }, 5000);
        retryTimers.add(timer);
        return;
      }
      console.error(`Carvis could not listen on ${address}:${port}: ${error.message}`);
      process.exitCode = 1;
      process.emit('SIGTERM');
    });
    listen();
    return listener;
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const timer of retryTimers) clearTimeout(timer);
      const timeout = setTimeout(() => process.exit(0), 5000); timeout.unref();
      await registry.close();
      await Promise.all(servers.map(listener => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); })));
      process.exit(process.exitCode || 0);
    });
}
