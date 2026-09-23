import test from "node:test";
import assert from "node:assert/strict";
import { modelKeyStatus } from "../web/model-settings.js";

const compatible = {
  provider: "compatible",
  baseUrl: "https://models.example/v1",
  hasApiKey: true,
};

test("switching to OpenAI discovers models using the saved shared key", () => {
  assert.deepEqual(modelKeyStatus(compatible, { openai: { saved: true } }, {
    provider: "openai",
  }), { shared: true, saved: true });
  assert.equal(modelKeyStatus(compatible, {}, { provider: "openai" }).saved, false);
});

test("shared keys do not make a different compatible provider look configured", () => {
  const keys = { openai: { saved: true } };
  assert.equal(modelKeyStatus(compatible, keys, {
    provider: "compatible", baseUrl: "https://another.example/v1",
  }).saved, false);
  assert.deepEqual(modelKeyStatus(compatible, keys, {
    provider: "compatible", baseUrl: "https://models.example/v1/",
  }), { shared: false, saved: true });
});

test("clearing a saved key stops automatic model discovery until a new key is entered", () => {
  assert.equal(modelKeyStatus(compatible, { openai: { saved: true } }, {
    provider: "openai", clear: true,
  }).saved, false);
  assert.equal(modelKeyStatus(compatible, {}, {
    provider: "compatible", baseUrl: compatible.baseUrl, clear: true,
  }).saved, false);
});
