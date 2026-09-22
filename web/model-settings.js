import { el, input, field, errorText, formNotice } from "./ui.js";

/** Provider connection, model discovery, and saved-key controls. */
export function renderModelSettings({ state, api, refreshState }) {
  const model = state.data.model || {};
  const provider = el(
    "select",
    { name: "provider" },
    [
      ["openai", "OpenAI"],
      ["compatible", "OpenAI-compatible provider"],
      ["ollama", "Ollama"],
    ].map(([value, label]) =>
      el(
        "option",
        { value, selected: (model.provider || "openai") === value },
        label,
      ),
    ),
  );
  const baseUrl = input("baseUrl", model.baseUrl || "", "url", {
    placeholder: "https://api.example.com/v1",
  });
  const modelName = input("model", model.model || "", "text", {
    required: true,
    placeholder: "Model ID from your provider",
    maxlength: 120,
  });
  const apiKey = input("apiKey", "", "password", {
    autocomplete: "new-password",
    placeholder: model.hasApiKey
      ? "Saved · leave blank to keep"
      : "Paste your API key",
  });
  const modelSelect = el(
    "select",
    { "aria-label": "Model" },
    el("option", { value: "" }, "Available models appear here"),
    el("option", { value: "__custom" }, "Enter a custom model ID…"),
  );
  const customModel = field(
    "Custom model ID",
    modelName,
    "Use this if your provider does not list models.",
  );
  modelSelect.value = model.model ? "__custom" : "";
  customModel.hidden = !model.model;
  modelName.required = !!model.model;
  const modelListStatus = el(
    "p",
    { class: "field-description", role: "status" },
    "Enter your API key to see available models automatically.",
  );
  let modelListVersion = 0;
  const loadModels = async () => {
    const version = ++modelListVersion;
    modelListStatus.textContent = "Loading available models…";
    try {
      const result = await api("/api/models", {
        method: "POST",
        body: {
          provider: provider.value,
          baseUrl:
            provider.value === "openai"
              ? "https://api.openai.com/v1"
              : baseUrl.value,
          apiKey: apiKey.value,
          clearApiKey: clearKey.checked,
        },
      });
      if (version !== modelListVersion) return;
      modelSelect.replaceChildren(
        el("option", { value: "" }, "Choose a model"),
        ...result.models.map((id) => el("option", { value: id }, id)),
        el("option", { value: "__custom" }, "Enter a custom model ID…"),
      );
      modelSelect.value = result.models.includes(modelName.value)
        ? modelName.value
        : modelName.value
          ? "__custom"
          : "";
      customModel.hidden = modelSelect.value !== "__custom";
      modelName.required = !customModel.hidden;
      modelListStatus.textContent = result.models.length
        ? `${result.models.length} models available. Choose a chat model; the provider may also list image and audio models.`
        : "No models returned. You can enter a custom ID.";
    } catch (error) {
      if (version === modelListVersion)
        modelListStatus.textContent = errorText(error);
    }
  };
  modelSelect.addEventListener("change", () => {
    customModel.hidden = modelSelect.value !== "__custom";
    modelName.required = !customModel.hidden;
    if (modelSelect.value !== "__custom") modelName.value = modelSelect.value;
  });
  const invalidateModels = () => {
    modelListVersion++;
    modelSelect.replaceChildren(
      el("option", { value: "" }, "Available models appear here"),
      el("option", { value: "__custom" }, "Enter a custom model ID…"),
    );
    modelSelect.value = "";
    modelName.value = "";
    customModel.hidden = true;
    modelName.required = false;
    modelListStatus.textContent = "Waiting for connection details…";
  };
  let discoveryTimer;
  const scheduleModels = () => {
    clearTimeout(discoveryTimer);
    modelListVersion++;
    const ready =
      provider.value === "openai"
        ? Boolean(
            apiKey.value ||
              (model.hasApiKey &&
                model.provider === "openai" &&
                !clearKey.checked),
          )
        : Boolean(baseUrl.value);
    if (!ready) {
      modelListStatus.textContent =
        "Enter your connection details to see available models.";
      return;
    }
    discoveryTimer = setTimeout(() => {
      if (modelSelect.isConnected) void loadModels();
    }, 700);
  };
  provider.addEventListener("change", () => {
    invalidateModels();
    queueMicrotask(scheduleModels);
  });
  baseUrl.addEventListener("input", () => {
    invalidateModels();
    scheduleModels();
  });
  apiKey.addEventListener("input", scheduleModels);
  const baseField = field(
    "API base URL",
    baseUrl,
    "Use the API endpoint provided by your model service.",
  );
  const keyField = field(
    "API key",
    apiKey,
    "Stored on your Carvis server. Changing the provider or API URL clears the saved key unless you enter a new one.",
  );
  const clearKey = input("clearApiKey", "", "checkbox");
  const clearField = el(
    "label",
    { class: "field checkbox" },
    clearKey,
    el("span", { class: "field-label" }, "Remove saved API key"),
  );
  clearField.hidden = !model.hasApiKey;
  clearKey.addEventListener("change", scheduleModels);
  const syncKeyPlaceholder = () => {
    const normalize = (value) => {
      try {
        return new URL(value).toString().replace(/\/+$/, "");
      } catch {
        return String(value).trim();
      }
    };
    const nextUrl =
      provider.value === "openai" ? "https://api.openai.com/v1" : baseUrl.value;
    const sameConnection =
      provider.value === model.provider &&
      normalize(nextUrl) === normalize(model.baseUrl);
    apiKey.placeholder =
      model.hasApiKey && sameConnection
        ? "Saved · leave blank to keep"
        : model.hasApiKey
          ? "Enter a key for this connection"
          : "Paste your API key";
  };
  baseUrl.addEventListener("input", syncKeyPlaceholder);
  const syncProvider = () => {
    baseField.hidden = provider.value === "openai";
    baseUrl.required = provider.value !== "openai";
    baseUrl.placeholder =
      provider.value === "ollama"
        ? "http://127.0.0.1:11434/v1"
        : "https://api.example.com/v1";
    keyField.hidden = provider.value === "ollama";
    syncKeyPlaceholder();
  };
  provider.addEventListener("change", () => {
    if (provider.value !== model.provider) baseUrl.value = "";
    syncProvider();
  });
  syncProvider();
  const modelFeedback = el("div");
  const saveModel = el(
    "button",
    { type: "submit", class: "button primary" },
    "Save model",
  );
  const modelForm = el(
    "form",
    {
      class: "settings-card",
      onsubmit: async (event) => {
        event.preventDefault();
        if (!modelName.value || !modelSelect.value) {
          formNotice(modelFeedback, "Choose a model or enter a custom ID.");
          return;
        }
        saveModel.disabled = true;
        try {
          const update = {
            provider: provider.value,
            baseUrl:
              provider.value === "openai"
                ? "https://api.openai.com/v1"
                : baseUrl.value,
            model:
              modelSelect.value === "__custom"
                ? modelName.value
                : modelSelect.value,
          };
          if (apiKey.value) update.apiKey = apiKey.value;
          if (clearKey.checked) update.clearApiKey = true;
          await api("/api/settings", {
            method: "POST",
            body: { model: update },
          });
          apiKey.value = "";
          await refreshState();
          Object.assign(model, state.data.model);
          syncKeyPlaceholder();
          clearField.hidden = !state.data.model.hasApiKey;
          clearKey.checked = false;
          formNotice(
            modelFeedback,
            "Model settings saved. Start a conversation to use them.",
            true,
          );
        } catch (error) {
          formNotice(modelFeedback, errorText(error));
        } finally {
          saveModel.disabled = false;
        }
      },
    },
    el("h2", {}, "Choose your model"),
    el(
      "p",
      {},
      "Bring your preferred AI provider, or connect a local model. You stay in control of the connection.",
    ),
    field("Provider", provider),
    baseField,
    keyField,
    field("Model", modelSelect),
    modelListStatus,
    customModel,
    clearField,
    modelFeedback,
    saveModel,
  );
  if (model.hasApiKey || model.provider === "ollama")
    queueMicrotask(scheduleModels);

  return modelForm;
}
