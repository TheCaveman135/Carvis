import http from "node:http";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeHome } from "./home-setup.js";
import homeAssistant from "./home-assistant.js";
import { Store } from "./store.js";
import { Registry } from "./registry.js";
import { Chat } from "./chat.js";
import { LoginAttemptLimiter } from "./auth.js";
import { createRequestHandler } from "./http/handler.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = "0.3.4";

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
    initializeHome(store);
    registry.register({
      ...homeAssistant,
      builtIn: true,
      fields: structuredClone(homeAssistant.fields),
    });
    for (const id of ["apple-tv", "even-realities"]) {
      const { default: module } = await import(`./integrations/${id}.js`);
      registry.register({ ...module, fields: structuredClone(module.fields) });
    }
    const { registerAssistantServices } = await import(
      "./integrations/assistant-services.js"
    );
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
  const server = http.createServer(
    createRequestHandler({
      store,
      registry,
      chat,
      limiter,
      hosts,
      root,
      fetcher,
      allowRemoteSetup,
      secureCookies,
      version: VERSION,
    }),
  );
  await registry.start();
  server.on("close", () => registry.close().catch(() => {}));
  return { server, store, registry, chat };
}
