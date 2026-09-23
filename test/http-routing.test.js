import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.js";
import { serveStatic } from "../server/http/static.js";

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "carvis-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("static modules revalidate without a response body and pick up file changes", async (t) => {
  const root = directory(t);
  mkdirSync(join(root, "web", "views"), { recursive: true });
  const file = join(root, "web", "views", "fixture.js");
  writeFileSync(file, "export const value = 1;");
  const server = http.createServer((req, res) => {
    serveStatic(
      req,
      res,
      new URL(req.url, "http://localhost").pathname,
      root,
    ).catch((error) => {
      res.writeHead(error.status || 400);
      res.end();
    });
  });
  const base = await listen(t, server);
  const url = base + "/views/fixture.js";
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type"), /javascript/);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.equal(await first.text(), "export const value = 1;");
  for (const condition of [etag, `"unrelated", ${etag}`, etag.slice(2), "*"]) {
    const cached = await fetch(url, {
      headers: { "If-None-Match": condition },
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
    assert.equal(cached.headers.get("etag"), etag);
    assert.equal(cached.headers.get("cache-control"), "no-cache");
    assert.match(
      cached.headers.get("content-security-policy"),
      /script-src 'self'/,
    );
  }
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  writeFileSync(file, "export const value = 200;");
  const changed = await fetch(url, { headers: { "If-None-Match": etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.match(await changed.text(), /200/);
  assert.equal((await fetch(base + "/..%2Fprivate.txt")).status, 404);
  assert.equal((await fetch(base + "/views")).status, 404);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
});

test("extracted routes retain JSON validation, owner access and streaming conversations", async (t) => {
  const app = await createApp({
    dataDirectory: directory(t),
    modules: [],
    round: async ({ onDelta }) => {
      onDelta("Fixture reply.");
      return { text: "Fixture reply.", toolCalls: [], append: [] };
    },
    fetcher: async () => {
      throw Error("This test must not contact an external service.");
    },
  });
  const base = await listen(t, app.server);
  const send = (path, data, options = {}) =>
    fetch(base + path, {
      method: "POST",
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify(data),
    });
  const setup = await send("/api/setup", {
    username: "owner",
    password: "fixture-password-only",
  });
  assert.equal(setup.status, 200);
  const headers = { Cookie: setup.headers.get("set-cookie").split(";")[0] };
  assert.equal((await send("/api/settings", {})).status, 401);
  assert.equal((await send("/api/settings", [], { headers })).status, 400);
  assert.equal(
    (
      await send(
        "/api/settings",
        { profile: { personality: "x".repeat(128001) } },
        { headers },
      )
    ).status,
    413,
  );
  assert.equal(
    (await send("/api/settings", { model: { model: "fixture" } }, { headers }))
      .status,
    200,
  );
  const created = await send("/api/conversations", {}, { headers });
  assert.equal(created.status, 201);
  const conversation = await created.json();
  const reply = await send(
    `/api/conversations/${conversation.id}/messages`,
    { text: "Hello" },
    { headers },
  );
  assert.match(reply.headers.get("content-type"), /text\/event-stream/);
  const events = await reply.text();
  assert.match(events, /event: delta/);
  assert.match(events, /Fixture reply/);
  assert.match(events, /event: done/);
  const saved = await (
    await fetch(base + `/api/conversations/${conversation.id}`, { headers })
  ).json();
  assert.deepEqual(
    saved.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  const memory = await send(
    "/api/memory",
    { text: "Fixture memory" },
    { headers },
  );
  assert.equal(memory.status, 201);
  assert.equal(
    (
      await fetch(base + `/api/memory/${(await memory.json()).id}`, {
        method: "DELETE",
        headers,
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(base + "/api/nonexistent", { headers })).status,
    404,
  );
});

test("companion can read pairing failures while owner data stays protected", async t => {
 const app=await createApp({dataDirectory:directory(t),modules:[{
  id:'fixture-engine',name:'Fixture',fields:[],
  deviceRoute:(method,path)=>method==='GET' && path==='/api/glasses/feed',
 }]});
 const base=await listen(t,app.server);
 const origin='https://companion.example';
 const headers={Origin:origin,Authorization:'Bearer wrong-pairing-token'};
 const preflight=await fetch(base+'/api/glasses/feed',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization,content-type'}});
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
 for(const path of ['/api/glasses/feed','/api/integrations/even-realities/feed']){
  const denied=await fetch(base+path,{headers});
  assert.equal(denied.status,401);assert.equal(denied.headers.get('access-control-allow-origin'),origin);
  assert.equal(denied.headers.get('access-control-allow-credentials'),null);
  assert.match((await denied.json()).error,/Sign in/);
 }
 const owner=await fetch(base+'/api/state',{headers});
 assert.equal(owner.status,401);assert.equal(owner.headers.get('access-control-allow-origin'),null);
});
