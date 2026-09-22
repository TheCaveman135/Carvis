import test from "node:test";
import assert from "node:assert/strict";
import { createApi, connectionPath, coalesceReads } from "../web/api.js";

test("frontend API preserves JSON bodies, request options, and authentication handling", async () => {
  let unauthorized = 0;
  const controller = new AbortController();
  const api = createApi({
    onUnauthorized: () => unauthorized++,
    async fetch(path, options) {
      assert.equal(path, "/api/settings");
      assert.equal(options.method, "POST");
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.signal, controller.signal);
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(options.headers["X-Test"], "fixture");
      assert.deepEqual(JSON.parse(options.body), { enabled: false });
      return new Response(JSON.stringify({ error: "Sign in again" }), {
        status: 401,
      });
    },
  });
  await assert.rejects(
    api("/api/settings", {
      method: "POST",
      body: { enabled: false },
      signal: controller.signal,
      headers: { "X-Test": "fixture" },
    }),
    /Sign in again/,
  );
  assert.equal(unauthorized, 1);
});

test("read coalescing shares concurrent discovery without caching later responses", async () => {
  let calls = 0,
    resolve;
  const read = coalesceReads(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const first = read("/devices"),
    second = read("/devices");
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve({ devices: ["first"] });
  assert.deepEqual(await first, { devices: ["first"] });
  const next = read("/devices");
  await Promise.resolve();
  assert.equal(calls, 2);
  resolve({ devices: ["updated"] });
  assert.deepEqual(await next, { devices: ["updated"] });
});

test("a failed discovery can be retried and separate endpoints are independent", async () => {
  let calls = 0;
  const read = coalesceReads(async (path) => {
    if (++calls === 1) throw new Error("Temporary failure");
    return path;
  });
  await assert.rejects(read("/devices"), /Temporary failure/);
  assert.deepEqual(await Promise.all([read("/devices"), read("/speakers")]), [
    "/devices",
    "/speakers",
  ]);
  assert.equal(calls, 3);
  assert.equal(connectionPath("home-assistant"), "/api/home-assistant");
  assert.equal(connectionPath("a/b"), "/api/integrations/a%2Fb");
});
