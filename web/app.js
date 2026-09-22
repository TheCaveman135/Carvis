import {
  $,
  el,
  icon,
  button,
  iconButton,
  brand,
  toast,
  errorText,
  field,
  input,
  formNotice,
  sourceUrl,
} from "./ui.js";
import { createApi } from "./api.js";
import { createChatView } from "./chat.js";
import { createIntegrationViews } from "./integrations.js";
import { createSettingsView } from "./settings.js";
import { createHomeViews } from "./home.js";

const app = $("#app");
const modal = $("#modal");
const state = {
  data: null,
  bootstrap: null,
  page: "chat",
  conversation: null,
  activeId: null,
  sending: false,
  controller: null,
  status: "",
  confirmations: [],
  drafts: new Map(),
  navVersion: 0,
};
const api = createApi({
  onUnauthorized() {
    if (!state.data) return;
    state.data = null;
    renderAuth(false);
  },
});
// Views share application state, while navigation and authentication stay here.
const context = {
  state,
  api,
  act,
  displayName,
  assistantName,
  renderShell,
  route,
  navigate,
  refreshState,
  openModal,
  modal,
};
const { renameConversation, deleteConversation, renderChat } =
  createChatView(context);
const { renderIntegrations, renderIntegrationDetail, configureIntegration } =
  createIntegrationViews(context);
const { renderSettings } = createSettingsView(context);
const { renderVoiceConversations, renderHomeSettings, renderHome } =
  createHomeViews({ ...context, configureIntegration });

async function act(action) {
  try {
    return await action();
  } catch (error) {
    toast(errorText(error), true);
  }
}
async function refreshState() {
  state.data = await api("/api/state");
  // Update persistent chrome without rebuilding forms or losing unsaved input.
  const profileName = $(".profile-name");
  if (profileName) profileName.textContent = displayName();
  const avatar = $(".profile-row .avatar");
  if (avatar) avatar.textContent = displayName().slice(0, 2).toUpperCase();
  const pill = $(".connection-pill");
  if (pill) {
    const name = state.data.model?.model;
    pill.title = name
      ? `Configured model: ${name}`
      : "Choose a model in Settings";
    pill.replaceChildren(
      el("span", { class: `status-dot${name ? "" : " off"}` }),
      document.createTextNode(name || "Model not configured"),
    );
  }
  const integrationCount = $(".nav-count");
  if (integrationCount)
    integrationCount.textContent = String(
      (state.data.integrations || []).filter((item) => item.enabled).length,
    );
}
function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}
function displayName() {
  return state.data?.profile?.displayName || "You";
}
function assistantName() {
  return state.data?.profile?.assistantName || "Carvis";
}

function openModal(title, description, body) {
  modal.classList.remove("integration-settings-modal");
  if (modal.open) modal.close();
  modal.replaceChildren(
    el(
      "div",
      { class: "modal-header" },
      el(
        "div",
        {},
        el("h2", { id: "modal-title" }, title),
        description ? el("p", {}, description) : null,
      ),
      iconButton("Close dialog", "close", () => modal.close()),
    ),
    el("div", { class: "modal-body" }, body),
  );
  modal.showModal();
}
modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    const r = modal.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      modal.close();
  }
});

