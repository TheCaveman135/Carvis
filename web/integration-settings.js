import {
  el,
  icon,
  button,
  toast,
  errorText,
  field,
  input,
  formNotice,
} from "./ui.js";
import { connectionPath } from "./api.js";
import { createIntegrationControls } from "./integration-controls.js";
import {
  integrationFieldGroup,
  integrationFieldValue,
} from "./integration-metadata.js";
import { createEntitySelector } from "./entity-selector.js";

export function createIntegrationSettings({
  state,
  api,
  act,
  navigate,
  refreshState,
  integrationDependencies,
}) {
  const { makeEntitySelector } = createEntitySelector({ api });
  function configureIntegration(
    integration,
    host,
    { inline = false, onboarding = false } = {},
  ) {
    if (!host) {
      navigate(`integrations/${integration.id}/settings`);
      return;
    }
    const values = {},
      cfg = integration.config || {},
      feedback = el("div"),
      groups = new Map();
    const dependencies = integrationDependencies(integration),
      requiredMissing = dependencies.filter(
        (item) => !item.optional && !item.enabled,
      );
    const enabled = input("enabled", "", "checkbox", {
      checked: integration.enabled,
      "aria-label": `Enable ${integration.name}`,
    });
    const form = el("form", {
      class: "integration-settings-form",
      novalidate: true,
    });
    const permissionText = (integration.permissions || []).map((permission) =>
      el(
        "li",
        {},
        icon("check"),
        typeof permission === "string"
          ? permission
          : permission.description || permission.name || "Integration access",
      ),
    );
    if (requiredMissing.length)
      form.append(
        el(
          "div",
          {
            class: `integration-dependencies${requiredMissing.length ? " attention" : ""}`,
          },
          el("h3", {}, "Works with"),
          dependencies.map((item) =>
            el(
              "div",
              { class: "dependency-row" },
              el(
                "div",
                {},
                el("strong", {}, item.name),
                el(
                  "span",
                  {},
                  item.optional
                    ? "Optional connection"
                    : "Required integration",
                ),
              ),
              el(
                "span",
                { class: `dependency-state${!item.enabled ? " off" : ""}` },
                item.enabled
                  ? "Enabled"
                  : item.integration
                    ? "Disabled"
                    : "Not installed",
              ),
            ),
          ),
          requiredMissing.length
            ? el(
                "p",
                {},
                "Set up and enable the required integrations first. You can still save this integration’s settings while it is disabled.",
              )
            : null,
        ),
      );
    if (integration.id === "even-realities") {
      form.append(el("div", { class: "integration-dependencies" },
        el("h3", {}, "Shared voice settings"),
        el("p", {}, "Your glasses use Carvis’s Voice input & chat and Global API keys. No separate speech API key or model is needed here."),
        el("div", { class: "action-row" },
          el("a", { href: "#integrations/voice", class: "button compact" }, "Voice & microphone"),
          el("a", { href: "#settings", class: "button quiet compact" }, "Global API keys"),
          el("a", { href: "#integrations/speech", class: "button quiet compact" }, "Spoken replies"))));
    }
    const permissions = el(
      "details",
      { class: "integration-permissions" },
      el(
        "summary",
        {},
        `Access & abilities${permissionText.length ? ` · ${permissionText.length}` : ""}`,
      ),
      permissionText.length
        ? el("ul", {}, permissionText)
        : el("p", { class: "small muted" }, "No extra permissions declared."),
    );
    if (dependencies.length && !requiredMissing.length)
      form.append(
        el(
          "p",
          { class: "dependency-ready small muted" },
          "Connected with ",
          dependencies.map((item, index) =>
            el(
              "span",
              {},
              index ? ", " : "",
              el(
                "a",
                {
                  href:
                    item.id === "home-assistant"
                      ? "#settings/home-assistant"
                      : `#integrations/${item.id}`,
                },
                item.name,
              ),
            ),
          ),
        ),
      );
    const tabs = el("div", {
        class: "integration-settings-tabs",
        role: "tablist",
        "aria-label": "Settings sections",
      }),
      panels = el("div", { class: "integration-settings-panels" });
    let activeGroup = null;
    const activate = (id, focus = false) => {
      if (inline) return;
      activeGroup = id;
      for (const [key, group] of groups) {
        const selected = key === id;
        group.panel.hidden = !selected;
        group.tab.classList.toggle("active", selected);
        group.tab.setAttribute("aria-selected", String(selected));
        group.tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) group.tab.focus();
      }
    };
    const getGroup = (definition) => {
      const metadata = integrationFieldGroup(integration, definition);
      if (!groups.has(metadata.id)) {
        const index = groups.size,
          panelId = `integration-settings-panel-${index}`,
          tabId = `integration-settings-tab-${index}`;
        const tab = el(
          "button",
          {
            type: "button",
            class: "integration-settings-tab",
            id: tabId,
            role: "tab",
            "aria-controls": panelId,
            "aria-selected": "false",
            tabindex: "-1",
            onclick: () => {
              activate(metadata.id);
              if (window.matchMedia("(max-width:600px)").matches)
                panel.scrollIntoView({ block: "start", behavior: "smooth" });
            },
          },
          metadata.label,
        );
        const panel = el(
          "section",
          {
            class: "integration-settings-panel",
            id: panelId,
            role: "tabpanel",
            "aria-labelledby": tabId,
            hidden: true,
          },
          el(
            "div",
            { class: "settings-group-heading" },
            el("h3", {}, metadata.label),
            metadata.description ? el("p", {}, metadata.description) : null,
          ),
        );
        groups.set(metadata.id, { tab, panel, metadata });
        tabs.append(tab);
        panels.append(panel);
      }
      return { ...groups.get(metadata.id), id: metadata.id };
    };
    tabs.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const ids = [...groups.keys()],
        current = ids.indexOf(activeGroup);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? ids.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + ids.length) %
              ids.length;
      if (ids[next]) activate(ids[next], true);
    });
    const createControl = createIntegrationControls({
      state,
      api,
      integration,
      values,
    });
    let entitySection = null;
    for (const definition of integration.fields || []) {
      const f = definition;
      if (inline && f.key.startsWith("models__")) continue;
      if (
        integration.id === "home-assistant" &&
        ["observed", "controlled", "guards"].includes(f.key)
      )
        continue;
      const group = getGroup(f),
        value = cfg[f.key] ?? f.default;
      const control = createControl(f, value);
      const sharedKeyId = {
        openaiKey: "openai",
        anthropicKey: "anthropic",
        stt__deepgramKey: "deepgram",
        stt__assemblyaiKey: "assemblyai",
        search__geminiKey: "gemini",
      }[f.key];
      if (
        sharedKeyId &&
        f.type === "password" &&
        !cfg[`has${f.key[0].toUpperCase()}${f.key.slice(1)}`]
      )
        control.placeholder = state.data.apiKeys?.[sharedKeyId]?.saved
          ? "Using global key · optional override"
          : "Optional override · set shared key in Settings";
      let hasSecret = Boolean(
        cfg[`has${f.key[0].toUpperCase()}${f.key.slice(1)}`],
      );
      const updateRequired = () => {
        control.required = Boolean(
          enabled.checked &&
            f.required &&
            (f.type !== "password" || !hasSecret),
        );
      };
      updateRequired();
      enabled.addEventListener("change", updateRequired);
      control.addEventListener("input", () => control.setCustomValidity(""));
      values[f.key] = { control, field: f, groupId: group.id };
      const description = [
        f.description,
        f.help,
        ["string-array", "string_array"].includes(f.type)
          ? "Enter one value per line."
          : f.type === "json"
            ? "Use JSON for lists or structured settings. Leave blank to keep the saved value; use [] or {} to clear it."
            : null,
      ]
        .filter(
          (text, index, all) =>
            typeof text === "string" && text && all.indexOf(text) === index,
        )
        .join(" ");
      let destination = group.panel;
      if (
        (f.advanced && f.key !== "agent__allowedDomains") ||
        (inline && sharedKeyId)
      ) {
        let advanced = group.panel.querySelector(".advanced-settings");
        if (!advanced) {
          advanced = el(
            "details",
            { class: "advanced-settings" },
            el("summary", {}, "Advanced settings"),
            el(
              "p",
              { class: "small muted" },
              "Optional tuning. Keep the defaults unless you have a specific reason to change them.",
            ),
          );
          group.panel.append(advanced);
        }
        destination = advanced;
      }
      if (f.key === "agent__allowedDomains") {
        control.hidden = true;
        const chosen = new Set(Array.isArray(value) ? value : []);
        const domains = [
          ...new Set([
            ...chosen,
            "light",
            "switch",
            "fan",
            "climate",
            "cover",
            "media_player",
            "remote",
            "scene",
            "script",
            "automation",
            "input_boolean",
            "input_number",
            "input_select",
            "button",
            "number",
            "select",
            "lock",
            "vacuum",
            "humidifier",
            "water_heater",
            "siren",
            "update",
          ]),
        ].sort();
        const picker = el(
          "fieldset",
          { class: "device-type-picker" },
          el("legend", {}, "Device types Carvis may control"),
          el(
            "p",
            { class: "small muted" },
            "Type permission is only the first step. Also enable Interact for each device below. Observation is separate.",
          ),
        );
        const typeSummary = el(
          "summary",
          {},
          `Device types · ${chosen.size} allowed`,
        );
        const typeDisclosure = el(
          "details",
          { class: "device-type-disclosure" },
          typeSummary,
          picker,
        );
        for (const domain of domains) {
          const check = input(`allow-type-${domain}`, "", "checkbox", {
            checked: chosen.has(domain),
          });
          check.addEventListener("change", () => {
            check.checked ? chosen.add(domain) : chosen.delete(domain);
            typeSummary.textContent = `Device types · ${chosen.size} allowed`;
            control.value = [...chosen].join("\n");
            control.dispatchEvent(new Event("input"));
          });
          picker.append(
            el(
              "label",
              { class: "device-type-option" },
              check,
              el("span", {}, domain.replaceAll("_", " ")),
            ),
          );
        }
        destination.append(typeDisclosure, control);
      } else
        destination.append(
          f.type === "boolean"
            ? el(
                "label",
                { class: "field checkbox" },
                control,
                el(
                  "span",
                  {},
                  el("span", { class: "field-label" }, f.label || f.key),
                  description
                    ? el("span", { class: "field-description" }, description)
                    : null,
                ),
              )
            : field(f.label || f.key, control, description),
        );
      if (f.key === "pairingToken" && integration.id === "even-realities") {
        const secretArea = el("div");
        const generate = button(
          "Generate pairing token",
          async () => {
            generate.disabled = true;
            try {
              const result = await api(
                "/api/integrations/even-realities/generate-secret",
                { method: "POST", body: { key: "pairingToken" } },
              );
              if (!result.value) throw new Error("No token was returned.");
              control.value = "";
              control.placeholder = "Saved · leave blank to keep";
              hasSecret = true;
              updateRequired();
              const token = input("new-pairing-token", result.value, "text", {
                readonly: true,
                "aria-label": "New pairing token",
                autocomplete: "off",
              });
              secretArea.replaceChildren(
                el(
                  "div",
                  { class: "notice" },
                  el(
                    "p",
                    {},
                    "New token saved. Copy it into your glasses app now. Existing pairings will need the new token.",
                  ),
                ),
                token,
                el(
                  "div",
                  { class: "action-row" },
                  button(
                    "Copy token",
                    () =>
                      act(async () => {
                        await navigator.clipboard.writeText(result.value);
                        toast("Pairing token copied.");
                      }),
                    "compact",
                    "copy",
                  ),
                ),
              );
              await refreshState();
            } catch (error) {
              formNotice(secretArea, errorText(error));
            } finally {
              generate.disabled = false;
            }
          },
          "compact",
          "refresh",
        );
        group.panel.append(
          generate,
          el(
            "p",
            { class: "field-description" },
            "Creates and saves a new token immediately. It replaces the previous token.",
          ),
          secretArea,
        );
      }
    }
    if (integration.id === "home-assistant") {
      entitySection = makeEntitySelector(cfg, () => {
        const entry = values.agent__allowedDomains;
        return entry ? integrationFieldValue(entry.field, entry.control) : [];
      });
      if (values.agent__allowedDomains)
        values.agent__allowedDomains.control.addEventListener("input", () =>
          entitySection.refresh(),
        );
      getGroup({ key: "observed" }).panel.append(entitySection.node);
    }
    if (groups.size) {
      const rank = (key) =>
        /connection|controller|credentials/.test(key)
          ? 0
          : /^(stt|speech|devices|reply-behavior)$/.test(key)
            ? 1
            : /models|tools|ollama|agent/.test(key)
              ? 4
              : 2;
      const ordered = [...groups].sort(([a], [b]) => rank(a) - rank(b));
      for (const [, g] of ordered) {
        tabs.append(g.tab);
        panels.append(g.panel);
        const advanced = g.panel.querySelector(".advanced-settings");
        if (advanced) g.panel.append(advanced);
      }
      if (inline) {
        panels.classList.add("integration-settings-inline");
        for (const [groupId, g] of ordered) {
          g.panel.hidden = false;
          g.panel.removeAttribute("role");
          g.panel.removeAttribute("aria-labelledby");
          if (
            (onboarding && !["connection", "devices"].includes(groupId)) ||
            (!g.panel.querySelector(":scope > .field") &&
              g.panel.querySelector(".advanced-settings"))
          ) {
            const folded = el(
              "details",
              { class: "integration-advanced-group" },
              el("summary", {}, g.metadata.label),
            );
            g.panel.before(folded);
            folded.append(g.panel);
          }
        }
        form.append(panels);
      } else {
        form.append(el("div", { class: "settings-layout" }, tabs, panels));
        activate(ordered[0][0]);
      }
    } else
      form.append(
        el(
          "p",
          { class: "small muted" },
          "This integration has no additional settings.",
        ),
      );
    if (inline && integration.fields.some((f) => f.key.startsWith("models__")))
      form.prepend(
        el(
          "p",
          { class: "small muted" },
          "AI models and shared API keys are managed in ",
          el("a", { href: "#settings" }, "Carvis Settings → Model Router"),
          " .",
        ),
      );
    const collectConfig = (interactive = true) => {
      const config = {};
      for (const [key, entry] of Object.entries(values)) {
        const { control, field: definition, groupId } = entry;
        if (!control.checkValidity()) {
          if (!interactive)
            throw new Error(
              `${definition.label || key}: ${control.validationMessage}`,
            );
          activate(groupId);
          const folded = control.closest("details");
          if (folded) folded.open = true;
          control.reportValidity();
          throw new Error(
            `${definition.label || key}: ${control.validationMessage}`,
          );
        }
        try {
          const value = integrationFieldValue(definition, control);
          if (value !== undefined) config[key] = value;
        } catch (error) {
          if (!interactive) throw error;
          control.setCustomValidity(errorText(error));
          activate(groupId);
          const folded = control.closest("details");
          if (folded) folded.open = true;
          control.reportValidity();
          throw error;
        }
      }
      if (entitySection) Object.assign(config, entitySection.value());
      return config;
    };
    const save = el(
      "button",
      { type: "submit", class: "button primary" },
      "Save changes",
    );
    const test = button(
      "Test saved connection",
      async () => {
        test.disabled = true;
        feedback.replaceChildren();
        try {
          const result = await api(`${connectionPath(integration.id)}/test`, {
            method: "POST",
          });
          formNotice(
            feedback,
            result.message ||
              result.error ||
              (result.success
                ? "Connection successful."
                : "Could not connect."),
            result.success,
          );
        } catch (error) {
          formNotice(feedback, errorText(error));
        } finally {
          test.disabled = false;
        }
      },
      "",
      "refresh",
    );
    const saveStatus = el(
      "span",
      { class: "small muted", role: "status", "aria-live": "polite" },
      "Changes save automatically",
    );
    save.textContent = "Save now";
    form.append(
      permissions,
      feedback,
      el("div", { class: "modal-footer" }, saveStatus, test, save),
    );
    let baseline;
    try {
      baseline = structuredClone(collectConfig(false));
    } catch {
      baseline = { ...cfg };
    }
    let timer,
      saving = false,
      queued = false;
    const persist = async (interactive = false) => {
      clearTimeout(timer);
      if (saving) {
        queued = true;
        return;
      }
      let snapshot;
      try {
        snapshot = structuredClone(collectConfig(interactive));
      } catch (error) {
        saveStatus.textContent = "Not saved — finish the highlighted fields";
        formNotice(feedback, errorText(error));
        return;
      }
      const patch = Object.fromEntries(
        Object.entries(snapshot).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(baseline[key]),
        ),
      );
      if (!Object.keys(patch).length) {
        saveStatus.textContent = "All changes saved";
        return;
      }
      saving = true;
      save.disabled = true;
      saveStatus.textContent = "Saving…";
      feedback.replaceChildren();
      try {
        await api(connectionPath(integration.id), {
          method: "PUT",
          body: { config: patch },
        });
        Object.assign(baseline, patch);
        for (const [key, value] of Object.entries(patch)) {
          const entry = values[key];
          if (
            entry?.field.type === "password" &&
            value &&
            entry.control.value === value
          ) {
            entry.control.value = "";
            entry.control.required = false;
            entry.control.placeholder = "Saved · leave blank to keep";
            baseline[key] = "";
          }
        }
        await refreshState();
        saveStatus.textContent = "Saved";
        if (entitySection && ("baseUrl" in patch || "token" in patch))
          entitySection.reload();
        if (
          Object.keys(patch).some((key) =>
            /provider|engine|baseUrl|BaseUrl|Key|key/.test(key),
          )
        )
          for (const entry of Object.values(values))
            entry.control.loadModels?.();
      } catch (error) {
        saveStatus.textContent = "Not saved — retry";
        formNotice(feedback, errorText(error));
      } finally {
        saving = false;
        save.disabled = false;
        if (queued) {
          queued = false;
          void persist();
        }
      }
    };
    const scheduleSave = () => {
      clearTimeout(timer);
      saveStatus.textContent = "Unsaved changes…";
      timer = setTimeout(() => void persist(), 700);
    };
    // Capture before entity controls rebuild their rows, then read the updated values after the debounce.
    form.addEventListener("input", scheduleSave, true);
    form.addEventListener("change", scheduleSave, true);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void persist(true);
    });
    host.replaceChildren(form);
  }

  return { configureIntegration };
}
