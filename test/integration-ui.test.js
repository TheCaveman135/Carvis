import test from "node:test";
import assert from "node:assert/strict";
import {
  createIntegrationMetadata,
  integrationPanelUrl,
  integrationMatchesSearch,
  integrationFieldGroup,
  integrationFieldValue,
} from "../web/integration-metadata.js";
import appleTv from "../server/integrations/apple-tv.js";

function helpers(integrations = [], homeAssistant) {
  return {
    ...createIntegrationMetadata({
      getState: () => ({ integrations, homeAssistant }),
    }),
    integrationPanelUrl: (value) =>
      integrationPanelUrl(value, "https://carvis.example"),
    integrationMatchesSearch,
    integrationFieldGroup,
    integrationFieldValue,
  };
}

test("control modules accept only this installation origin and reject embedded credentials", () => {
  const ui = helpers();
  assert.equal(
    ui.integrationPanelUrl("/integrations/assistant-engine/"),
    "/integrations/assistant-engine/",
  );
  assert.equal(
    ui.integrationPanelUrl(
      "https://carvis.example/integrations/assistant-engine/?view=protocols#active",
    ),
    "/integrations/assistant-engine/?view=protocols#active",
  );
  for (const unsafe of [
    "https://another.example/panel",
    "//another.example/panel",
    "javascript:alert(1)",
    "data:text/html,hi",
    "http://carvis.example/panel",
    "https://owner:secret@carvis.example/panel",
    "https://carvis.example:8443/panel",
    "",
  ])
    assert.equal(ui.integrationPanelUrl(unsafe), null, unsafe);
});

test("integration dependencies use the core Home Assistant connection", () => {
  const ui = helpers([], {
    id: "home-assistant",
    name: "Home Assistant",
    enabled: true,
  });
  const dependencies = ui.integrationDependencies({
    dependsOn: ["home-assistant"],
  });
  assert.equal(dependencies[0].enabled, true);
  assert.equal(dependencies[0].name, "Home Assistant");
});

test("enabled state stays distinct from connectivity and dependency readiness", () => {
  const ui = helpers([
    { id: "home-assistant", name: "Home Assistant", enabled: false },
  ]);
  assert.equal(
    ui.integrationStatus({ id: "tv", enabled: false, status: "connected" })
      .label,
    "Disabled",
  );
  assert.equal(
    ui.integrationStatus({
      id: "tv",
      enabled: true,
      configured: true,
      dependsOn: ["home-assistant"],
    }).tone,
    "attention",
  );
  assert.equal(
    ui.integrationDependencies({ dependsOn: ["home-assistant"] })[0].name,
    "Home Assistant",
  );
  assert.equal(
    ui.integrationStatus({
      id: "tv",
      enabled: true,
      configured: true,
      dependsOn: [{ id: "home-assistant", optional: true }],
    }).label,
    "Enabled",
  );
  assert.equal(
    ui.integrationStatus({
      id: "tv",
      enabled: true,
      configured: true,
      status: "error",
    }).tone,
    "attention",
  );
  assert.equal(
    ui.integrationStatus({ id: "tv", enabled: true, configured: false }).label,
    "Enabled · setup needed",
  );
});

test("settings preserve typed false and zero, retain blank secrets, and parse structures", () => {
  const ui = helpers();
  assert.equal(
    ui.integrationFieldValue(
      { key: "tv__silentNavigation", type: "boolean" },
      { checked: false, value: "" },
    ),
    false,
  );
  assert.equal(
    ui.integrationFieldValue(
      { key: "volume", type: "number", min: 0, max: 100 },
      { value: "0" },
    ),
    0,
  );
  assert.equal(
    ui.integrationFieldValue(
      { key: "apiKey", type: "password" },
      { value: "" },
    ),
    undefined,
  );
  assert.equal(
    ui.integrationFieldValue({ key: "retry", type: "number" }, { value: "" }),
    undefined,
  );
  assert.equal(
    ui.integrationFieldValue({ key: "rules", type: "json" }, { value: "" }),
    undefined,
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        ui.integrationFieldValue(
          { key: "routines__rules", type: "json" },
          { value: '{"enabled":false,"steps":[1,2]}' },
        ),
      ),
    ),
    { enabled: false, steps: [1, 2] },
  );
  assert.deepEqual(
    [
      ...ui.integrationFieldValue(
        { key: "names", type: "string-array" },
        { value: "Living room\nBedroom\nLiving room\n" },
      ),
    ],
    ["Living room", "Bedroom"],
  );
  assert.deepEqual(
    [
      ...ui.integrationFieldValue(
        { key: "entities", type: "entities" },
        { value: "light.a, light.b\nlight.a" },
      ),
    ],
    ["light.a", "light.b"],
  );
});

test("invalid JSON and out-of-range numbers stop a settings submission", () => {
  const ui = helpers();
  assert.throws(
    () =>
      ui.integrationFieldValue(
        { key: "rules", label: "Rules", type: "json" },
        { value: "{enabled:true}" },
      ),
    /Rules: enter valid JSON/,
  );
  assert.throws(
    () =>
      ui.integrationFieldValue(
        {
          key: "threshold",
          label: "Threshold",
          type: "number",
          min: 0,
          max: 1,
        },
        { value: "2" },
      ),
    /Threshold: enter a number between 0 and 1/,
  );
  assert.throws(
    () =>
      ui.integrationFieldValue(
        { key: "threshold", type: "number" },
        { value: "NaN" },
      ),
    /enter a number/,
  );
});

test("setting searches find TV silence and both reply switches share an obvious section", () => {
  const ui = helpers();
  assert.equal(ui.integrationMatchesSearch(appleTv, "silent navigation"), true);
  assert.equal(ui.integrationMatchesSearch(appleTv, "short playback"), true);
  assert.equal(
    ui.integrationMatchesSearch(appleTv, "camera recognition"),
    false,
  );
  for (const key of ["silentNavigation", "shortReplies"]) {
    const field = appleTv.fields.find((field) => field.key === key);
    assert.equal(field.default, true);
    assert.equal(
      ui.integrationFieldGroup(appleTv, field).label,
      "Reply behavior",
    );
  }
});

test("control modules respect both capability and control dependencies after disable", () => {
  const ui = helpers([
    { id: "assistant-engine", name: "Assistant engine", enabled: false },
  ]);
  assert.equal(
    ui.integrationControlsMissing({ dependsOn: ["assistant-engine"] })[0].name,
    "Assistant engine",
  );
  assert.equal(
    ui.integrationControlsMissing({
      controls: { dependsOn: ["assistant-engine"] },
    }).length,
    1,
  );
  assert.equal(
    ui.integrationControlsMissing({
      dependsOn: ["assistant-engine"],
      controls: { dependsOn: ["assistant-engine"] },
    }).length,
    1,
  );
  assert.equal(
    ui.integrationControlsMissing({
      dependsOn: [{ id: "assistant-engine", optional: true }],
    }).length,
    0,
  );
});