async function boot() {
  try {
    state.bootstrap = await api("/api/bootstrap");
    if (state.bootstrap.setupRequired || !state.bootstrap.authenticated)
      return renderAuth(state.bootstrap.setupRequired);
    await refreshState();
    await route();
  } catch (error) {
    app.replaceChildren(
      el(
        "div",
        { class: "boot" },
        el("span", { class: "brand-mark" }, "c"),
        el("p", {}, errorText(error)),
        button("Try again", boot, "", "refresh"),
      ),
    );
  }
}
function renderAuth(setup) {
  const username = input("username", "", "text", {
    required: true,
    autocomplete: "username",
    placeholder: "Your username",
    maxlength: 80,
  });
  const password = input("password", "", "password", {
    required: true,
    autocomplete: setup ? "new-password" : "current-password",
    minlength: setup ? 12 : 1,
    placeholder: setup ? "At least 12 characters" : "Your password",
  });
  const name = input("displayName", "", "text", {
    autocomplete: "given-name",
    placeholder: "What should we call you?",
    maxlength: 80,
  });
  const feedback = el("div");
  const submit = el(
    "button",
    { class: "button primary", type: "submit" },
    setup ? "Create your space" : "Sign in",
    icon("arrow"),
  );
  const form = el(
    "form",
    {
      class: "auth-form",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        feedback.replaceChildren();
        try {
          await api(setup ? "/api/setup" : "/api/login", {
            method: "POST",
            body: {
              username: username.value,
              password: password.value,
              ...(setup ? { displayName: name.value } : {}),
            },
          });
          password.value = "";
          await refreshState();
          await route();
        } catch (error) {
          formNotice(feedback, errorText(error));
        } finally {
          submit.disabled = false;
        }
      },
    },
    el(
      "div",
      { class: "eyebrow" },
      setup ? "MAKE YOURSELF AT HOME" : "WELCOME BACK",
    ),
    el("h2", {}, setup ? "Start with you." : "Your space awaits."),
    el(
      "p",
      {},
      setup
        ? "Create your owner account, then connect Home Assistant and choose your devices."
        : "Sign in to pick up where you left off.",
    ),
    setup ? field("Your name", name) : null,
    field("Username", username),
    field(
      "Password",
      password,
      setup
        ? "Use a unique password to protect your conversations and connected devices."
        : null,
    ),
    feedback,
    submit,
    el(
      "p",
      { class: "auth-note" },
      "Your account belongs to this Carvis installation.",
    ),
  );
  app.replaceChildren(
    el(
      "div",
      { class: "auth-shell" },
      el(
        "section",
        { class: "auth-story" },
        brand(),
        el(
          "div",
          { class: "auth-story-content" },
          el("div", { class: "eyebrow" }, "YOUR HOME. YOUR WAY."),
          el(
            "h1",
            {},
            "A little more capable.",
            el("br"),
            el("span", {}, "Entirely yours."),
          ),
          el(
            "p",
            {},
            "Your home, connected. Set up Carvis to understand your devices, respond to requests, and help with everyday routines.",
          ),
          el(
            "div",
            { class: "auth-points" },
            el("span", {}, icon("lock"), "Your installation"),
            el("span", {}, icon("grid"), "Your integrations"),
            el("span", {}, icon("spark"), "Your personality"),
          ),
        ),
        el(
          "div",
          { class: "auth-footer" },
          "CARVIS / YOUR SMART HOME · ",
          el(
            "a",
            { href: sourceUrl, target: "_blank", rel: "noopener noreferrer" },
            "Source code",
          ),
        ),
      ),
      el(
        "section",
        {
          class: "auth-form-wrap",
          "aria-label": setup ? "Create owner account" : "Sign in",
        },
        form,
      ),
    ),
  );
}

const mobileNavigation = window.matchMedia("(max-width: 760px)");
function setNavigationState(shell, requestedOpen = false) {
  if (!shell) return;
  const sidebar = $(".sidebar", shell),
    main = $(".main-wrap", shell),
    opener = $(".mobile-menu", shell);
  if (!sidebar || !main || !opener) return;
  const mobile = mobileNavigation.matches,
    open = mobile && requestedOpen;
  shell.classList.toggle("menu-open", open);
  opener.setAttribute("aria-expanded", String(open));
  if (open) {
    sidebar.inert = false;
    sidebar.removeAttribute("aria-hidden");
    // Move focus before excluding the covered content from the accessibility tree.
    $(".mobile-close", shell)?.focus();
    main.inert = true;
    main.setAttribute("aria-hidden", "true");
  } else {
    main.inert = false;
    main.removeAttribute("aria-hidden");
    if (mobile && sidebar.contains(document.activeElement)) opener.focus();
    sidebar.inert = mobile;
    if (mobile) sidebar.setAttribute("aria-hidden", "true");
    else {
      sidebar.removeAttribute("aria-hidden");
      if (document.activeElement?.classList.contains("mobile-close")) {
        (
          $('.nav-item[aria-current="page"]', sidebar) || $(".brand", sidebar)
        )?.focus();
      }
    }
  }
}
mobileNavigation.addEventListener("change", () =>
  setNavigationState($(".app-shell"), false),
);
window.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !modal.open &&
    mobileNavigation.matches &&
    $(".app-shell.menu-open")
  ) {
    event.preventDefault();
    setNavigationState($(".app-shell"), false);
  }
});

