import { el, input, field, button, toast, errorText } from "./ui.js";
import { coalesceReads } from "./api.js";

function roomNotesControl(saved) {
  const rows = el("div", { class: "room-note-rows" }),
    entries = [];
  const add = (room = "", note = "") => {
    const name = input("room", room, "text", {
        "aria-label": "Room or area name",
        placeholder: "Room name",
      }),
      text = el(
        "textarea",
        {
          rows: 2,
          "aria-label": "Room notes",
          placeholder:
            "Objects, landmarks, or details Carvis should recognize.",
        },
        String(note),
      );
    const row = el(
      "div",
      { class: "room-note-row" },
      field("Room or area", name),
      field("Notes", text),
      button(
        "Remove",
        () => {
          entries.splice(entries.indexOf(entry), 1);
          row.remove();
          control.dispatchEvent(new Event("input", { bubbles: true }));
        },
        "quiet compact",
      ),
    );
    const entry = { name, text };
    entries.push(entry);
    rows.append(row);
  };
  for (const [room, note] of Object.entries(saved)) add(room, note);
  const control = el(
    "div",
    {},
    rows,
    button("Add room notes", () => add(), "compact"),
  );
  control.notes = () =>
    Object.fromEntries(
      entries
        .filter((e) => e.name.value.trim())
        .map((e) => [e.name.value.trim(), e.text.value]),
    );
  control.checkValidity = () => {
    const names = entries.map((e) => e.name.value.trim());
    return (
      entries.every((e) => e.name.value.trim() || !e.text.value.trim()) &&
      new Set(names.filter(Boolean)).size === names.filter(Boolean).length
    );
  };
  control.reportValidity = () => {
    toast("Give each note a unique room or area name.", true);
    return false;
  };
  control.setCustomValidity = () => {};
  control.validationMessage = "Give each note a unique room or area name.";
  return control;
}

