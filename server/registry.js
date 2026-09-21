import { randomUUID, createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validate } from "./validation.js";

export class Registry {
  constructor(store, { fetch: fetcher = fetch, chat } = {}) {
    this.store = store;
    this.fetch = fetcher;
    this.chat = chat;
    this.modules = new Map();
    this.pending = new Map();
    this.health = new Map();
  }
  register(module) {
    if (
      !/^[a-z][a-z0-9-]{1,63}$/.test(module.id) ||
      this.modules.has(module.id)
    )
      throw Error("Invalid or duplicate integration ID.");
    this.modules.set(module.id, module);
  }
  async load(directory) {
    let items;
    try {
      items = await readdir(directory, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const mod = await import(
        pathToFileURL(join(directory, item.name, "server.js")).href
      );
      this.register(mod.default);
    }
  }
  getConfig(id) {
    if (!this.store.config.integrations[id]?.enabled)
      throw Error(`${id} is not enabled.`);
    return structuredClone(this.store.config.integrations[id].config || {});
  }
  contextFor(id, { signal } = {}) {
    return {
      config: this.getConfig(id),
      fetch: this.fetch,
      registry: this,
      store: this.store.plugin(id),
      chat: this.chat,
      signal,
      enabled: true,
    };
  }
  safeConfig(id) {
    const entry = this.store.config.integrations[id] || {},
      cfg = { ...entry.config };
    for (const f of this.modules.get(id).fields || [])
      if (f.type === "password") {
        cfg[`has${f.key[0].toUpperCase() + f.key.slice(1)}`] = !!cfg[f.key];
        delete cfg[f.key];
      }
    return cfg;
  }
  list() {
    return [...this.modules.values()].map((m) => {
      const entry = this.store.config.integrations[m.id] || {};
      const configured =
        !!entry.config &&
        (m.fields || [])
          .filter((f) => f.required)
          .every(
            (f) =>
              entry.config?.[f.key] !== undefined &&
              entry.config[f.key] !== "" &&
              (!Array.isArray(entry.config[f.key]) ||
                entry.config[f.key].length > 0),
          );
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        version: m.version,
        icon: m.icon,
        permissions: m.permissions || [],
        fields: m.fields || [],
        enabled: !!entry.enabled,
        configured,
        status:
          this.health.get(m.id) ||
          (!entry.enabled ? "disabled" : configured ? "ready" : "needs setup"),
        config: this.safeConfig(m.id),
      };
    });
  }
  async configure(id, patch) {
    const m = this.modules.get(id);
    if (!m) throw Error("Integration not found.");
    const old = this.store.config.integrations[id] || {
      enabled: false,
      config: {},
    };
    let next = { ...old.config };
    if (patch.config) {
      if (typeof patch.config !== "object" || Array.isArray(patch.config))
        throw Error("Invalid settings.");
      for (const [key, value] of Object.entries(patch.config)) {
        const f = m.fields.find((f) => f.key === key);
        if (!f) throw Error(`Unknown setting: ${key}`);
        if (f.type === "password" && value === "") continue;
        next[key] = value;
      }
    }
    const enabled = patch.enabled ?? old.enabled;
    if (typeof enabled !== "boolean")
      throw Error("Enabled must be true or false.");
    if (enabled) next = await m.validateConfig(next);
    this.store.config.integrations[id] = { enabled, config: next };
    this.store.saveConfig();
    this.health.delete(id);
    for (const [key, p] of this.pending)
      if (p.integrationId === id) {
        this.pending.delete(key);
        await this.recordConfirmation(p, "cancelled", {
          success: false,
          error:
            "Integration settings changed before confirmation; the action was not executed.",
        });
      }
    return this.list().find((i) => i.id === id);
  }
  async test(id) {
    const m = this.modules.get(id);
    if (!m) throw Error("Integration not found.");
    const cfg = this.store.config.integrations[id]?.config || {};
    const config = await m.validateConfig(cfg);
    const result = await m.test({ ...this.contextForTest(id), config });
    this.health.set(id, result.success ? "connected" : "error");
    return result;
  }
  contextForTest(id, { signal } = {}) {
    return {
      config: this.store.config.integrations[id]?.config || {},
      fetch: this.fetch,
      registry: this,
      store: this.store.plugin(id),
      chat: this.chat,
      signal,
      enabled: !!this.store.config.integrations[id]?.enabled,
    };
  }
  async tools(options = {}) {
    const result = [];
    for (const [id, m] of this.modules) {
      options.signal?.throwIfAborted();
      if (!this.store.config.integrations[id]?.enabled) continue;
      for (const tool of (await m.tools?.(this.contextFor(id, options))) ||
        []) {
        if (
          !/^[a-zA-Z][\w-]{0,63}$/.test(tool.name) ||
          result.some((t) => t.name === tool.name)
        )
          throw Error("Invalid integration tool name.");
        result.push({ ...tool, integrationId: id });
      }
    }
    return result;
  }
  async sanitize(value, options = {}) {
    for (const [id, m] of this.modules) {
      options.signal?.throwIfAborted();
      const entry = this.store.config.integrations[id];
      if (!m.sanitize) continue;
      const ctx = entry?.enabled
        ? this.contextFor(id, options)
        : { ...this.contextForTest(id, options), config: {}, enabled: false };
      value = await m.sanitize(value, ctx);
    }
    return value;
  }
  async describe(name, options = {}) {
    const tool = (await this.tools(options)).find((t) => t.name === name);
    if (!tool) return null;
    const { execute, confirmation, ...description } = tool;
    return description;
  }
  async context(options = {}) {
    const parts = [];
    for (const [id, m] of this.modules) {
      options.signal?.throwIfAborted();
      if (!this.store.config.integrations[id]?.enabled) continue;
      try {
        const context = await m.context?.(this.contextFor(id, options));
        if (context) parts.push(`${m.name}:\n${context}`);
      } catch {
        options.signal?.throwIfAborted();
        parts.push(
          `${m.name}: current context unavailable. Use tools to check connection.`,
        );
      }
    }
    return parts.join("\n\n");
  }
  configHash() {
    return createHash("sha256")
      .update(JSON.stringify(this.store.config.integrations))
      .digest("hex");
  }
  async invoke(name, args, options = {}) {
    options.signal?.throwIfAborted();
    const hash = this.configHash();
    const tool = (await this.tools(options)).find((t) => t.name === name);
    if (!tool) throw Error("This integration tool is not available.");
    validate(args, tool.parameters);
    if (options.source === "background")
      throw Error("Background actions are not supported.");
    const context = { ...options, confirmed: options.confirmed === true };
    let summary =
      !context.confirmed && (await tool.confirmation?.(args, context));
    options.signal?.throwIfAborted();
    if (hash !== this.configHash())
      throw Error("Integration settings changed. Ask again before executing.");
    let result = summary
      ? { requiresConfirmation: true, summary }
      : await tool.execute(args, context);
    if (result?.requiresConfirmation && !context.confirmed) {
      const confirmation = {
        id: randomUUID(),
        tool: name,
        summary: String(result.summary || "Confirm this action?"),
        expiresAt: Date.now() + 120000,
      };
      this.pending.set(confirmation.id, {
        ...confirmation,
        integrationId: tool.integrationId,
        args: structuredClone(args),
        hash: this.configHash(),
        source: options.source || "chat",
        conversationId: options.conversationId,
      });
      for (const [key, p] of this.pending)
        if (p.expiresAt < Date.now()) this.pending.delete(key);
      return { ...result, confirmation };
    }
    return result;
  }
  async confirm(id, accepted, options = {}) {
    const pending = this.pending.get(id);
    if (options.source === "device" && pending?.source !== "device")
      throw Error("This confirmation belongs to the owner chat.");
    this.pending.delete(id);
    if (!pending)
      throw Error("This confirmation has expired or was already answered.");
    try {
      if (pending.expiresAt < Date.now())
        throw Error("This confirmation expired; the action was not executed.");
      if (!accepted) {
        const result = { success: true, declined: true };
        await this.recordConfirmation(pending, "declined", result);
        return result;
      }
      if (pending.hash !== this.configHash())
        throw Error(
          "Integration settings changed. Ask again before confirming.",
        );
      const result = await this.invoke(pending.tool, pending.args, {
        ...options,
        source: pending.source,
        conversationId: pending.conversationId,
        confirmed: true,
      });
      await this.recordConfirmation(pending, "approved", result);
      return result;
    } catch (error) {
      await this.recordConfirmation(pending, "error", {
        success: false,
        error: error.message,
      });
      throw error;
    }
  }
  async recordConfirmation(pending, decision, result) {
    if (!pending.conversationId) return;
    // A conversation may have been deleted while an external action was in flight.
    try {
      this.store.conversation(pending.conversationId);
    } catch {
      return;
    }
    const outcome = Object.fromEntries(
      [
        "success",
        "accepted",
        "verified",
        "dryRun",
        "declined",
        "requiresConfirmation",
        "error",
        "message",
        "id",
        "status",
      ]
        .filter((key) => result?.[key] !== undefined)
        .map((key) => [key, result[key]]),
    );
    const event = await this.sanitize({
      type: "confirmation_result",
      source: "carvis_registry",
      tool: pending.tool,
      confirmationId: pending.id,
      decision,
      summary: pending.summary,
      outcome,
    });
    this.store.append(pending.conversationId, "event", JSON.stringify(event), {
      event,
    });
  }
  async route(id, request, options = {}) {
    const module = this.modules.get(id);
    if (!module || !module.route) return null;
    return module.route(request, this.contextFor(id, options));
  }
}
