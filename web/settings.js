import { renderModelSettings } from "./model-settings.js";
import {
  el,
  icon,
  button,
  toast,
  errorText,
  field,
  input,
  formNotice,
  pageHeading,
} from "./ui.js";
import { modelRouterEntries } from "./model-router.js";
import { connectionPath } from "./api.js";

export function createSettingsView({ state, api, refreshState }) {
  function renderGlobalKeys(onSaved) {
    const feedback = el("div"),
      controls = [];
    const form = el(
      "form",
      { class: "settings-card full" },
      el("h2", {}, "Global API keys"),
      el(
        "p",
        {},
        "Save a service key once for integrations to reuse. Your saved OpenAI model key is shared automatically. A separate key in an integration overrides the shared key. Compatible providers keep their own key; select Main provider in Model Router to use that connection.",
      ),
    );
    for (const [id, label] of [
      ["openai", "OpenAI"],
      ["anthropic", "Anthropic"],
      ["deepgram", "Deepgram"],
      ["assemblyai", "AssemblyAI"],
      ["gemini", "Google Gemini"],
    ]) {
      const key = input(id, "", "password", {
        autocomplete: "new-password",
      });
      const clear = input(`remove-${id}`, "", "checkbox");
      const description = el("p", { class: "field-description" });
      const keyField = field(label, key);
      keyField.append(description);
      const clearField = el(
        "label",
        { class: "field checkbox" },
        clear,
        el("span", {}, `Remove shared ${label} key`),
      );
      form.append(keyField, clearField);
      controls.push({ id, key, clear, description, clearField });
    }
    form.refreshKeys = () => {
      for (const control of controls) {
        const status = state.data.apiKeys?.[control.id];
        control.key.placeholder = status?.saved
          ? "Saved · leave blank to keep"
          : "Optional API key";
        control.description.textContent = status?.saved
          ? "Shared key saved."
          : "Add only the services you use.";
        control.clearField.hidden = !status?.saved;
      }
    };
    form.refreshKeys();
    const save = el(
      "button",
      { class: "button primary", type: "submit" },
      "Save API keys",
    );
    form.append(feedback, save);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        const apiKeys = Object.fromEntries(
          controls
            .filter((c) => c.clear.checked || c.key.value.trim())
            .map((c) => [c.id, c.clear.checked ? null : c.key.value.trim()]),
        );
        await api("/api/settings", { method: "POST", body: { apiKeys } });
        await refreshState();
        for (const control of controls) {
          control.key.value = "";
          control.clear.checked = false;
        }
        form.refreshKeys();
        onSaved();
        toast("Global API keys saved.");
      } catch (error) {
        formNotice(feedback, errorText(error));
      } finally {
        save.disabled = false;
      }
    });
    return form;
  }

  function renderModelRouter() {
    const refreshModels = [];
    const card = el(
      "section",
      { class: "settings-card full" },
      el("h2", {}, "Model Router"),
      el(
        "p",
        {},
        "Models for enabled integrations. Expand a row to change its choices.",
      ),
    );
    const entries = modelRouterEntries(state.data.integrations || []);
    if (!entries.length)
      card.append(
        el(
          "p",
          { class: "small muted" },
          "Enable an integration that uses AI to see its model controls here.",
        ),
        el(
          "a",
          { class: "button quiet", href: "#integrations" },
          "Browse integrations",
        ),
      );
    const engine = (state.data.integrations || []).find(
      (i) => i.id === "assistant-engine",
    );
    const providers =
      engine?.config?.models__providers ||
      engine?.fields?.find((f) => f.key === "models__providers")?.default ||
      [];
    for (const { integration, fields, note } of entries) {
      const cfg = integration.config || {},
        updates = [],
        feedback = el("div");
      const form = el("form", { class: "router-settings" });
      const modelSummary = el("span", { class: "router-summary" });
      const updateSummary = () => {
        const models = [
          ...new Set(
            fields
              .map((f) => integration.config?.[f.key] || "")
              .filter(Boolean),
          ),
        ];
        modelSummary.textContent = models.length
          ? models.join(" · ")
          : fields.length
            ? `${fields.length} model ${fields.length === 1 ? "role" : "roles"} · not configured`
            : "Shared or external model";
      };
      updateSummary();
      const row = el(
        "details",
        { class: "router-integration" },
        el(
          "summary",
          {},
          el("span", { class: "router-name" }, integration.name),
          modelSummary,
        ),
        form,
      );
      if (note) form.append(el("p", { class: "small muted" }, note));
      for (const definition of fields) {
        const roleFields = el("div", { class: "router-role" });
        const providerKey = definition.key.startsWith("models__roles__")
          ? definition.key.replace(/__model$/, "__provider")
          : null;
        const providerField = integration.fields.find(
          (f) => f.key === providerKey,
        );
        const savedProvider = providerField
          ? (cfg[providerKey] ?? providerField.default)
          : null;
        const current = cfg[definition.key] ?? definition.default ?? "";
        const label = definition.label || definition.key;
        const select = el("select", {
          "aria-label": `${integration.name}: ${label}`,
        });
        let modelValue = current;
        const status = el("p", { class: "small muted", role: "status" });
        let revision = 0;
        const populate = (models = []) => {
          const value = modelValue;
          const choices = [...new Set([...(value ? [value] : []), ...models])];
          select.replaceChildren(
            el("option", { value: "" }, "Service default / not set"),
            ...choices.map((id) =>
              el(
                "option",
                { value: id },
                models.includes(id) ? id : `${id} (saved)`,
              ),
            ),
          );
          select.value = value;
        };
        select.addEventListener("change", () => {
          modelValue = select.value;
        });
        let providerSelect;
        const discover = async () => {
          const version = ++revision;
          populate();
          status.textContent = "Loading available models…";
          try {
            const result = await api("/api/integration-models", {
              method: "POST",
              body: {
                integrationId: integration.id,
                field: definition.key,
                providerId: providerSelect?.value,
              },
            });
            if (version !== revision) return;
            populate(result.models);
            status.textContent = result.note || "";
          } catch (error) {
            if (version === revision) status.textContent = errorText(error);
          }
        };
        refreshModels.push(discover);
        if (providerField) {
          const options = new Map([
            ["carvis-primary", "Main provider (from Carvis Settings)"],
            ...providers.map((p) => [p.id, p.label || p.id]),
          ]);
          if (savedProvider && !options.has(savedProvider))
            options.set(savedProvider, savedProvider);
          providerSelect = el(
            "select",
            { "aria-label": `${integration.name}: ${label} provider` },
            ...Array.from(options, ([value, text]) =>
              el("option", { value }, text),
            ),
          );
          providerSelect.value = savedProvider || "carvis-primary";
          providerSelect.addEventListener("change", () => {
            modelValue = "";
            void discover();
          });
          roleFields.append(field("Provider", providerSelect));
        }
        roleFields.append(field("Model", select));
        form.append(
          el(
            "section",
            { class: "router-role-section" },
            el(
              "h4",
              {},
              label.replace(/: model$/i, "").replace(/^Model$/, "Local model"),
            ),
            roleFields,
            status,
          ),
        );
        updates.push(() => ({
          [definition.key]: modelValue.trim(),
          ...(providerSelect ? { [providerKey]: providerSelect.value } : {}),
        }));
        void discover();
      }
      form.append(
        el(
          "a",
          { href: `#integrations/${integration.id}/settings`, class: "small" },
          "Connection and advanced settings",
        ),
      );
      if (fields.length) {
        const save = el(
          "button",
          { type: "submit", class: "button" },
          "Save models",
        );
        form.append(feedback, save);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          save.disabled = true;
          try {
            await api(connectionPath(integration.id), {
              method: "PUT",
              body: {
                config: Object.assign({}, ...updates.map((read) => read())),
              },
            });
            await refreshState();
            integration.config =
              state.data.integrations.find((i) => i.id === integration.id)
                ?.config || integration.config;
            updateSummary();
            formNotice(feedback, "Model routing saved.", true);
          } catch (error) {
            formNotice(feedback, errorText(error));
          } finally {
            save.disabled = false;
          }
        });
      } else form.addEventListener("submit", (event) => event.preventDefault());
      card.append(row);
    }
    card.refreshModels = () => {
      if (card.isConnected) for (const refresh of refreshModels) void refresh();
    };
    return card;
  }

  function renderSettings(main) {
    const profile = state.data.profile || {};
    const display = input("displayName", profile.displayName || "", "text", {
      placeholder: "Your name",
      maxlength: 80,
    });
    const assistant = input(
      "assistantName",
      profile.assistantName || "Carvis",
      "text",
      { required: true, maxlength: 80 },
    );
    const personality = el(
      "textarea",
      {
        name: "personality",
        rows: 5,
        maxlength: 2000,
        placeholder: "How should your assistant speak and work with you?",
      },
      profile.personality || "",
    );
    const personalityPresets = [
      [
        "friendly",
        "Friendly companion",
        "Be warm, approachable, and conversational. Use everyday language, show interest without flattery, and keep replies concise unless I ask for detail. Ask a brief clarifying question when needed.",
      ],
      [
        "concise",
        "Straight to the point",
        "Be direct, practical, and brief. Lead with the answer or outcome. Skip filler and unnecessary acknowledgements. Use short steps when explaining a task, and expand only when I ask.",
      ],
      [
        "professional",
        "Professional assistant",
        "Be polished, organized, and dependable. Use a calm, professional tone and clear explanations. Summarize decisions, highlight relevant tradeoffs, and make next steps easy to follow.",
      ],
      [
        "coach",
        "Patient coach",
        "Be patient, encouraging, and practical. Break unfamiliar tasks into manageable steps. Explain the why when it helps, adapt to my experience, and ask useful questions without turning every reply into a lesson.",
      ],
      [
        "creative",
        "Creative collaborator",
        "Be curious, imaginative, and lightly playful. Help me explore ideas with concrete examples and useful alternatives. Offer your own thoughtful opinion, keep suggestions grounded, and avoid overwhelming me with options.",
      ],
      [
        "jarvis",
        "Jarvis",
        "Speak like a composed, highly capable British personal assistant: articulate, discreet, observant, and quietly witty. Use understated dry humour sparingly. Keep routine acknowledgements short and precise; explain complex matters clearly when asked. Anticipate useful next steps and offer them tactfully, without being pushy. Stay calm when things go wrong, state what happened plainly, and suggest a practical remedy. Avoid theatrical speeches, excessive deference, and repeatedly calling me sir. Never claim an action succeeded until its result confirms it.",
      ],
    ];
    const preset = el(
      "select",
      { name: "personalityPreset" },
      el("option", { value: "" }, "Custom personality"),
      ...personalityPresets.map(([value, label]) =>
        el("option", { value }, label),
      ),
    );
    const syncPreset = () => {
      preset.value =
        personalityPresets.find(
          ([, , text]) => text === personality.value,
        )?.[0] || "";
    };
    preset.addEventListener("change", () => {
      const choice = personalityPresets.find(([id]) => id === preset.value);
      if (choice) personality.value = choice[2];
      personality.dispatchEvent(new Event("input", { bubbles: true }));
    });
    personality.addEventListener("input", syncPreset);
    syncPreset();
    const profileFeedback = el("div");
    const profileStatus = el(
      "span",
      { class: "small muted", role: "status", "aria-live": "polite" },
      "Changes save automatically",
    );
    const saveProfile = el(
      "button",
      { type: "submit", class: "button primary" },
      "Save now",
    );
    const profileForm = el(
      "form",
      {
        class: "settings-card",
      },
      el("h2", {}, "Make it personal"),
      el(
        "p",
        {},
        "A name, a way of speaking, a little personality. Make this feel like your assistant.",
      ),
      el(
        "div",
        { class: "two-fields" },
        field("Your name", display),
        field("Assistant name", assistant),
      ),
      field(
        "Personality preset",
        preset,
        "Choose a starting point, then edit it below. Changes save automatically.",
      ),
      field(
        "Personality & preferences",
        personality,
        "For example: warm, concise, a little witty. Ask before making assumptions.",
      ),
      profileFeedback,
      profileStatus,
      saveProfile,
    );
    let profileBaseline = {
      displayName: profile.displayName || "",
      assistantName: profile.assistantName || "Carvis",
      personality: profile.personality || "",
    };
    let profileTimer,
      profileSaving = false,
      profileQueued = false;
    const profileValues = () => ({
      displayName: display.value,
      assistantName: assistant.value,
      personality: personality.value,
    });
    const savePreferences = async (interactive = false) => {
      clearTimeout(profileTimer);
      if (profileSaving) {
        profileQueued = true;
        return;
      }
      if (!profileForm.checkValidity()) {
        profileStatus.textContent = "Not saved — complete the highlighted fields";
        if (interactive) profileForm.reportValidity();
        return;
      }
      const snapshot = profileValues();
      if (JSON.stringify(snapshot) === JSON.stringify(profileBaseline)) {
        profileStatus.textContent = "All changes saved";
        return;
      }
      profileSaving = true;
      saveProfile.disabled = true;
      profileStatus.textContent = "Saving…";
      profileFeedback.replaceChildren();
      let saved = false;
      try {
        await api("/api/settings", {
          method: "POST",
          body: { profile: snapshot },
        });
        profileBaseline = snapshot;
        saved = true;
        await refreshState();
        profileStatus.textContent = "Saved";
      } catch (error) {
        profileStatus.textContent = "Not saved — retry";
        formNotice(profileFeedback, errorText(error));
      } finally {
        profileSaving = false;
        saveProfile.disabled = false;
        const changedWhileSaving =
          profileQueued ||
          JSON.stringify(profileValues()) !== JSON.stringify(profileBaseline);
        profileQueued = false;
        if (saved && changedWhileSaving)
          void savePreferences();
      }
    };
    const schedulePreferences = () => {
      clearTimeout(profileTimer);
      profileStatus.textContent = "Unsaved changes…";
      profileTimer = setTimeout(() => void savePreferences(), 700);
    };
    profileForm.addEventListener("input", schedulePreferences);
    profileForm.addEventListener("change", schedulePreferences);
    profileForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void savePreferences(true);
    });
    const router = renderModelRouter();
    const globalKeys = renderGlobalKeys(() => {
      modelForm.refreshModels();
      router.refreshModels();
    });
    const modelForm = renderModelSettings({
      state,
      api,
      refreshState,
      onSaved: () => {
        globalKeys.refreshKeys();
        router.refreshModels();
      },
    });
    const memoryCard = el(
      "section",
      { class: "settings-card full" },
      el("h2", {}, "Memory"),
      el(
        "p",
        {},
        "Let Carvis remember preferences and useful context. Set up and manage this feature in the Continuity Memory integration.",
      ),
      el(
        "a",
        { class: "button", href: "#integrations/learned-memory/settings" },
        "Set up Continuity Memory",
        icon("arrow"),
      ),
    );
    main.replaceChildren(
      el(
        "section",
        { class: "page" },
        pageHeading(
          "YOUR HOME, YOUR PREFERENCES",
          "Settle in.",
          "Choose how Carvis thinks, how it talks, and what it remembers about you.",
        ),
        el(
          "div",
          { class: "settings-grid" },
          el(
            "section",
            { class: "settings-card full" },
            el("h2", {}, "Home Assistant"),
            el(
              "p",
              {},
              state.data.homeAssistant?.config?.homeName || "Your smart home",
            ),
            el(
              "a",
              { class: "button", href: "#settings/home-assistant" },
              "Home connection & entities",
            ),
          ),
          profileForm,
          modelForm,
          globalKeys,
          router,
          memoryCard,
        ),
      ),
    );
  }

  return { renderSettings };
}
