import test from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../server/registry.js";

function fixture(definitions) {
  const store = {
    config: { integrations: {} },
    saveConfig() {},
    plugin: () => ({}),
  };
  const registry = new Registry(store);
  for (const [id, dependsOn = [], enabled = true] of definitions) {
    registry.register({
      id, name: id, dependsOn, fields: [],
      validateConfig: value => value,
      route: (_request, context) => context.config,
      tools: () => [{ name: `${id}_read`, parameters: { type: "object" }, execute: () => ({ ok: true }) }],
    });
    store.config.integrations[id] = { enabled, config: { value: id } };
  }
  return { registry, store };
}

test("optional disabled or uninstalled integrations never block config or tools", async () => {
  const { registry } = fixture([
    ["optional", [], false],
    ["feature", [{ id: "optional", optional: true }, { id: "absent", optional: true }]],
  ]);
  assert.equal(registry.available("feature"), true);
  assert.deepEqual(registry.getConfig("feature"), { value: "feature" });
  assert.deepEqual(await registry.route("feature", {}), { value: "feature" });
  assert.deepEqual((await registry.tools()).map(tool => tool.name), ["feature_read"]);
  assert.equal((await registry.configure("feature", { enabled: true })).status, "ready");
});

test("required dependencies must be installed as well as enabled", async () => {
  for (const dependency of ["disabled", "absent"]) {
    const { registry, store } = fixture([["disabled", [], false], ["feature", [dependency]]]);
    // Stale installed configuration must not count as an available module.
    store.config.integrations.absent = { enabled: true, config: {} };
    assert.equal(registry.available("feature"), false);
    assert.throws(() => registry.getConfig("feature"), /required integrations/);
    assert.equal(registry.list().find(item => item.id === "feature").status, "dependency disabled");
    await assert.rejects(registry.configure("feature", { enabled: true }), /required integrations/);
    await assert.rejects(registry.route("feature", {}), /required integrations/);
  }
});

test("a disabled transitive dependency revokes tools and config consistently", async () => {
  const { registry, store } = fixture([["source"], ["middle", ["source"]], ["feature", ["middle"]]]);
  assert.equal(registry.available("feature"), true);
  await registry.configure("source", { enabled: false });
  assert.equal(registry.available("feature"), false);
  assert.throws(() => registry.getConfig("feature"), /middle/);
  assert.equal(registry.list().find(item => item.id === "feature").status, "dependency disabled");
  assert.deepEqual(await registry.tools(), []);
  await assert.rejects(registry.configure("feature", { enabled: true }), /middle/);
  assert.equal(store.config.integrations.feature.enabled, true);
  await registry.configure("source", { enabled: true });
  assert.equal(registry.available("feature"), true);
  assert.deepEqual(registry.getConfig("feature"), { value: "feature" });
});

test("cycles fail closed while shared dependencies are allowed", async () => {
  const { registry } = fixture([["first", ["second"]], ["second", ["first"]]]);
  assert.equal(registry.available("first"), false);
  assert.throws(() => registry.getConfig("first"), /second/);
  assert.equal(registry.list()[0].status, "dependency disabled");
  await assert.rejects(registry.configure("first", { enabled: true }), /second/);

  const shared = fixture([["source"], ["left", ["source"]], ["right", ["source"]], ["feature", ["left", "right"]]]).registry;
  assert.equal(shared.available("feature"), true);
  assert.deepEqual(shared.getConfig("feature"), { value: "feature" });
  assert.equal((await shared.configure("feature", { enabled: true })).status, "ready");
});

test("configuration cannot be read from an uninstalled integration", () => {
  const { registry, store } = fixture([]);
  store.config.integrations.absent = { enabled: true, config: {} };
  assert.throws(() => registry.getConfig("absent"), /not found/);
});
