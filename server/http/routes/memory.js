import { randomUUID } from "node:crypto";
import { body, fail, json } from "../responses.js";
import { text } from "../../validation.js";

export async function memoryRoutes({ req, res, path, store }) {
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
  return false;
}