function renderShell() {
  const integrations = state.data.integrations || [];
  const shell = el("div", { class: "app-shell" });
  const closeMenu = () => setNavigationState(shell, false);
  const nav = el(
    "nav",
    { class: "nav", "aria-label": "Main navigation" },
    ...[
      ["home", "Home", "home"],
      ["chat", "Conversations", "chat"],
      ...(integrations.some((i) => i.id === "voice" && i.enabled)
        ? [["voice-conversations", "Voice Conversations", "chat"]]
        : []),
      ["integrations", "Integrations", "grid"],
      ["settings", "Settings", "settings"],
    ].map(([id, label, symbol]) =>
      el(
        "a",
        {
          href: `#${id}`,
          class: `nav-item${state.page === id ? " active" : ""}`,
          "aria-current": state.page === id ? "page" : null,
          onclick: closeMenu,
        },
        icon(symbol),
        label,
        id === "integrations"
          ? el(
              "span",
              { class: "nav-count" },
              String(integrations.filter((i) => i.enabled).length),
            )
          : null,
      ),
    ),
  );
  const history = el(
    "div",
    { class: "history" },
    el("div", { class: "section-label" }, "RECENT CONVERSATIONS"),
  );
  const conversations = (state.data.conversations || []).filter(
    (c) => c.channel !== "voice",
  );
  if (!conversations.length)
    history.append(
      el(
        "p",
        { class: "history-empty" },
        "Your recent requests and replies will appear here.",
      ),
    );
  for (const conversation of conversations)
    history.append(
      el(
        "div",
        {
          class: `conversation-row${state.activeId === conversation.id ? " active" : ""}`,
        },
        el(
          "a",
          {
            class: "conversation-link",
            href: `#chat/${encodeURIComponent(conversation.id)}`,
            title: conversation.title,
            onclick: closeMenu,
          },
          conversation.title || "New conversation",
        ),
        iconButton("Rename conversation", "edit", () =>
          renameConversation(conversation),
        ),
        iconButton("Delete conversation", "trash", () =>
          deleteConversation(conversation),
        ),
      ),
    );
  const sidebar = el(
    "aside",
    { class: "sidebar", "aria-label": "Workspace" },
    brand(),
    el(
      "button",
      {
        type: "button",
        class: "icon-button mobile-close",
        "aria-label": "Close navigation",
        onclick: closeMenu,
      },
      icon("close"),
    ),
    button(
      "Ask Carvis",
      () => {
        closeMenu();
        navigate("chat");
      },
      "primary new-chat",
      "plus",
    ),
    nav,
    history,
    el(
      "div",
      { class: "sidebar-bottom" },
      el(
        "a",
        {
          class: "source-link",
          href: sourceUrl,
          target: "_blank",
          rel: "noopener noreferrer",
        },
        "Source code · AGPL 3.0",
      ),
      el(
        "div",
        { class: "profile-row" },
        el(
          "span",
          { class: "avatar", "aria-hidden": true },
          displayName().slice(0, 2).toUpperCase(),
        ),
        el(
          "div",
          { class: "profile-copy" },
          el("div", { class: "profile-name" }, displayName()),
          el(
            "div",
            { class: "profile-description" },
            state.data.homeAssistant?.config?.homeName || "Your home",
          ),
        ),
        iconButton("Sign out", "exit", () =>
          act(async () => {
            if (state.controller) state.controller.abort();
            await api("/api/logout", { method: "POST" });
            state.data = null;
            renderAuth(false);
          }),
        ),
      ),
    ),
  );
  const title =
    state.page === "home"
      ? state.data.homeAssistant?.config?.homeName || "Home"
      : state.page === "home-setup"
        ? "Set up your home"
        : state.page === "voice-conversations"
          ? "Voice Conversations"
          : state.page === "integrations"
            ? "Integrations"
            : state.page === "settings"
              ? "Settings"
              : state.conversation?.title || "New conversation";
  const model = state.data.model || {};
  const topbar = el(
    "header",
    { class: "topbar" },
    el(
      "div",
      { class: "topbar-left" },
      el(
        "button",
        {
          type: "button",
          class: "icon-button mobile-menu",
          "aria-label": "Open navigation",
          "aria-expanded": "false",
          onclick: () => setNavigationState(shell, true),
        },
        icon("menu"),
      ),
      el(
        "div",
        { class: "breadcrumb" },
        el("span", { class: "crumb-brand" }, "Your home"),
        el("span", { class: "sep" }, "/"),
        el("strong", {}, title),
      ),
    ),
    el(
      "div",
      {
        class: "connection-pill",
        title: model.model
          ? `Configured model: ${model.model}`
          : "Choose a model in Settings",
      },
      el("span", { class: `status-dot${model.model ? "" : " off"}` }),
      model.model || "Model not configured",
    ),
  );
  const main = el("main", { id: "main", tabindex: "-1" });
  shell.append(
    sidebar,
    el("button", {
      class: "menu-backdrop",
      "aria-label": "Close navigation",
      onclick: closeMenu,
      tabindex: "-1",
    }),
    el("div", { class: "main-wrap" }, topbar, main),
  );
  app.replaceChildren(shell);
  setNavigationState(shell, false);
  document.title = `${title} · Carvis`;
  return main;
}
async function route() {
  if (!state.data) return;
  state.integrationCleanup?.();
  state.integrationCleanup = null;
  const version = ++state.navVersion;
  const [page, encodedId, section] = location.hash.replace(/^#/, "").split("/");
  state.page = [
    "home",
    "chat",
    "integrations",
    "settings",
    "voice-conversations",
  ].includes(page)
    ? page
    : "home";
  if (state.data.homeSetupRequired) state.page = "home-setup";
  if (page === "integrations" && encodedId === "home-assistant") {
    navigate("settings/home-assistant");
    return;
  }
  let requestedId = null;
  try {
    requestedId = encodedId ? decodeURIComponent(encodedId) : null;
  } catch {
    /* Invalid route is treated as a new conversation. */
  }
  if (state.page === "chat" && requestedId && requestedId !== state.activeId) {
    try {
      const conversation = await api(
        `/api/conversations/${encodeURIComponent(requestedId)}`,
      );
      if (version !== state.navVersion) return;
      state.conversation = conversation;
      state.activeId = conversation.id;
    } catch (error) {
      if (version !== state.navVersion || !state.data) return;
      state.conversation = null;
      state.activeId = null;
      toast(errorText(error), true);
    }
  } else if (state.page === "chat" && !requestedId) {
    state.conversation = null;
    state.activeId = null;
  }
  const main = renderShell();
  if (state.page === "integrations") {
    if (requestedId)
      await renderIntegrationDetail(
        main,
        requestedId,
        section || "overview",
        version,
      );
    else renderIntegrations(main);
  } else if (state.page === "home-setup") renderHomeSettings(main, true);
  else if (state.page === "home") renderHome(main);
  else if (state.page === "settings" && requestedId === "home-assistant")
    renderHomeSettings(main, false);
  else if (state.page === "settings") renderSettings(main);
  else if (state.page === "voice-conversations") renderVoiceConversations(main);
  else renderChat(main);
}
window.addEventListener("hashchange", () => act(route));

boot();
