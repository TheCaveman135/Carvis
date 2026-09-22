import { body, fail, json } from "../responses.js";
import { text } from "../../validation.js";

export async function conversationRoutes({
  req,
  res,
  path,
  user,
  store,
  registry,
  chat,
}) {
  if (path === "/api/voice-conversations" && req.method === "GET") {
    if (!user) throw fail("Sign in to Carvis.", 401);
    return json(res, 200, {
      conversations: store.data.conversations
        .filter((c) => c.channel === "voice")
        .sort((a, b) => b.updatedAt - a.updatedAt),
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
      if (chat.busy.has(id)) throw fail("Wait for this reply to finish.", 409);
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
      return true;
    }
  }
  const confirmationMatch = /^\/api\/confirmations\/([\w-]+)$/.exec(path);
  if (confirmationMatch && req.method === "POST") {
    const b = await body(req);
    if (typeof b.accepted !== "boolean")
      throw fail("Choose accept or decline.");
    const result = await registry.confirm(confirmationMatch[1], b.accepted, {
      source: "chat",
    });
    return json(res, 200, { success: result?.success !== false, result });
  }
  return false;
}
