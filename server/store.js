import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from "node:crypto";

export function defaults() {
  return {
    profile: {
      displayName: "",
      assistantName: "Carvis",
      personality: "Warm, concise, resourceful, with a little dry wit.",
    },
    model: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "",
      apiKey: "",
    },
    integrations: {},
    auth: {},
  };
}
export class Store {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const keyFile = join(this.directory, ".key");
    if (!existsSync(keyFile))
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyFile);
    this.config = this.read("config", defaults());
    this.data = this.read("data", {
      conversations: [],
      memory: [],
      integrations: {},
    });
  }
  read(name, fallback) {
    const path = join(this.directory, `${name}.enc`);
    if (!existsSync(path)) return fallback;
    const value = JSON.parse(readFileSync(path, "utf8"));
    const d = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(value.iv, "base64"),
    );
    d.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(value.data, "base64")),
        d.final(),
      ]).toString("utf8"),
    );
  }
  save(name, value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    const path = join(this.directory, `${name}.enc`),
      tmp = path + ".tmp";
    writeFileSync(
      tmp,
      JSON.stringify({
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      }),
      { mode: 0o600 },
    );
    renameSync(tmp, path);
  }
  saveConfig() {
    this.save("config", this.config);
  }
  saveData() {
    this.save("data", this.data);
  }
  plugin(id) {
    return {
      get: (key, fallback = null) =>
        structuredClone(this.data.integrations[id]?.[key] ?? fallback),
      set: (key, value) => {
        this.data.integrations[id] ??= {};
        this.data.integrations[id][key] = structuredClone(value);
        this.saveData();
      },
    };
  }
  createConversation() {
    const c = {
      id: randomUUID(),
      title: "New conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.data.conversations.unshift(c);
    this.saveData();
    return c;
  }
  conversation(id) {
    const c = this.data.conversations.find((c) => c.id === id);
    if (!c)
      throw Object.assign(Error("Conversation not found."), { status: 404 });
    return c;
  }
  append(id, role, content, extra = {}) {
    const c = this.conversation(id);
    c.messages.push({
      id: randomUUID(),
      role,
      content,
      createdAt: Date.now(),
      ...extra,
    });
    c.updatedAt = Date.now();
    if (role === "user" && c.title === "New conversation")
      c.title = content.replace(/\s+/g, " ").slice(0, 64);
    this.saveData();
    return c;
  }
}