/** Build settings inputs and share overlapping device discovery within one form. */
export function createIntegrationControls({ state, api, integration, values }) {
  const cfg = integration.config || {};
  const read = coalesceReads(api);
  return function createControl(f, value) {
    let control;
    if (f.type === "room-notes") control = roomNotesControl(value || {});
    else if (f.type === "boolean")
      control = input(f.key, "", "checkbox", {
        checked: Boolean(
          value ?? (integration.id === "home-assistant" && f.key === "dryRun"),
        ),
      });
    else if (f.type === "select")
      control = el(
        "select",
        { name: f.key },
        !f.required && value === undefined
          ? el("option", { value: "" }, "Choose an option")
          : null,
        (f.options || []).map((option) =>
          el(
            "option",
            {
              value: typeof option === "string" ? option : option.value,
              selected:
                String(typeof option === "string" ? option : option.value) ===
                String(value),
            },
            typeof option === "string" ? option : option.label,
          ),
        ),
      );
    else if (["entities", "string-array", "string_array"].includes(f.type))
      control = el(
        "textarea",
        {
          name: f.key,
          rows: "4",
          placeholder: f.placeholder || "One item per line",
        },
        Array.isArray(value) ? value.join("\n") : (value ?? ""),
      );
    else if (["textarea", "json"].includes(f.type))
      control = el(
        "textarea",
        {
          name: f.key,
          rows: f.type === "json" ? "7" : "4",
          class: f.type === "json" ? "json-input" : "",
          spellcheck: f.type === "json" ? "false" : "true",
          placeholder: f.placeholder || (f.type === "json" ? "[] or {}" : ""),
        },
        typeof value === "object" ||
          (f.type === "json" &&
            value !== undefined &&
            typeof value !== "string")
          ? JSON.stringify(value, null, 2)
          : (value ?? ""),
      );
    else
      control = input(
        f.key,
        f.type === "password" ? "" : (value ?? ""),
        ["password", "url", "number"].includes(f.type) ? f.type : "text",
        {
          autocomplete: f.type === "password" ? "new-password" : "off",
          min: f.min ?? f.minimum,
          max: f.max ?? f.maximum,
          step: f.type === "number" ? (f.step ?? "any") : undefined,
          placeholder:
            f.type === "password"
              ? cfg[`has${f.key[0].toUpperCase()}${f.key.slice(1)}`]
                ? "Saved · leave blank to keep"
                : "Enter your secret"
              : f.placeholder || "",
        },
      );
    if (
      f.key === "model" ||
      f.key === "speechModel" ||
      f.key.endsWith("__model")
    ) {
      control = el(
        "select",
        { name: f.key },
        el("option", { value: "" }, "Service default / not set"),
        ...(value
          ? [el("option", { value, selected: true }, `${value} (saved)`)]
          : []),
      );
      let requestVersion = 0;
      control.loadModels = async () => {
        const version = ++requestVersion;
        const providerKey = f.key.replace(/__model$/, "__provider");
        try {
          const result = await api("/api/integration-models", {
            method: "POST",
            body: {
              integrationId: integration.id,
              field: f.key,
              providerId: values[providerKey]?.control.value,
            },
          });
          if (version !== requestVersion) return;
          const current = control.value;
          const choices = [
            ...new Set([...(current ? [current] : []), ...result.models]),
          ];
          control.replaceChildren(
            el("option", { value: "" }, "Service default / not set"),
            ...choices.map((id) =>
              el(
                "option",
                { value: id },
                result.models.includes(id) ? id : `${id} (saved)`,
              ),
            ),
          );
          control.value = current;
          control.title =
            result.note || `${result.models.length} models available`;
          control.parentElement
            ?.querySelector(".model-discovery-error")
            ?.remove();
        } catch (error) {
          if (version !== requestVersion) return;
          control.title = errorText(error);
          if (control.parentElement) {
            let note = control.parentElement.querySelector(
              ".model-discovery-error",
            );
            if (!note) {
              note = el("span", {
                class: "field-description model-discovery-error",
                role: "status",
              });
              control.parentElement.append(note);
            }
            note.textContent = errorText(error);
          }
        }
      };
      queueMicrotask(() => void control.loadModels());
    }
    if (
      integration.id === "apple-tv" &&
      ["remoteEntity", "mediaPlayerEntity", "cameraEntity"].includes(f.key)
    ) {
      control = el(
        "select",
        { name: f.key },
        el(
          "option",
          { value: "" },
          f.key === "cameraEntity"
            ? "Use controller’s existing feed"
            : f.key === "remoteEntity"
              ? "Choose a remote"
              : "No media player",
        ),
        ...(value
          ? [el("option", { value, selected: true }, `${value} (saved)`)]
          : []),
      );
      queueMicrotask(async () => {
        try {
          const ha = state.data.homeAssistant;
          if (!ha?.enabled)
            throw Error("Enable Home Assistant to discover TV devices.");
          const result = await read("/api/home-assistant/entities");
          const domain =
            f.key === "cameraEntity"
              ? "camera."
              : f.key === "remoteEntity"
                ? "remote."
                : "media_player.";
          const devices = result.entities.filter((e) =>
            e.entity_id.startsWith(domain),
          );
          const current = control.value;
          control.replaceChildren(
            el(
              "option",
              { value: "" },
              f.key === "cameraEntity"
                ? "Use controller’s existing feed"
                : f.key === "remoteEntity"
                  ? "Choose a remote"
                  : "No media player",
            ),
            ...devices.map((e) =>
              el(
                "option",
                { value: e.entity_id },
                `${e.name || e.entity_id} (${e.entity_id})`,
              ),
            ),
          );
          if (current && !devices.some((e) => e.entity_id === current))
            control.append(
              el("option", { value: current }, `${current} (unavailable)`),
            );
          control.value = current;
          if (!devices.length)
            control.parentElement?.append(
              el(
                "span",
                { class: "field-description" },
                "No matching Home Assistant devices found.",
              ),
            );
        } catch (error) {
          control.parentElement?.append(
            el(
              "span",
              { class: "field-description", role: "status" },
              errorText(error),
            ),
          );
        }
      });
    }
    if (
      [
        "voice__inputDevice",
        "speech__localDevice",
        "speech__mediaPlayer",
      ].includes(f.key)
    ) {
      control = el(
        "select",
        { name: f.key },
        el("option", { value: "" }, "Choose a device"),
        ...(value
          ? [el("option", { value, selected: true }, `${value} (saved)`)]
          : []),
      );
      queueMicrotask(async () => {
        try {
          let options;
          if (f.key === "speech__mediaPlayer") {
            const ha = state.data.homeAssistant;
            if (!ha?.enabled)
              throw Error("Enable Home Assistant to choose an HA speaker.");
            const result = await read("/api/home-assistant/entities");
            options = result.entities
              .filter(
                (e) =>
                  e.entity_id.startsWith("media_player.") &&
                  ha.config?.controlled?.includes(e.entity_id),
              )
              .map((e) => ({
                value: e.entity_id,
                label: e.name || e.entity_id,
              }));
          } else {
            const result = await read(
              `/api/integrations/${integration.id}/audio-devices`,
            );
            options =
              f.key === "voice__inputDevice" ? result.inputs : result.outputs;
            if (result.warning) control.title = result.warning;
          }
          const current = control.value;
          control.replaceChildren(
            el("option", { value: "" }, "Choose a device"),
            ...options.map((o) => el("option", { value: o.value }, o.label)),
          );
          if (current && !options.some((o) => o.value === current))
            control.append(
              el("option", { value: current }, "Saved device (unavailable)"),
            );
          control.value = current;
        } catch (error) {
          control.parentElement?.append(
            el(
              "span",
              { class: "field-description", role: "status" },
              errorText(error),
            ),
          );
        }
      });
    }
    return control;
  };
}
