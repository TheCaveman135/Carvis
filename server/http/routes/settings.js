import { body, fail, json, publicModel } from "../responses.js";
import { homeReady } from "../../home-setup.js";
import {
  publicGlobalKeys,
  updateGlobalKeys,
  resolvedMainModel,
} from "../../global-keys.js";
import { discoverModels } from "../../model-catalog.js";
import { integrationModels } from "../../integration-models.js";
import { endpoint, text } from "../../validation.js";

export async function settingsRoutes({
  req,
  res,
  path,
  user,
  store,
  registry,
  fetcher,
  version,
}) {
  if (path === "/api/state" && req.method === "GET") {
    const integrations = registry.list();
    return json(res, 200, {
      profile: store.config.profile,
      model: publicModel(resolvedMainModel(store.config)),
      apiKeys: publicGlobalKeys(store.config),
      integrations: integrations.filter((i) => !i.builtIn),
      homeAssistant: integrations.find((i) => i.builtIn) || null,
      homeSetupRequired:
        !!registry.modules.get("home-assistant")?.builtIn && !homeReady(store),
      conversations: store.data.conversations
        .map(({ messages, ...c }) => c)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      memory: store.data.memory,
      version,
    });
  }
  if (path === "/api/integration-models" && req.method === "POST") {
    if (!user) throw fail("Sign in to Carvis.", 401);
    return json(
      res,
      200,
      await integrationModels(await body(req), store, registry, fetcher),
    );
  }
  if (path === "/api/models" && req.method === "POST") {
    if (!user) throw fail("Sign in to Carvis.", 401);
    return json(
      res,
      200,
      await discoverModels(
        await body(req),
        resolvedMainModel(store.config),
        fetcher,
      ),
    );
  }
  if (path === "/api/settings" && req.method === "POST") {
    const b = await body(req),
      next = structuredClone(store.config);
    if (b.apiKeys) updateGlobalKeys(next, b.apiKeys);
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
          !["provider", "baseUrl", "model", "apiKey", "clearApiKey"].includes(
            key,
          )
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
      model: publicModel(resolvedMainModel(next)),
    });
  }
  return false;
}
