import {
  hasAccount,
  sessionUser,
  isSameOriginRequest,
  clearSessionCookie,
} from "../auth.js";
import { fail, json, sameSecret } from "./responses.js";
import { serveStatic } from "./static.js";
import { accountRoutes } from "./routes/account.js";
import { homeRoutes } from "./routes/home.js";
import { settingsRoutes } from "./routes/settings.js";
import { conversationRoutes } from "./routes/conversations.js";
import { memoryRoutes } from "./routes/memory.js";
import { integrationRoutes } from "./routes/integrations.js";

const authenticatedRoutes = [
  homeRoutes,
  settingsRoutes,
  conversationRoutes,
  memoryRoutes,
  integrationRoutes,
];

// All routes share the same host, origin, owner-session and scoped-device gates.
export function createRequestHandler(context) {
  const { store, registry, hosts, root, version } = context;
  return async (req, res) => {
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
      const deviceMethod = req.method === "OPTIONS"
        ? String(req.headers["access-control-request-method"] || "GET")
        : req.method;
      // Device clients need to read pairing/disabled errors too. CORS does not
      // authenticate them; the owner/session and token gates below still apply.
      const deviceEndpoint = devicePath || [...registry.modules.values()].some(
        module => module.deviceRoute?.(deviceMethod, path),
      );
      const rawModule = registry.rawModule(
        req.method === "OPTIONS"
          ? String(req.headers["access-control-request-method"] || "GET")
          : req.method,
        path,
      );
      const bearer = String(req.headers.authorization || "").replace(
        /^Bearer /i,
        "",
      );
      const glasses = store.config.integrations["even-realities"];
      const device =
        rawModule?.authorizeDevice?.(req, path) ||
        (devicePath &&
          glasses?.enabled &&
          sameSecret(bearer, glasses.config?.pairingToken));
      if (
        req.method === "OPTIONS" &&
        deviceEndpoint
      ) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": req.headers.origin || "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, X-Carvis-Core-Token",
          Vary: "Origin",
        });
        return res.end();
      }
      if (deviceEndpoint) {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
        res.setHeader("Vary", "Origin");
      }
      const user = sessionUser(req, store.config);
      if (path === "/api/bootstrap" && req.method === "GET")
        return json(res, 200, {
          setupRequired: !hasAccount(store.config),
          authenticated: !!user,
          user,
          version,
        });
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
        !device &&
        !isSameOriginRequest(req)
      )
        throw fail("Use the Carvis app to make this request.", 403);
      const request = { ...context, req, res, path, parsed, user, device };
      if (await accountRoutes(request)) return;
      if (path.startsWith("/api/") && !user && !device)
        throw fail("Sign in to Carvis.", 401);
      if (rawModule) {
        if (!user && !device) throw fail("Sign in to Carvis.", 401);
        req.carvisAuthenticatedAs = device ? "device" : "owner";
        return await rawModule.rawRoute(req, res, parsed);
      }
      if (path === "/api/logout" && req.method === "POST")
        return json(
          res,
          200,
          { success: true },
          { "Set-Cookie": clearSessionCookie() },
        );
      for (const route of authenticatedRoutes) {
        if (await route(request)) return;
      }
      if (path.startsWith("/api/")) throw fail("API route not found.", 404);
      await serveStatic(req, res, path, root);
    } catch (error) {
      if (!res.headersSent)
        json(res, error.status || 400, { error: error.message });
      else res.end();
    }
  };
}
