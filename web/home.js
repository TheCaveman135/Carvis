import { el, button, errorText, formNotice, pageHeading } from "./ui.js";
import { entityStateDisplay } from "./entity-state.js";
import { mountVoiceControls } from "./voice-controls.js";
import { mountVoiceConfirmation } from "./voice-confirmation.js";

export function createHomeViews({
  state,
  api,
  refreshState,
  navigate,
  configureIntegration,
}) {
  function renderVoiceConversations(main) {
    const voiceControls = mountVoiceControls({ el, button, api });
    const voiceConfirmation = mountVoiceConfirmation({ api });
    const list = el("div", { class: "voice-history-list" }),
      messages = el("div", {
        class: "voice-history-messages",
        "aria-live": "polite",
      });
    let selected = null,
      disposed = false,
      busy = false,
      last = "";
    main.append(
      el(
        "section",
        { class: "voice-history-page" },
        el("h1", {}, "Voice Conversations"),
        el(
          "p",
          { class: "muted" },
          "Your spoken requests and Carvis’s replies. Updates automatically; a new conversation starts after 10 minutes of quiet.",
        ),
        voiceControls.root,
        voiceConfirmation.root,
        el("div", { class: "voice-history" }, list, messages),
      ),
    );
    const render = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        const result = await api("/api/voice-conversations");
        if (disposed) return;
        const conversations = result.conversations;
        if (!conversations.some((c) => c.id === selected))
          selected = conversations[0]?.id;
        const signature = JSON.stringify([selected, conversations]);
        if (signature === last) return;
        last = signature;
        list.replaceChildren(
          ...conversations.map((c) =>
            button(
              c.title,
              () => {
                selected = c.id;
                last = "";
                void render();
              },
              c.id === selected ? "primary" : "quiet",
            ),
          ),
        );
        const current = conversations.find((c) => c.id === selected);
        if (!current) {
          messages.replaceChildren(
            el(
              "p",
              { class: "muted" },
              "No voice conversations yet. Choose a microphone above and unmute it to start.",
            ),
          );
          return;
        }
        const nearBottom =
          messages.scrollHeight - messages.scrollTop - messages.clientHeight <
          100;
        messages.replaceChildren(
          el(
            "div",
            { class: "voice-history-header" },
            el("h2", {}, current.title),
            button(
              "Delete",
              async () => {
                if (!confirm("Delete this voice conversation?")) return;
                await api(
                  `/api/conversations/${encodeURIComponent(current.id)}`,
                  { method: "DELETE" },
                );
                last = "";
                await render();
              },
              "quiet",
            ),
          ),
          ...current.messages.map((m) =>
            el(
              "article",
              { class: `voice-history-message ${m.role}` },
              el("strong", {}, m.role === "user" ? "You" : "Carvis"),
              el(
                "small",
                { class: "muted" },
                new Date(m.createdAt).toLocaleTimeString(),
              ),
              el("p", { style: "white-space:pre-wrap" }, m.content),
              m.voiceStatus
                ? el("small", { class: "muted" }, m.voiceStatus)
                : null,
            ),
          ),
        );
        if (nearBottom) messages.scrollTop = messages.scrollHeight;
      } catch (error) {
        if (!disposed)
          messages.replaceChildren(
            el("p", { role: "status" }, errorText(error)),
          );
      } finally {
        busy = false;
      }
    };
    void render();
    const timer = setInterval(() => void render(), 2000);
    state.integrationCleanup = () => {
      disposed = true;
      clearInterval(timer);
      voiceControls.dispose();
      voiceConfirmation.dispose();
    };
  }

  function renderHomeSettings(main, onboarding = false) {
    const home = state.data.homeAssistant;
    if (!home) {
      main.append(el("p", {}, "Home settings are unavailable."));
      return;
    }
    const content = el("div"),
      feedback = el("div");
    main.replaceChildren(
      el(
        "section",
        { class: "page" },
        pageHeading(
          onboarding ? "WELCOME HOME" : "HOME SETTINGS",
          onboarding ? "Connect your smart home" : "Home Assistant",
          onboarding
            ? "Name your home, connect Home Assistant, then choose the entities Carvis may see and control. Your token is stored privately."
            : "Manage your connection, entities, and device guards.",
        ),
        content,
        feedback,
      ),
    );
    configureIntegration(home, content, { inline: true, onboarding });
    if (onboarding) {
      const clearSetupError = () => feedback.replaceChildren();
      content.addEventListener("input", clearSetupError);
      content.addEventListener("change", clearSetupError);
      content.after(
        button(
          "Finish home setup",
          async () => {
            try {
              const status = content.querySelector(
                '.modal-footer [role="status"]',
              );
              if (
                status &&
                /saving|unsaved|not saved/i.test(status.textContent)
              )
                throw Error(
                  "Wait for your changes to save before finishing setup.",
                );
              await api("/api/home-assistant/complete", {
                method: "POST",
                body: {},
              });
              await refreshState();
              navigate("home");
            } catch (error) {
              formNotice(feedback, errorText(error));
            }
          },
          "primary",
        ),
      );
    }
  }

  function renderHome(main) {
    const home = state.data.homeAssistant,
      cfg = home?.config || {};
    const devices = el("div", { class: "home-device-grid" }),
      feedback = el("p", { class: "muted", role: "status" });
    main.replaceChildren(
      el(
        "section",
        { class: "page" },
        pageHeading(
          "YOUR SMART HOME",
          cfg.homeName || "Home",
          "Check your devices, ask Carvis to take care of something, or expand what your home can do.",
        ),
        el(
          "div",
          { class: "action-row" },
          el("a", { class: "button primary", href: "#chat" }, "Ask Carvis"),
          el(
            "a",
            { class: "button", href: "#settings/home-assistant" },
            "Manage home & entities",
          ),
          el(
            "a",
            { class: "button quiet", href: "#integrations" },
            "Integrations",
          ),
        ),
        feedback,
        devices,
      ),
    );
    let stopped = false,
      busy = false;
    const refresh = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const data = await api("/api/home-assistant/entities");
        if (stopped) return;
        const observed = new Set([
          ...(cfg.observed || []),
          ...(cfg.controlled || []),
        ]);
        const selected = data.entities.filter((e) => observed.has(e.entity_id));
        feedback.textContent = `${selected.length} selected devices · ${cfg.dryRun !== false ? "Dry run is on" : "Live control enabled"}`;
        devices.replaceChildren(
          ...selected.map((e) => {
            const value = entityStateDisplay(e);
            return el(
              "article",
              { class: "control-card" },
              el("h3", {}, e.name || e.entity_id),
              el("p", { title: value.title }, value.text),
              el("small", { class: "muted" }, e.area_name || e.entity_id),
            );
          }),
        );
      } catch (error) {
        if (!stopped) feedback.textContent = errorText(error);
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    state.integrationCleanup = () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return { renderVoiceConversations, renderHomeSettings, renderHome };
}
