"use strict";
import { modelRouterEntries } from "./model-router.js";

const $ = (selector, root = document) => root.querySelector(selector);
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
const paths = {
  search: "M21 21l-6-6M17 10a7 7 0 1 0-14 0 7 7 0 0 0 14 0Z",
  plus: "M12 5v14M5 12h14",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3ZM15.5 12a3.5 3.5 0 1 0-7 0 3.5 3.5 0 0 0 7 0Z",
  arrow: "M7 17 17 7M7 7h10v10",
  send: "M12 19V5M5 12l7-7 7 7",
  close: "m6 6 12 12M6 18 18 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  edit: "m16 3 5 5-12 12-6 1 1-6L16 3ZM14 5l5 5",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  lock: "M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
  check: "m5 12 4 4L19 6",
  book: "M12 5v16M3 3c4 0 6 0 9 2 3-2 5-2 9-2v16c-4 0-6 0-9 2-3-2-5-2-9-2V3Z",
  plan: "M8 3v4M16 3v4M3 10h18M3 5h18v16H3V5ZM7 14h3M14 14h3M7 18h3",
  home: "m3 10 9-7 9 7v11h-7v-7h-4v7H3V10Z",
  glasses: "M2 8h8v8H2zM14 8h8v8h-8zM10 11h4M2 8l2-4M22 8l-2-4",
  tv: "M3 5h18v13H3zM8 22h8M12 18v4",
  plug: "M8 3v5M16 3v5M5 8h14v4a7 7 0 0 1-14 0V8ZM12 19v3",
  exit: "M9 3H3v18h6M9 12h12m-5-5 5 5-5 5",
  stop: "M6 6h12v12H6z",
  info: "M12 17v-5M12 7v.01M22 12a10 10 0 1 0-20 0 10 10 0 0 0 20 0Z",
  copy: "M9 9h12v12H9zM15 9V3H3v12h6",
  refresh:
    "M20 4v6h-6M4 20v-6h6M5 9a8 8 0 0 1 13-5l2 6M4 14l2 6a8 8 0 0 0 13-5",
};
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (
      ["checked", "disabled", "required", "selected", "hidden"].includes(key)
    )
      node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity))
    if (child != null)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name] || paths.plug);
  svg.append(path);
  return svg;
}
function button(label, action, style = "", symbol) {
  return el(
    "button",
    { type: "button", class: `button ${style}`, onclick: action },
    symbol ? icon(symbol) : null,
    label,
  );
}
function iconButton(label, symbol, action) {
  return el(
    "button",
    {
      type: "button",
      class: "icon-button",
      "aria-label": label,
      title: label,
      onclick: action,
    },
    icon(symbol),
  );
}
function brand() {
  return el(
    "a",
    { href: "#chat", class: "brand", "aria-label": "Carvis home" },
    el("span", { class: "brand-mark", "aria-hidden": true }, "c"),
    el("span", { class: "brand-name" }, "carvis"),
    el("span", { class: "brand-tag" }, "YOUR SPACE"),
  );
}
function toast(message, error = false) {
  const region = $("#toast-region");
  region.replaceChildren(
    el("div", { class: `toast${error ? " error" : ""}` }, message),
  );
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => region.replaceChildren(), error ? 9000 : 5000);
}
function errorText(error) {
  return error?.message || "Something went wrong. Please try again.";
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    if (response.status === 401 && state.data) {
      state.data = null;
      renderAuth(false);
    }
    throw new Error(data.error || data.message || `Request failed (${response.status}).`);
  }
  return data;
}
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
function timeLabel(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function field(label, input, description) {
  return el(
    "label",
    { class: "field" },
    el("span", { class: "field-label" }, label),
    input,
    description ? el("p", { class: "field-description" }, description) : null,
  );
}
function input(name, value = "", type = "text", attrs = {}) {
  return el("input", { name, type, value: value ?? "", ...attrs });
}
function formNotice(container, message, success = false) {
  container.replaceChildren(
    el(
      "div",
      {
        class: success ? "form-success" : "form-error",
        role: success ? "status" : "alert",
      },
      message,
    ),
  );
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
        ? "Create your owner account. You’ll choose a model and connect integrations next."
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
          el("div", { class: "eyebrow" }, "AN ASSISTANT. YOUR WAY."),
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
            "A place to think, ask, and get things done. Start with a conversation. Add possibilities as you go.",
          ),
          el(
            "div",
            { class: "auth-points" },
            el("span", {}, icon("lock"), "Your installation"),
            el("span", {}, icon("grid"), "Your integrations"),
            el("span", {}, icon("spark"), "Your personality"),
          ),
        ),
        el("div", { class: "auth-footer" }, "CARVIS / A PERSONAL SPACE FOR AI"),
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
      ["chat", "Conversations", "chat"],
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
  const conversations = state.data.conversations || [];
  if (!conversations.length)
    history.append(
      el(
        "p",
        { class: "history-empty" },
        "Good conversations start here.\nYours will appear as you go.",
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
      "New conversation",
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
          el("div", { class: "profile-description" }, "Personal workspace"),
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
    state.page === "integrations"
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
        el("span", { class: "crumb-brand" }, "Your workspace"),
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
  state.integrationCleanup?.(); state.integrationCleanup = null;
  const version = ++state.navVersion;
  const [page, encodedId, section] = location.hash.replace(/^#/, "").split("/");
  state.page = ["integrations", "settings"].includes(page) ? page : "chat";
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
    if (requestedId) await renderIntegrationDetail(main, requestedId, section || "overview", version);
    else renderIntegrations(main);
  }
  else if (state.page === "settings") renderSettings(main);
  else renderChat(main);
}
window.addEventListener("hashchange", () => act(route));
function renameConversation(conversation) {
  const title = input("title", conversation.title, "text", {
    required: true,
    maxlength: 120,
  });
  const feedback = el("div");
  const form = el(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          await api(
            `/api/conversations/${encodeURIComponent(conversation.id)}`,
            { method: "PATCH", body: { title: title.value.trim() } },
          );
          await refreshState();
          if (state.conversation?.id === conversation.id)
            state.conversation.title = title.value.trim();
          modal.close();
          await route();
        } catch (error) {
          formNotice(feedback, errorText(error));
        }
      },
    },
    field("Conversation title", title),
    feedback,
    el(
      "div",
      { class: "modal-footer" },
      button("Cancel", () => modal.close(), "quiet"),
      el("button", { type: "submit", class: "button primary" }, "Save title"),
    ),
  );
  openModal("Rename conversation", null, form);
  title.select();
}
function deleteConversation(conversation) {
  openModal(
    "Delete this conversation?",
    "This removes its messages and cannot be undone.",
    el(
      "div",
      {},
      el("p", { class: "small muted" }, conversation.title),
      el(
        "div",
        { class: "modal-footer" },
        button("Keep conversation", () => modal.close(), "quiet"),
        button(
          "Delete conversation",
          () =>
            act(async () => {
              if (state.sending && state.activeId === conversation.id)
                state.controller?.abort();
              await api(
                `/api/conversations/${encodeURIComponent(conversation.id)}`,
                { method: "DELETE" },
              );
              await refreshState();
              modal.close();
              if (state.activeId === conversation.id) {
                state.activeId = null;
                state.conversation = null;
                navigate("chat");
              } else await route();
            }),
          "danger",
          "trash",
        ),
      ),
    ),
  );
}

function renderChat(main) {
  const scroll = el("div", { class: "chat-scroll", id: "chat-scroll" });
  const draftKey = state.activeId || "new";
  const textarea = el(
    "textarea",
    {
      id: "composer-text",
      rows: "2",
      placeholder: `What’s on your mind${state.data.profile?.displayName ? `, ${state.data.profile.displayName}` : ""}?`,
      "aria-label": "Message Carvis",
      maxlength: 16000,
    },
    state.drafts.get(draftKey) || "",
  );
  const send = el(
    "button",
    {
      type: "submit",
      class: "send-button",
      "aria-label": state.sending ? "Stop response" : "Send message",
      title: state.sending ? "Stop response" : "Send message",
      disabled: false,
    },
    icon(state.sending ? "stop" : "send"),
  );
  const form = el(
    "form",
    {
      class: "composer",
      onsubmit: (event) => {
        event.preventDefault();
        if (state.sending) return state.controller?.abort();
        const value = textarea.value.trim();
        if (value) {
          if (!state.data.model?.model) {
            toast(
              "Choose your model in Settings before sending a message.",
              true,
            );
            return;
          }
          textarea.value = "";
          state.drafts.delete(draftKey);
          textarea.style.height = "";
          act(() => sendMessage(value));
        }
      },
    },
    textarea,
    el(
      "div",
      { class: "composer-toolbar" },
      el(
        "div",
        { class: "composer-hint" },
        icon("spark"),
        state.sending
          ? "Working on your request"
          : "Enter to send · Shift + Enter for a new line",
      ),
      send,
    ),
  );
  textarea.addEventListener("input", () => {
    state.drafts.set(draftKey, textarea.value);
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!state.sending) form.requestSubmit();
    }
  });
  main.replaceChildren(
    el(
      "div",
      { class: "chat-page" },
      scroll,
      el(
        "div",
        { class: "composer-area" },
        el(
          "div",
          { class: "composer-inner" },
          form,
          el(
            "p",
            { class: "composer-note" },
            "Carvis can make mistakes. You choose what it can access and do.",
          ),
        ),
      ),
    ),
  );
  renderMessages(true);
}
function renderWelcome() {
  const hasModel = Boolean(state.data.model?.model);
  const suggestions = [
    {
      icon: "plan",
      title: "Make room for a good idea",
      detail: "Turn a rough thought into a clear plan.",
      prompt:
        "Help me turn an idea into a practical plan. Ask me what I’m working on.",
    },
    {
      icon: "book",
      title: "Understand something new",
      detail: "Get a clearer picture, one question at a time.",
      prompt:
        "I want to understand something new. Ask me what topic I’m curious about.",
    },
    {
      icon: "grid",
      title: "Make Carvis your own",
      detail: "Connect your devices and expand what’s possible.",
      action: () => navigate("integrations"),
    },
  ];
  return el(
    "section",
    { class: "welcome", "aria-label": "Welcome" },
    el("div", { class: "eyebrow" }, "A LITTLE SPACE. A LOT OF POSSIBILITY."),
    el(
      "h1",
      {},
      "Let’s make something",
      el("br"),
      el("span", {}, "of your next thought."),
    ),
    el(
      "p",
      { class: "welcome-description" },
      "Ask a question. Untangle an idea. Get things moving. Carvis is here to help, in whatever way works for you.",
    ),
    el(
      "div",
      { class: "suggestions" },
      suggestions.map((s) =>
        el(
          "button",
          {
            class: "suggestion",
            type: "button",
            onclick:
              s.action ||
              (() => {
                const composer = $("#composer-text");
                composer.value = s.prompt;
                state.drafts.set(state.activeId || "new", s.prompt);
                composer.focus();
              }),
          },
          icon(s.icon),
          el("span", { class: "arrow" }, "↗"),
          el("strong", {}, s.title),
          el("p", {}, s.detail),
        ),
      ),
    ),
    el(
      "p",
      { class: "welcome-footnote" },
      icon(hasModel ? "shield" : "settings"),
      hasModel
        ? "Start simple. Connect only what you need."
        : "One small thing before we begin:",
      hasModel
        ? null
        : el(
            "button",
            { onclick: () => navigate("settings") },
            "choose your model.",
          ),
    ),
  );
}
function formattedText(text) {
  const container = el("div", { class: "message-content" });
  // Text is always constructed as text nodes. Model content never becomes HTML.
  const parts = String(text || "").split(/```(?:[^\n`]*)\n([\s\S]*?)```/g);
  parts.forEach((part, index) => {
    if (index % 2)
      container.append(el("pre", {}, el("code", {}, part.replace(/\n$/, ""))));
    else
      part
        .split(/(`[^`\n]+`)/g)
        .forEach((piece) =>
          container.append(
            piece.startsWith("`") && piece.endsWith("`")
              ? el("code", { class: "inline-code" }, piece.slice(1, -1))
              : document.createTextNode(piece),
          ),
        );
  });
  return container;
}
function renderMessages(forceScroll = false) {
  const scroll = $("#chat-scroll");
  if (!scroll) return;
  const nearBottom =
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  const messages = state.conversation?.messages || [];
  if (!messages.length) scroll.replaceChildren(renderWelcome());
  else {
    const list = el("div", {
      class: "messages",
      role: "log",
      "aria-label": "Conversation",
    });
    for (const message of messages.filter((m) =>
      ["user", "assistant", "event"].includes(m.role),
    )) {
      if (message.role === "event") {
        const event = message.event;
        if (
          event?.type === "confirmation_result" &&
          event.source === "carvis_registry"
        ) {
          list.append(renderConfirmationResult(message));
          state.confirmations = state.confirmations.filter(
            (item) => item.id !== event.confirmationId,
          );
        }
        continue;
      }
      const silent = message.role === "assistant" && message.silent && !message.content;
      if (silent && !message.tools?.length) continue;
      const content = el(
        "div",
        { class: "message-body" },
        el(
          "div",
          { class: "message-meta" },
          message.role === "user" ? displayName() : assistantName(),
          message.createdAt
            ? el(
                "time",
                { datetime: new Date(message.createdAt).toISOString() },
                timeLabel(message.createdAt),
              )
            : null,
        ),
      );
      if (message.content) content.append(formattedText(message.content));
      else if (!silent && state.sending && message.id === state.streamingId)
        content.append(
          el(
            "div",
            { class: "thinking", "aria-label": "Thinking" },
            el("span", { class: "thinking-dot" }),
            el("span", { class: "thinking-dot" }),
            el("span", { class: "thinking-dot" }),
          ),
        );
      for (const tool of message.tools || [])
        content.append(
          el(
            "div",
            { class: `tool-row${tool.status === "error" ? " error" : ""}` },
            icon(
              tool.status === "running"
                ? "refresh"
                : tool.status === "error"
                  ? "info"
                  : "check",
            ),
            el(
              "div",
              {},
              el(
                "div",
                { class: "tool-name" },
                tool.name || "Integration action",
              ),
              tool.detail
                ? el(
                    "div",
                    { class: "tool-detail" },
                    typeof tool.detail === "string"
                      ? tool.detail
                      : JSON.stringify(tool.detail),
                  )
                : null,
            ),
          ),
        );
      if (message.id === state.streamingId && state.sending && state.status)
        content.append(
          el("div", { class: "run-status", role: "status" }, state.status),
        );
      list.append(
        el(
          "article",
          { class: `message ${message.role}${silent ? " silent-result" : ""}` },
          el(
            "div",
            { class: "message-avatar", "aria-hidden": true },
            message.role === "assistant"
              ? "c"
              : displayName().slice(0, 1).toUpperCase(),
          ),
          content,
        ),
      );
    }
    for (const confirmation of state.confirmations.filter(
      (c) => !c.conversationId || c.conversationId === state.activeId,
    ))
      list.append(renderConfirmation(confirmation));
    scroll.replaceChildren(list);
  }
  if (forceScroll || nearBottom) scroll.scrollTop = scroll.scrollHeight;
}
function renderConfirmationResult(message) {
  const event = message.event,
    outcome = event.outcome || {};
  let title = "Confirmation approved",
    detail = outcome.message || "The integration returned a result.",
    symbol = "check",
    failed = false;
  if (event.decision === "declined" || outcome.declined) {
    title = "Action declined";
    detail = "You declined this request. The action was not executed.";
    symbol = "close";
  } else if (event.decision === "cancelled") {
    title = "Action cancelled";
    detail = outcome.error || "The action was cancelled before execution.";
    symbol = "close";
  } else if (
    event.decision === "error" ||
    outcome.success === false ||
    outcome.error
  ) {
    title = "Action needs attention";
    detail =
      outcome.error ||
      outcome.message ||
      "The integration did not confirm this action.";
    symbol = "info";
    failed = true;
  } else if (outcome.dryRun) {
    title = "Dry run complete";
    detail = outcome.message || "Validated only. No device command was sent.";
  } else if (outcome.requiresConfirmation) {
    title = "Further confirmation needed";
    detail =
      outcome.message || "The integration still requires your confirmation.";
    symbol = "shield";
  } else if (outcome.verified === true) {
    title = "Action verified";
  } else if (outcome.accepted || outcome.verified === false) {
    title = "Command accepted · outcome unverified";
    detail =
      outcome.message ||
      "The integration accepted the command but has not verified the resulting state.";
  }
  return el(
    "article",
    {
      class: `confirmation-result${failed ? " error" : ""}`,
      "aria-label": title,
    },
    el(
      "span",
      { class: "confirmation-result-icon", "aria-hidden": true },
      icon(symbol),
    ),
    el(
      "div",
      { class: "confirmation-result-content" },
      el(
        "div",
        { class: "confirmation-result-heading" },
        el("strong", {}, title),
        el(
          "time",
          { datetime: new Date(message.createdAt).toISOString() },
          timeLabel(message.createdAt),
        ),
      ),
      el(
        "p",
        { class: "confirmation-result-summary" },
        event.summary || event.tool,
      ),
      el("p", { class: "confirmation-result-detail" }, detail),
    ),
  );
}
function renderConfirmation(confirmation) {
  const feedback = el("div");
  const decide = async (accepted) => {
    try {
      for (const b of card.querySelectorAll("button")) b.disabled = true;
      const result = await api(
        `/api/confirmations/${encodeURIComponent(confirmation.id)}`,
        { method: "POST", body: { accepted } },
      );
      state.confirmations = state.confirmations.filter(
        (c) => c.id !== confirmation.id,
      );
      if (result.success === false)
        toast(
          result.error ||
            result.result?.error ||
            "The action could not be completed.",
          true,
        );
      else
        toast(
          accepted
            ? "Confirmed. The action has been processed."
            : "Action declined.",
        );
      if (state.activeId)
        state.conversation = await api(
          `/api/conversations/${encodeURIComponent(state.activeId)}`,
        );
      renderMessages(true);
    } catch (error) {
      formNotice(feedback, errorText(error));
      for (const b of card.querySelectorAll("button")) b.disabled = false;
    }
  };
  const card = el(
    "div",
    { class: "confirmation" },
    el("h3", {}, "Your confirmation is needed"),
    el(
      "p",
      {},
      confirmation.summary || confirmation.tool || "Allow this action?",
    ),
    feedback,
    el(
      "div",
      { class: "action-row" },
      button(
        "Allow this action",
        () => decide(true),
        "primary compact",
        "check",
      ),
      button("Decline", () => decide(false), "compact"),
    ),
  );
  return card;
}
async function sendMessage(text) {
  if (state.sending) return;
  state.sending = true;
  state.status = "";
  const controller = new AbortController();
  state.controller = controller;
  let conversation = state.conversation,
    streaming;
  try {
    if (!conversation) {
      conversation = await api("/api/conversations", {
        method: "POST",
        body: {},
      });
      if (state.page === "chat" && !state.activeId) {
        state.conversation = conversation;
        state.activeId = conversation.id;
        history.replaceState(
          null,
          "",
          `#chat/${encodeURIComponent(conversation.id)}`,
        );
      }
      state.data.conversations.unshift({
        id: conversation.id,
        title: conversation.title || "New conversation",
        updatedAt: conversation.updatedAt,
      });
    }
    conversation.messages ||= [];
    const now = new Date().toISOString();
    conversation.messages.push({
      id: `local-user-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: now,
    });
    streaming = {
      id: `local-assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      createdAt: now,
      tools: [],
    };
    state.streamingId = streaming.id;
    conversation.messages.push(streaming);
    if (state.page === "chat" && state.activeId === conversation.id)
      renderChat(renderShell());
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversation.id)}/messages`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        data.error || `The model request failed (${response.status}).`,
      );
    }
    if (!response.body)
      throw new Error("Your browser could not open the response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handleEvent = (block) => {
      let type = "message";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) return;
      let data;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        return;
      }
      if (type === "delta") streaming.content += data.text || "";
      else if (type === "status") state.status = data.text || "";
      else if (type === "tool") {
        const existing = [...streaming.tools]
          .reverse()
          .find((t) => t.name === data.name && t.status === "running");
        if (existing && data.status !== "running")
          Object.assign(existing, data);
        else streaming.tools.push(data);
      } else if (type === "confirmation")
        state.confirmations.push({ ...data, conversationId: conversation.id });
      else if (type === "done" && data.conversation) {
        conversation = data.conversation;
        if (state.activeId === conversation.id)
          state.conversation = conversation;
      } else if (type === "error")
        throw new Error(data.error || "The response could not be completed.");
      if (state.activeId === conversation.id) renderMessages();
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleEvent(block);
      }
      if (done) {
        if (buffer.trim()) handleEvent(buffer);
        break;
      }
    }
  } catch (error) {
    if (error.name === "AbortError")
      toast("Response stopped. Actions already sent may still finish.");
    else toast(errorText(error), true);
  } finally {
    state.sending = false;
    state.controller = null;
    state.status = "";
    state.streamingId = null;
    if (state.data) {
      try {
        await refreshState();
        if (state.activeId)
          state.conversation = await api(
            `/api/conversations/${encodeURIComponent(state.activeId)}`,
          );
      } catch {
        /* Keep the visible conversation if a follow-up request fails. */
      }
      if (state.page === "chat") await route();
    }
  }
}

function pageHeading(eyebrow, title, description) {
  return el(
    "header",
    { class: "page-heading" },
    el(
      "div",
      {},
      el("div", { class: "eyebrow" }, eyebrow),
      el("h1", {}, title),
      el("p", {}, description),
    ),
  );
}
function integrationIcon(id) {
  return id.includes("home")
    ? "home"
    : id.includes("even") || id.includes("glass")
      ? "glasses"
      : id.includes("tv")
        ? "tv"
        : "plug";
}
const integrationCategories = [
  { id: "required", name: "HA required", description: "These abilities need a linked Home Assistant server.", icon: "home" },
  { id: "recommended", name: "HA recommended", description: "Useful on their own. Connect Home Assistant for home devices and extra features.", icon: "plug" },
  { id: "not-required", name: "HA not required", description: "These abilities work without a Home Assistant connection.", icon: "spark" },
];
function integrationCategory(integration) {
  const supplied = integration.homeAssistant?.requirement;
  if (integrationCategories.some(category => category.id === supplied)) return supplied;
  return integration.dependsOn?.some(d => (typeof d === 'string' ? d : d.id) === 'home-assistant' && !d.optional) ? 'required' : 'not-required';
}
function integrationDependencies(integration, key = "dependsOn") {
  return (Array.isArray(integration[key]) ? integration[key] : []).map(value => {
    const id = typeof value === "string" ? value : value?.id;
    const dependency = (state.data.integrations || []).find(item => item.id === id);
    return { id, name: dependency?.name || value?.label || id || "Unknown integration", enabled: Boolean(dependency?.enabled), optional: Boolean(value?.optional), integration: dependency };
  });
}
function integrationPanelUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}
function integrationStatus(integration) {
  if (!integration.enabled) return { label: "Disabled", tone: "off" };
  if (integrationDependencies(integration).some(item => !item.optional && !item.enabled)) return { label: "Enabled · dependency needed", tone: "attention" };
  const status = typeof integration.status === "object" ? integration.status?.state || integration.status?.status : integration.status;
  if (["error", "failed", "unavailable", "needs attention"].includes(status)) return { label: "Enabled · needs attention", tone: "attention" };
  if (integration.configured === false) return { label: "Enabled · setup needed", tone: "attention" };
  return { label: "Enabled", tone: "on" };
}
function integrationControlsMissing(integration) {
  return [...new Map([...integrationDependencies(integration), ...integrationDependencies({dependsOn:integration.controls?.dependsOn || []})]
    .filter(item => !item.optional && !item.enabled).map(item => [item.id, item])).values()];
}
function integrationMatchesSearch(integration, query) {
  const category = integrationCategories.find(group => group.id === integrationCategory(integration));
  const fields = (integration.fields || []).flatMap(field => [field.label, field.description, field.help, typeof field.group === "string" ? field.group : field.group?.label, String(field.key || "").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("__", " ")]);
  const text = [integration.name, integration.description, category?.name, ...fields].filter(Boolean).join(" ").toLowerCase();
  return String(query).trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}
function integrationCard(integration) {
  const status = integrationStatus(integration);
  return el("article", { class: "integration-card", "data-integration": integration.id },
    el("div", { class: "integration-top" }, el("div", { class: "integration-icon" }, icon(paths[integration.icon] ? integration.icon : integrationIcon(integration.id))),
      el("div", { class: `integration-status ${status.tone}` }, el("span", { class: `status-dot${status.tone === "off" ? " off" : status.tone === "attention" ? " attention" : ""}` }), status.label)),
    el("h3", {}, integration.name), el("p", {}, integration.description),
    el("p", {class:"integration-ha-note"}, integration.homeAssistant?.note || "No Home Assistant connection needed."),
    el("div", { class: "integration-footer" }, el("span", { class: "version" }, integration.enabled ? "Ready to manage" : "Optional integration"), button(integration.configured ? "Manage" : "Set up", () => navigate(`integrations/${integration.id}`), "compact", "arrow")));
}
function renderIntegrations(main) {
  const integrations = state.data.integrations || [], enabled = integrations.filter(item => item.enabled).length;
  const needsAttention = integrations.filter(item => integrationStatus(item).tone === "attention").length;
  const search = input("integration-search", state.integrationSearch || "", "search", { placeholder: "Find an integration or setting", "aria-label": "Search integrations and settings" });
  const groups = el("div", { class: "integration-groups" }), resultCount = el("span", { class: "catalog-result-count", role: "status" });
  const filterButtons = [];
  const filterItems = [["all", `All integrations · ${integrations.length}`], ["enabled", `Enabled · ${enabled}`], ["attention", `Needs attention · ${needsAttention}`]];
  const renderGroups = () => {
    const query = search.value.trim().toLowerCase(), filter = state.integrationFilter || "all";
    const matches = integrations.filter(item => {
      if (filter === "enabled" && !item.enabled) return false;
      if (filter === "attention" && integrationStatus(item).tone !== "attention") return false;
      return integrationMatchesSearch(item, query);
    });
    groups.replaceChildren();
    filterButtons.forEach(({ button: control, value }) => { control.classList.toggle("active", value === filter); control.setAttribute("aria-pressed", String(value === filter)); });
    resultCount.textContent = query || filter !== "all" ? `${matches.length} ${matches.length === 1 ? "integration" : "integrations"}` : "";
    for (const category of integrationCategories) {
      const items = matches.filter(item => integrationCategory(item) === category.id);
      if (!items.length) continue;
      groups.append(el("section", { class: "integration-category", "aria-labelledby": `category-${category.id}` },
        el("div", { class: "category-heading" }, el("div", { class: "category-title" }, icon(category.icon), el("h2", { id: `category-${category.id}` }, category.name), el("span", { class: "count-label" }, String(items.length))), el("p", {}, category.description)),
        el("div", { class: "integration-grid" }, items.map(integrationCard))));
    }
    if (!matches.length) groups.append(el("div", { class: "empty-card" }, el("h2", {}, integrations.length ? "No matching integrations" : "A little room to grow"), el("p", {}, integrations.length ? "Try another search or filter." : "Installed integrations will appear here, ready for you to configure."), integrations.length ? button("Reset filters", () => { search.value = ""; state.integrationSearch = ""; state.integrationFilter = "all"; renderGroups(); }, "quiet compact") : null));
  };
  const filters = el("div", { class: "catalog-filters", role: "group", "aria-label": "Filter integrations" }, filterItems.map(([value, label]) => {
    const control = button(label, () => { state.integrationFilter = value; renderGroups(); }, "catalog-filter"); filterButtons.push({ button: control, value }); return control;
  }));
  search.addEventListener("input", () => { state.integrationSearch = search.value; renderGroups(); });
  main.replaceChildren(el("section", { class: "page integrations-page" },
    pageHeading("MAKE IT YOURS", "Integration center", "Add abilities to Carvis. HA means Home Assistant — the server that connects your home devices."),
    el("div", { class: "integration-overview" }, el("div", {}, el("span", { class: "overview-number" }, String(enabled)), el("span", { class: "overview-label" }, "integrations enabled")),
      el("p", {}, enabled ? "Your enabled integrations add tools and context to Carvis. Manage their setup, controls, and activity here." : "Start with a conversation. Enable an integration whenever you’re ready for more."), el("span", { class: "overview-total" }, `${integrations.length} available`)),
    el("div", { class: "catalog-toolbar" }, filters, el("div", { class: "catalog-search" }, icon("search"), search)), resultCount, groups,
    el("div", { class: "integration-banner" }, icon("shield"), el("div", {}, el("h3", {}, "A capable assistant. Clear boundaries."), el("p", {}, "Integrations start disabled. You choose the connections, visible devices, and actions that need your confirmation."))),
    el("details", { class: "integration-help" }, el("summary", {}, "How does Carvis grow?"), el("p", {}, "New abilities arrive through integrations. Each has its own setup, controls, and permissions. Your conversations, personality, and memory stay in one place."))));
  renderGroups();
}
async function renderIntegrationDetail(main, id, section, version) {
  const integration = state.data.integrations.find(item => item.id === id);
  if (!integration) { navigate("integrations"); return; }
  const controls = integration.controls;
  const labels = [["overview","Overview"],["controls","Controls"],["settings","Settings"],["activity","Activity"]];
  if (!labels.some(([key]) => key === section)) section = "overview";
  const body = el("div", {class:"integration-detail-body"});
  const category = integrationCategories.find(c => c.id === integrationCategory(integration));
  main.replaceChildren(el("section", {class:"page integration-detail"},
    button("All integrations", () => navigate("integrations"), "quiet compact", "arrow"),
    pageHeading(category.name.toUpperCase(), integration.name, integration.description),
    el("nav", {class:"integration-detail-tabs", "aria-label": `${integration.name} sections`}, labels.map(([key,label]) => el("a", {href:`#integrations/${id}/${key}`,class:`button quiet${section===key?' active':''}`,"aria-current":section===key?"page":null}, label))), body));
  if (section === 'settings') { configureIntegration(integration, body); return; }
  if (section === 'overview') {
    const dependencies = integrationDependencies(integration);
    if(category.id==='required' && id!=='home-assistant' && !dependencies.some(d=>d.id==='home-assistant')) dependencies.push(...integrationDependencies({dependsOn:['home-assistant']}));
    body.append(el("div", {class:"integration-intro-grid"},
      el("section", {class:"control-card"}, el("h2",{},"Get started"), el("ol",{class:"setup-steps"}, (integration.setupSteps?.length ? integration.setupSteps : ['Open Settings, add your connection details, then enable the integration.']).map(step => el("li",{},step))), button("Open settings",()=>navigate(`integrations/${id}/settings`),"primary compact")),
      el("section", {class:"control-card"}, el("h2",{},category.name),el("p",{},integration.homeAssistant?.note || category.description),
        dependencies.length ? el("div",{class:"setup-dependencies"},el("h3",{},"Other integrations"),dependencies.map(d=>el("p",{},el("a",{href:`#integrations/${d.id}`},d.name),` · ${d.enabled?'enabled':'set up first'}`))) : null,
        el("details",{},el("summary",{},"What this integration can access"),el("ul",{},(integration.permissions||[]).map(p=>el("li",{},typeof p==='string'?p:p.description)))))));
    return;
  }
  const missing = integrationControlsMissing(integration);
  if (!integration.enabled || missing.length || !controls?.module) {
    body.append(el("div",{class:"empty-card"},el("h2",{},!integration.enabled?'Set up this integration first':'Controls are not available yet'),el("p",{},missing.length?`Enable ${missing.map(item=>item.name).join(', ')} to use these controls.`:'Connection details and permissions are in Settings.'),button("Open settings",()=>navigate(`integrations/${id}/settings`),"compact")));
    return;
  }
  const url = integrationPanelUrl(controls.module);
  if (!url || !url.endsWith('.js')) { body.append(el('p',{},'This integration has an invalid controls module.')); return; }
  body.append(el("p",{class:"muted"},"Loading…"));
  try {
    const module = await import(url);
    if (version !== state.navVersion) return;
    const abort = new AbortController();
    state.integrationCleanup = () => abort.abort();
    body.replaceChildren();
    const cleanup = await module.mount({root:body,integration,section,el,button,input,field,api,toast,signal:abort.signal,navigate,integrations:state.data.integrations});
    if (version !== state.navVersion) { cleanup?.(); return; }
    state.integrationCleanup = () => { abort.abort(); cleanup?.(); };
  } catch(error) { if(version===state.navVersion) body.replaceChildren(el('div',{class:'notice error'},errorText(error)),button('Retry',()=>route(),'compact')); }
}
function integrationFieldGroup(integration, definition) {
  const supplied = definition.group;
  const groupId = value => String(value).replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const names = { carvis: "Assistant behavior", tools: "Tool execution", ollama: "Local models", models: "Model roles", voice: "Conversation", stt: "Speech recognition", liveVoice: "Live voice", speech: "Speech & speakers", classifier: "Proactive decisions", sessions: "Activity sessions", memory: "Memory & patterns", search: "Search provider", atlas: "Project connection", mac: "Desktop connection", physicalCarvis: "Device connection", agent: "Device behavior", glasses: "Display & gestures" };
  if (supplied && typeof supplied === "object") return { id: groupId(supplied.id || supplied.label || "general"), label: supplied.label || supplied.title || names[supplied.id] || supplied.id || "General", description: supplied.description || supplied.help || definition.groupHelp || "" };
  if (typeof supplied === "string" && supplied.trim()) return { id: groupId(supplied), label: names[supplied] || supplied.replace(/^./, letter => letter.toUpperCase()), description: definition.groupHelp || "" };
  const key = definition.key;
  if (integration.id === "home-assistant") return ["dryRun", "observed", "controlled", "guards"].includes(key) ? { id: "devices", label: "Devices & permissions", description: "Choose what Carvis can see, what it can control, and when it needs to ask." } : { id: "connection", label: "Connection", description: "Use your own Home Assistant address and access token." };
  if (integration.id === "apple-tv") {
    if (["silentNavigation", "shortReplies"].includes(key)) return { id: "behavior", label: "Response behavior", description: "Choose how much Carvis says while you control the TV." };
    if (key === "context") return { id: "context", label: "Context", description: "Give the controller useful preferences and guidance." };
    return { id: "controller", label: "Controller", description: "Connect your AI TV controller and the selected TV entities." };
  }
  if (integration.id === "even-realities") return key.startsWith("speech") || key === "microphoneEnabled" ? { id: "voice", label: "Voice input", description: "Optional speech recognition, using the provider you choose." } : { id: "connection", label: "Connection", description: "Pair the glasses companion with your Carvis server." };
  if (key.includes("__")) { const id = key.split("__")[0]; return { id, label: id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/^./, letter => letter.toUpperCase()), description: "" }; }
  return { id: "general", label: "General", description: "" };
}
function roomNotesControl(saved) {
  const rows=el('div',{class:'room-note-rows'}),entries=[];
  const add=(room='',note='')=>{
    const name=input('room',room,'text',{'aria-label':'Room or area name',placeholder:'Room name'}),text=el('textarea',{rows:2,'aria-label':'Room notes',placeholder:'Objects, landmarks, or details Carvis should recognize.'},String(note));
    const row=el('div',{class:'room-note-row'},field('Room or area',name),field('Notes',text),button('Remove',()=>{entries.splice(entries.indexOf(entry),1);row.remove();},'quiet compact'));
    const entry={name,text};entries.push(entry);rows.append(row);
  };
  for(const [room,note] of Object.entries(saved))add(room,note);
  const control=el('div',{},rows,button('Add room notes',()=>add(),'compact'));
  control.notes=()=>Object.fromEntries(entries.filter(e=>e.name.value.trim()).map(e=>[e.name.value.trim(),e.text.value]));
  control.checkValidity=()=>{const names=entries.map(e=>e.name.value.trim());return entries.every(e=>e.name.value.trim() || !e.text.value.trim()) && new Set(names.filter(Boolean)).size===names.filter(Boolean).length;};
  control.reportValidity=()=>{toast('Give each note a unique room or area name.',true);return false;};
  control.setCustomValidity=()=>{};control.validationMessage='Give each note a unique room or area name.';
  return control;
}
function integrationFieldValue(definition, control) {
  const value = control.value, label = definition.label || definition.key;
  if (definition.type === "room-notes") return control.notes();
  if (definition.type === "password" && !value) return undefined;
  if (definition.type === "boolean") return control.checked;
  if (definition.type === "number") {
    if (value.trim() === "") return undefined;
    const number = Number(value), min = definition.min ?? definition.minimum, max = definition.max ?? definition.maximum;
    if (!Number.isFinite(number) || (min !== undefined && number < min) || (max !== undefined && number > max)) throw new Error(`${label}: enter a number${min !== undefined && max !== undefined ? ` between ${min} and ${max}` : " in the allowed range"}.`);
    return number;
  }
  if (definition.type === "json") {
    if (!value.trim()) return undefined;
    try { return JSON.parse(value); } catch { throw new Error(`${label}: enter valid JSON. Use double quotes around property names and text.`); }
  }
  if (["string-array", "string_array"].includes(definition.type)) return [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
  if (definition.type === "entities") return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  return value;
}
function configureIntegration(integration, host) {
  if (!host) { navigate(`integrations/${integration.id}/settings`); return; }
  const values = {}, cfg = integration.config || {}, feedback = el("div"), groups = new Map();
  const dependencies = integrationDependencies(integration), requiredMissing = dependencies.filter(item => !item.optional && !item.enabled);
  const enabled = input("enabled", "", "checkbox", { checked: integration.enabled, "aria-label": `Enable ${integration.name}` });
  const form = el("form", { class: "integration-settings-form", novalidate: true });
  const permissionText = (integration.permissions || []).map(permission => el("li", {}, icon("check"), typeof permission === "string" ? permission : permission.description || permission.name || "Integration access"));
  form.append(el("div", { class: "switch-row" }, el("div", {}, el("strong", {}, "Enable integration"), el("p", {}, "Allow Carvis to use this integration after you save.")), el("label", { class: "switch" }, enabled)));
  if (requiredMissing.length) form.append(el("div", { class: `integration-dependencies${requiredMissing.length ? " attention" : ""}` }, el("h3", {}, "Works with"), dependencies.map(item => el("div", { class: "dependency-row" }, el("div", {}, el("strong", {}, item.name), el("span", {}, item.optional ? "Optional connection" : "Required integration")), el("span", { class: `dependency-state${!item.enabled ? " off" : ""}` }, item.enabled ? "Enabled" : item.integration ? "Disabled" : "Not installed"))), requiredMissing.length ? el("p", {}, "Set up and enable the required integrations first. You can still save this integration’s settings while it is disabled.") : null));
  const permissions = el("details", { class: "integration-permissions" }, el("summary", {}, `Access & abilities${permissionText.length ? ` · ${permissionText.length}` : ""}`), permissionText.length ? el("ul", {}, permissionText) : el("p", { class: "small muted" }, "No extra permissions declared."));
  if (dependencies.length && !requiredMissing.length) form.append(el("p",{class:"dependency-ready small muted"},"Connected with ", dependencies.map((item,index)=>el("span",{},index?", ":"",el("a",{href:`#integrations/${item.id}`},item.name)))));
  const tabs = el("div", { class: "integration-settings-tabs", role: "tablist", "aria-label": "Settings sections" }), panels = el("div", { class: "integration-settings-panels" });
  let activeGroup = null;
  const activate = (id, focus = false) => {
    activeGroup = id;
    for (const [key, group] of groups) { const selected = key === id; group.panel.hidden = !selected; group.tab.classList.toggle("active", selected); group.tab.setAttribute("aria-selected", String(selected)); group.tab.tabIndex = selected ? 0 : -1; if (selected && focus) group.tab.focus(); }
  };
  const getGroup = definition => {
    const metadata = integrationFieldGroup(integration, definition);
    if (!groups.has(metadata.id)) {
      const index = groups.size, panelId = `integration-settings-panel-${index}`, tabId = `integration-settings-tab-${index}`;
      const tab = el("button", { type: "button", class: "integration-settings-tab", id: tabId, role: "tab", "aria-controls": panelId, "aria-selected": "false", tabindex: "-1", onclick: () => { activate(metadata.id); if(window.matchMedia("(max-width:600px)").matches) panel.scrollIntoView({block:"start",behavior:"smooth"}); } }, metadata.label);
      const panel = el("section", { class: "integration-settings-panel", id: panelId, role: "tabpanel", "aria-labelledby": tabId, hidden: true }, el("div", { class: "settings-group-heading" }, el("h3", {}, metadata.label), metadata.description ? el("p", {}, metadata.description) : null));
      groups.set(metadata.id, { tab, panel, metadata }); tabs.append(tab); panels.append(panel);
    }
    return { ...groups.get(metadata.id), id: metadata.id };
  };
  tabs.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const ids = [...groups.keys()], current = ids.indexOf(activeGroup);
    const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
    if (ids[next]) activate(ids[next], true);
  });
  let entitySection = null;
  for (const definition of integration.fields || []) {
    const f = definition;
    if (integration.id === "home-assistant" && ["observed", "controlled", "guards"].includes(f.key)) continue;
    const group = getGroup(f), value = cfg[f.key] ?? f.default;
    let control;
    if (f.type === "room-notes") control = roomNotesControl(value || {});
    else if (f.type === "boolean") control = input(f.key, "", "checkbox", { checked: Boolean(value ?? (integration.id === "home-assistant" && f.key === "dryRun")) });
    else if (f.type === "select") control = el("select", { name: f.key }, (!f.required && value === undefined) ? el("option", { value: "" }, "Choose an option") : null, (f.options || []).map(option => el("option", { value: typeof option === "string" ? option : option.value, selected: String(typeof option === "string" ? option : option.value) === String(value) }, typeof option === "string" ? option : option.label)));
    else if (["entities", "string-array", "string_array"].includes(f.type)) control = el("textarea", { name: f.key, rows: "4", placeholder: f.placeholder || "One item per line" }, Array.isArray(value) ? value.join("\n") : value ?? "");
    else if (["textarea", "json"].includes(f.type)) control = el("textarea", { name: f.key, rows: f.type === "json" ? "7" : "4", class: f.type === "json" ? "json-input" : "", spellcheck: f.type === "json" ? "false" : "true", placeholder: f.placeholder || (f.type === "json" ? "[] or {}" : "") }, typeof value === "object" || f.type === "json" && value !== undefined && typeof value !== "string" ? JSON.stringify(value, null, 2) : value ?? "");
    else control = input(f.key, f.type === "password" ? "" : value ?? "", ["password", "url", "number"].includes(f.type) ? f.type : "text", { autocomplete: f.type === "password" ? "new-password" : "off", min: f.min ?? f.minimum, max: f.max ?? f.maximum, step: f.type === "number" ? f.step ?? "any" : undefined, placeholder: f.type === "password" ? cfg[`has${f.key[0].toUpperCase()}${f.key.slice(1)}`] ? "Saved · leave blank to keep" : "Enter your secret" : f.placeholder || "" });
    const sharedKeyId = {openaiKey:'openai',anthropicKey:'anthropic',stt__deepgramKey:'deepgram',stt__assemblyaiKey:'assemblyai',search__geminiKey:'gemini'}[f.key];
    if(sharedKeyId && f.type==='password' && !cfg[`has${f.key[0].toUpperCase()}${f.key.slice(1)}`]) control.placeholder=state.data.apiKeys?.[sharedKeyId]?.saved ? 'Using global key · optional override' : 'Optional override · set shared key in Settings';
    let hasSecret = Boolean(cfg[`has${f.key[0].toUpperCase()}${f.key.slice(1)}`]);
    const updateRequired = () => { control.required = Boolean(enabled.checked && f.required && (f.type !== "password" || !hasSecret)); };
    updateRequired(); enabled.addEventListener("change", updateRequired);
    control.addEventListener("input", () => control.setCustomValidity(""));
    values[f.key] = { control, field: f, groupId: group.id };
    const description = [f.description, f.help, ["string-array", "string_array"].includes(f.type) ? "Enter one value per line." : f.type === "json" ? "Use JSON for lists or structured settings. Leave blank to keep the saved value; use [] or {} to clear it." : null].filter((text, index, all) => typeof text === "string" && text && all.indexOf(text) === index).join(" ");
    let destination = group.panel;
    if (f.advanced) {
      let advanced = group.panel.querySelector('.advanced-settings');
      if (!advanced) { advanced = el('details',{class:'advanced-settings'},el('summary',{},'Advanced settings'),el('p',{class:'small muted'},'Optional tuning. Keep the defaults unless you have a specific reason to change them.')); group.panel.append(advanced); }
      destination = advanced;
    }
    destination.append(f.type === "boolean" ? el("label", { class: "field checkbox" }, control, el("span", {}, el("span", { class: "field-label" }, f.label || f.key), description ? el("span", { class: "field-description" }, description) : null)) : field(f.label || f.key, control, description));
    if (f.key === "pairingToken" && integration.id === "even-realities") {
      const secretArea = el("div");
      const generate = button("Generate pairing token", async () => {
        generate.disabled = true;
        try {
          const result = await api("/api/integrations/even-realities/generate-secret", { method: "POST", body: { key: "pairingToken" } });
          if (!result.value) throw new Error("No token was returned.");
          control.value = ""; control.placeholder = "Saved · leave blank to keep"; hasSecret = true; updateRequired();
          const token = input("new-pairing-token", result.value, "text", { readonly: true, "aria-label": "New pairing token", autocomplete: "off" });
          secretArea.replaceChildren(el("div", { class: "notice" }, el("p", {}, "New token saved. Copy it into your glasses app now. Existing pairings will need the new token.")), token, el("div", { class: "action-row" }, button("Copy token", () => act(async () => { await navigator.clipboard.writeText(result.value); toast("Pairing token copied."); }), "compact", "copy")));
          await refreshState();
        } catch (error) { formNotice(secretArea, errorText(error)); } finally { generate.disabled = false; }
      }, "compact", "refresh");
      group.panel.append(generate, el("p", { class: "field-description" }, "Creates and saves a new token immediately. It replaces the previous token."), secretArea);
    }
  }
  if (integration.id === "home-assistant") { entitySection = makeEntitySelector(cfg); getGroup({ key: "observed" }).panel.append(entitySection.node); }
  if (groups.size) {
    const rank = key => /connection|controller|credentials/.test(key) ? 0 : /^(stt|speech|devices|reply-behavior)$/.test(key) ? 1 : /models|tools|ollama|agent/.test(key) ? 4 : 2;
    const ordered = [...groups].sort(([a],[b])=>rank(a)-rank(b));
    for (const [,g] of ordered) { tabs.append(g.tab); panels.append(g.panel); const advanced=g.panel.querySelector('.advanced-settings'); if(advanced)g.panel.append(advanced); }
    form.append(el('div',{class:'settings-layout'},tabs,panels)); activate(ordered[0][0]);
  }
  else form.append(el("p", { class: "small muted" }, "This integration has no additional settings."));
  const collectConfig = () => {
    const config = {};
    for (const [key, entry] of Object.entries(values)) {
      const { control, field: definition, groupId } = entry;
      if (!control.checkValidity()) { activate(groupId); const folded=control.closest('details'); if(folded)folded.open=true; control.reportValidity(); throw new Error(`${definition.label || key}: ${control.validationMessage}`); }
      try { const value = integrationFieldValue(definition, control); if (value !== undefined) config[key] = value; }
      catch (error) { control.setCustomValidity(errorText(error)); activate(groupId); const folded=control.closest('details'); if(folded)folded.open=true; control.reportValidity(); throw error; }
    }
    if (entitySection) Object.assign(config, entitySection.value());
    return config;
  };
  const save = el("button", { type: "submit", class: "button primary" }, "Save changes");
  const test = button("Test saved connection", async () => {
    test.disabled = true; feedback.replaceChildren();
    try { const result = await api(`/api/integrations/${encodeURIComponent(integration.id)}/test`, { method: "POST" }); formNotice(feedback, result.message || result.error || (result.success ? "Connection successful." : "Could not connect."), result.success); }
    catch (error) { formNotice(feedback, errorText(error)); } finally { test.disabled = false; }
  }, "", "refresh");
  form.append(permissions, feedback, el("div", { class: "modal-footer" }, test, save));
  form.addEventListener("submit", async event => {
    event.preventDefault(); save.disabled = true; feedback.replaceChildren();
    try {
      const config = collectConfig();
      if (enabled.checked && requiredMissing.length) throw new Error(`Enable ${requiredMissing.map(item => item.name).join(", ")} before enabling ${integration.name}.`);
      await api(`/api/integrations/${encodeURIComponent(integration.id)}`, { method: "PUT", body: { enabled: enabled.checked, config } });
      await refreshState(); await route(); toast(`${integration.name} settings saved.`);
    } catch (error) { formNotice(feedback, errorText(error)); } finally { save.disabled = false; }
  });
  host.replaceChildren(form);
}
function makeEntitySelector(config) {
  const observed = new Set(config.observed || []), controlled = new Set(config.controlled || []), guards = { ...(config.guards || {}) }, selected = new Set();
  const list = el('div', {class:'entity-table-scroll'}), rooms = el('div', {class:'entity-rooms',role:'group','aria-label':'Filter by room'}), count = el('p',{class:'entity-count'}), heading = el('h3'), feedback = el('div');
  const search = input('entity-search','','search',{placeholder:'Search entities…','aria-label':'Search entities'});
  const type = el('select',{'aria-label':'Filter entity type'},el('option',{value:''},'All types'));
  const only = input('entities-selected','','checkbox');
  let entities = [], loaded = false, room = '*';
  const label = value => String(value || '').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
  const domainIcon = domain => ({media_player:'tv',camera:'glasses',lock:'lock',switch:'plug',light:'spark',sensor:'info',binary_sensor:'info'}[domain] || 'grid');
  const visible = () => entities.filter(e => (room==='*' || (e.area_id || '')===room) && (!type.value || e.domain===type.value) && (!only.checked || observed.has(e.entity_id)) && `${e.name} ${e.entity_id} ${e.area_name || ''}`.toLowerCase().includes(search.value.toLowerCase()));
  function setPermission(id, action) {
    if(action==='observe') observed.add(id);
    if(action==='control'){observed.add(id);controlled.add(id);}
    if(action==='hide'){observed.delete(id);controlled.delete(id);delete guards[id];}
    if(action==='stop-control'){controlled.delete(id);delete guards[id];}
    if(action==='protected' && controlled.has(id))guards[id]='protected';
    if(action==='auto')delete guards[id];
  }
  const bulk = el('select',{'aria-label':'Bulk permission action'},el('option',{value:''},'Bulk actions…'), ...[['observe','Allow observation'],['control','Allow interaction'],['stop-control','Remove interaction'],['hide','Hide from Carvis'],['protected','Require confirmation'],['auto','Use automatic guards']].map(([value,text])=>el('option',{value},text)));
  bulk.addEventListener('change',()=>{if(!bulk.value)return;for(const e of visible())if(selected.has(e.entity_id))setPermission(e.entity_id,bulk.value);bulk.value='';render();});
  const selectAll=button('Select all shown',()=>{const rows=visible(),all=rows.length && rows.every(e=>selected.has(e.entity_id));for(const e of rows)all?selected.delete(e.entity_id):selected.add(e.entity_id);render();},'compact');
  function render(){
    const matches=visible();
    count.textContent=`${matches.length} entities · ${observed.size} observed · ${controlled.size} interactive · ${matches.filter(e=>selected.has(e.entity_id)).length} marked for bulk edits`;
    heading.textContent=room==='*'?'All rooms':room===''?'Unassigned':entities.find(e=>e.area_id===room)?.area_name || room;
    rooms.replaceChildren();
    const areas=new Map(entities.filter(e=>e.area_id).map(e=>[e.area_id,e.area_name || e.area_id]));
    for(const [id,name] of [['*','All rooms'],...([...areas].sort((a,b)=>a[1].localeCompare(b[1]))),...entities.some(e=>!e.area_id)?[['','Unassigned']]:[]]){
      const b=button(name,()=>{room=id;render();},'entity-room');b.prepend(icon(id==='*'?'grid':'home'));b.setAttribute('aria-pressed',String(room===id));rooms.append(b);
    }
    selectAll.textContent=matches.length && matches.every(e=>selected.has(e.entity_id))?'Clear selection':'Select all shown';selectAll.disabled=!matches.length;bulk.disabled=!matches.some(e=>selected.has(e.entity_id));
    list.replaceChildren();
    if(!matches.length){list.append(el('p',{class:'empty-card'},loaded?'No entities match these filters.':'Save the connection, then load entities to choose what Carvis can see.'));return;}
    const table=el('table',{class:'entity-table'}),body=el('tbody');
    table.append(el('thead',{},el('tr',{},...['Select','Entity','Type','State','Observe','Interact','Guard'].map((s,i)=>el('th',{scope:'col'},s,...(i>=4?[el('small',{},['Can view state','Can control','Confirmation policy'][i-4])]:[]))))),body);
    for(const e of matches){
      const id=e.entity_id,name=e.name || id;
      const mark=input(`mark-${id}`,'','checkbox',{checked:selected.has(id),'aria-label':`Select ${name} for bulk edits`});mark.addEventListener('change',()=>{mark.checked?selected.add(id):selected.delete(id);render();});
      const see=input(`observe-${id}`,'','checkbox',{checked:observed.has(id),'aria-label':`Let Carvis see ${name}`});see.addEventListener('change',()=>{setPermission(id,see.checked?'observe':'hide');render();});
      const control=input(`control-${id}`,'','checkbox',{checked:controlled.has(id),'aria-label':`Let Carvis control ${name}`});control.addEventListener('change',()=>{setPermission(id,control.checked?'control':'stop-control');render();});
      const guard=el('select',{'aria-label':`Confirmation for ${name}`,disabled:!controlled.has(id)},...[['','Auto · device default'],['standard','Standard'],['protected','Require confirmation']].map(([value,text])=>el('option',{value,selected:(guards[id] || '')===value},text)));
      guard.addEventListener('change',()=>{if(guard.value)guards[id]=guard.value;else delete guards[id];});
      body.append(el('tr',{'data-selected':selected.has(id)?'true':'false'},el('td',{},mark),el('td',{},el('div',{class:'entity-name-cell'},icon(domainIcon(e.domain)),el('div',{},el('strong',{},name),el('small',{},id)))),el('td',{},label(e.domain)),el('td',{},el('span',{class:`entity-state ${e.state==='on'?'is-on':''}`},e.state==null?'Unavailable':`${label(e.state)}${e.unit?' '+e.unit:''}`)),el('td',{},see),el('td',{},control),el('td',{},guard)));
    }
    list.append(table);
  }
  const load=button('Load entities',async()=>{
    load.disabled=true;feedback.replaceChildren();
    try{
      const result=await api('/api/integrations/home-assistant/entities');entities=(result.entities || []).map(e=>({...e,domain:e.domain || e.entity_id.split('.')[0]}));
      const known=new Set(entities.map(e=>e.entity_id));for(const id of observed)if(!known.has(id))entities.push({entity_id:id,name:id,domain:id.split('.')[0],state:'unavailable'});
      loaded=true;const current=type.value;type.replaceChildren(el('option',{value:''},'All types'),...[...new Set(entities.map(e=>e.domain))].sort().map(value=>el('option',{value},label(value))));type.value=current;
      if(room!=='*' && room!=='' && !entities.some(e=>e.area_id===room))room='*';
      if(result.areaWarning)formNotice(feedback,result.areaWarning);load.textContent='Refresh entities';render();
    }catch(error){formNotice(feedback,errorText(error));}finally{load.disabled=false;}
  },'compact','refresh');
  search.addEventListener('input',render);type.addEventListener('change',render);only.addEventListener('change',render);render();
  if (config.baseUrl && (config.hasToken || config.token)) queueMicrotask(() => load.click());
  return {node:el('section',{class:'entity-section entity-manager'},el('div',{class:'entity-manager-title'},icon('home'),el('div',{},el('h3',{},'Entity management'),el('p',{class:'small muted'},'Choose what Carvis can see and control. Changes apply when you save.')),load),rooms,el('div',{class:'entity-filterbar'},search,type,el('label',{class:'check-label'},only,'Show selected only')),feedback,el('div',{class:'entity-table-heading'},el('div',{},heading,count),el('div',{class:'action-row'},selectAll,bulk)),list,el('p',{class:'small muted'},'Rooms come from Home Assistant. State is a read-only snapshot. Unobserved entities remain hidden from Carvis. Guards keep the existing Auto, Standard, and Require confirmation behavior.')),value:()=>({observed:[...observed],controlled:[...controlled],guards})};
}

function renderGlobalKeys() {
  const feedback=el('div'), controls=[];
  const form=el('form',{class:'settings-card full'},el('h2',{},'Global API keys'),el('p',{},'Save a service key once for integrations to reuse. Your saved OpenAI model key is shared automatically. A separate key in an integration overrides the shared key. Compatible providers keep their own key; select Main provider in Model Router to use that connection.'));
  for(const [id,label] of [['openai','OpenAI'],['anthropic','Anthropic'],['deepgram','Deepgram'],['assemblyai','AssemblyAI'],['gemini','Google Gemini']]){
    const status=state.data.apiKeys?.[id];
    const key=input(id,'','password',{autocomplete:'new-password',placeholder:status?.saved?'Saved · leave blank to keep':'Optional API key'});
    const clear=input(`remove-${id}`,'','checkbox');
    form.append(field(label,key,status?.fromMainProvider?'Using your saved OpenAI key from the main model settings.':status?.saved?'Shared key saved.':'Add only the services you use.'));
    if(status?.saved&&!status.fromMainProvider)form.append(el('label',{class:'field checkbox'},clear,el('span',{},`Remove shared ${label} key`)));
    controls.push({id,key,clear});
  }
  const save=el('button',{class:'button primary',type:'submit'},'Save API keys');form.append(feedback,save);
  form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;try{
    const apiKeys=Object.fromEntries(controls.filter(c=>c.clear.checked||c.key.value.trim()).map(c=>[c.id,c.clear.checked?null:c.key.value.trim()]));
    await api('/api/settings',{method:'POST',body:{apiKeys}});await refreshState();form.replaceWith(renderGlobalKeys());toast('Global API keys saved.');
  }catch(error){formNotice(feedback,errorText(error));}finally{save.disabled=false;}});
  return form;
}

function renderModelRouter() {
  const card = el("section", {class:"settings-card full"},
    el("h2",{},"Model Router"),
    el("p",{},"Choose which AI models your enabled integrations use. Save each integration separately. Model changes here also appear in its settings."));
  const entries = modelRouterEntries(state.data.integrations || []);
  if (!entries.length) card.append(el("p",{class:"small muted"},"Enable an integration that uses AI to see its model controls here."),el("a",{class:"button quiet",href:"#integrations"},"Browse integrations"));
  let catalog;
  const primaryModels = () => catalog ||= api('/api/models',{method:'POST',body:{}});
  const engine = (state.data.integrations || []).find(i=>i.id==='assistant-engine');
  const providers = engine?.config?.models__providers || engine?.fields?.find(f=>f.key==='models__providers')?.default || [];
  for (const {integration,fields,note} of entries) {
    const cfg=integration.config || {}, updates=[], feedback=el('div');
    const form=el('form',{class:'control-card'},el('h3',{},integration.name));
    if(note)form.append(el('p',{class:'small muted'},note));
    for (const definition of fields) {
      const providerKey=definition.key.startsWith('models__roles__')?definition.key.replace(/__model$/,'__provider'):null;
      const providerField=integration.fields.find(f=>f.key===providerKey);
      const savedProvider=providerField ? (cfg[providerKey] ?? providerField.default) : null;
      const current=cfg[definition.key] ?? definition.default ?? '';
      const label=definition.label || definition.key;
      const select=el('select',{'aria-label':`${integration.name}: ${label}`});
      const custom=input(definition.key,current,'text',{maxlength:120,placeholder:'Model ID from this service'});
      const customField=field('Custom model ID',custom);
      const status=el('p',{class:'small muted',role:'status'});
      let revision=0;
      const populate=(models=[])=>{
        const value=custom.value;
        select.replaceChildren(el('option',{value:''},'Service default / not set'),...models.map(id=>el('option',{value:id},id)),el('option',{value:'__custom'},'Enter a custom model ID…'));
        select.value=models.includes(value)?value:value?'__custom':'';customField.hidden=select.value!=='__custom';
      };
      select.addEventListener('change',()=>{customField.hidden=select.value!=='__custom';if(select.value!=='__custom')custom.value=select.value;});
      let providerSelect;
      const discover=async()=>{
        const version=++revision;populate();
        if(providerSelect?.value!=='carvis-primary') {status.textContent='Use a model supported by this service. Its connection and credentials are managed in integration settings.';return;}
        status.textContent='Loading models from your saved main provider…';
        try {const result=await primaryModels();if(version!==revision)return;populate(result.models);status.textContent='Choose a model suitable for this task; image understanding needs a vision model.';}
        catch(error){if(version===revision)status.textContent=errorText(error);}
      };
      if(providerField){
        const options=new Map([['carvis-primary','Main provider (from Carvis Settings)'],...providers.map(p=>[p.id,p.label || p.id])]);
        if(savedProvider&&!options.has(savedProvider))options.set(savedProvider,savedProvider);
        providerSelect=el('select',{'aria-label':`${integration.name}: ${label} provider`},...Array.from(options,([value,text])=>el('option',{value},text)));
        providerSelect.value=savedProvider || 'carvis-primary';
        providerSelect.addEventListener('change',()=>{custom.value='';void discover();});
        form.append(field(label.replace(/model$/i,'provider'),providerSelect));
      }
      form.append(field(label,select),customField,status);
      updates.push(()=>({...{[definition.key]:custom.value.trim()},...(providerSelect?{[providerKey]:providerSelect.value}:{})}));
      void discover();
    }
    form.append(el('a',{href:`#integrations/${integration.id}/settings`,class:'small'},'Connection and advanced settings'));
    if(fields.length){
      const save=el('button',{type:'submit',class:'button'},'Save models');form.append(feedback,save);
      form.addEventListener('submit',async event=>{
        event.preventDefault();save.disabled=true;
        try {
          await api(`/api/integrations/${encodeURIComponent(integration.id)}`,{method:'PUT',body:{config:Object.assign({},...updates.map(read=>read()))}});
          await refreshState();formNotice(feedback,'Model routing saved.',true);
        }catch(error){formNotice(feedback,errorText(error));}finally{save.disabled=false;}
      });
    }else form.addEventListener('submit',event=>event.preventDefault());
    card.append(form);
  }
  return card;
}

function renderSettings(main) {
  const profile = state.data.profile || {},
    model = state.data.model || {};
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
    ['friendly', 'Friendly companion', 'Be warm, approachable, and conversational. Use everyday language, show interest without flattery, and keep replies concise unless I ask for detail. Ask a brief clarifying question when needed.'],
    ['concise', 'Straight to the point', 'Be direct, practical, and brief. Lead with the answer or outcome. Skip filler and unnecessary acknowledgements. Use short steps when explaining a task, and expand only when I ask.'],
    ['professional', 'Professional assistant', 'Be polished, organized, and dependable. Use a calm, professional tone and clear explanations. Summarize decisions, highlight relevant tradeoffs, and make next steps easy to follow.'],
    ['coach', 'Patient coach', 'Be patient, encouraging, and practical. Break unfamiliar tasks into manageable steps. Explain the why when it helps, adapt to my experience, and ask useful questions without turning every reply into a lesson.'],
    ['creative', 'Creative collaborator', 'Be curious, imaginative, and lightly playful. Help me explore ideas with concrete examples and useful alternatives. Offer your own thoughtful opinion, keep suggestions grounded, and avoid overwhelming me with options.'],
    ['jarvis', 'Jarvis', 'Speak like a composed, highly capable British personal assistant: articulate, discreet, observant, and quietly witty. Use understated dry humour sparingly. Keep routine acknowledgements short and precise; explain complex matters clearly when asked. Anticipate useful next steps and offer them tactfully, without being pushy. Stay calm when things go wrong, state what happened plainly, and suggest a practical remedy. Avoid theatrical speeches, excessive deference, and repeatedly calling me sir. Never claim an action succeeded until its result confirms it.'],
  ];
  const preset = el('select', {name:'personalityPreset'}, el('option',{value:''},'Custom personality'), ...personalityPresets.map(([value,label])=>el('option',{value},label)));
  const syncPreset = () => { preset.value = personalityPresets.find(([, ,text])=>text===personality.value)?.[0] || ''; };
  preset.addEventListener('change',()=>{ const choice=personalityPresets.find(([id])=>id===preset.value); if(choice)personality.value=choice[2]; });
  personality.addEventListener('input',syncPreset);syncPreset();
  const profileFeedback = el("div");
  const saveProfile = el(
    "button",
    { type: "submit", class: "button primary" },
    "Save personality",
  );
  const profileForm = el(
    "form",
    {
      class: "settings-card",
      onsubmit: async (event) => {
        event.preventDefault();
        saveProfile.disabled = true;
        try {
          await api("/api/settings", {
            method: "POST",
            body: {
              profile: {
                displayName: display.value,
                assistantName: assistant.value,
                personality: personality.value,
              },
            },
          });
          await refreshState();
          formNotice(profileFeedback, "Your preferences are saved.", true);
        } catch (error) {
          formNotice(profileFeedback, errorText(error));
        } finally {
          saveProfile.disabled = false;
        }
      },
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
    field("Personality preset", preset, "Choose a starting point, then edit it below. Save personality to apply."),
    field(
      "Personality & preferences",
      personality,
      "For example: warm, concise, a little witty. Ask before making assumptions.",
    ),
    profileFeedback,
    saveProfile,
  );
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
  const modelSelect = el('select', {'aria-label':'Model'}, el('option',{value:''},'Available models appear here'),el('option',{value:'__custom'},'Enter a custom model ID…'));
  const customModel = field('Custom model ID',modelName,'Use this if your provider does not list models.');
  modelSelect.value=model.model?'__custom':'';customModel.hidden=!model.model;modelName.required=!!model.model;
  const modelListStatus=el('p',{class:'field-description',role:'status'},'Enter your API key to see available models automatically.');
  let modelListVersion=0;
  const loadModels=async()=>{
    const version=++modelListVersion;modelListStatus.textContent='Loading available models…';
    try {
      const result=await api('/api/models',{method:'POST',body:{provider:provider.value,baseUrl:provider.value==='openai'?'https://api.openai.com/v1':baseUrl.value,apiKey:apiKey.value,clearApiKey:clearKey.checked}});
      if(version!==modelListVersion)return;
      modelSelect.replaceChildren(el('option',{value:''},'Choose a model'),...result.models.map(id=>el('option',{value:id},id)),el('option',{value:'__custom'},'Enter a custom model ID…'));
      modelSelect.value=result.models.includes(modelName.value)?modelName.value:modelName.value?'__custom':'';
      customModel.hidden=modelSelect.value!=='__custom';modelName.required=!customModel.hidden;
      modelListStatus.textContent=result.models.length?`${result.models.length} models available. Choose a chat model; the provider may also list image and audio models.`:'No models returned. You can enter a custom ID.';
    } catch(error){if(version===modelListVersion)modelListStatus.textContent=errorText(error);}
  };
  modelSelect.addEventListener('change',()=>{customModel.hidden=modelSelect.value!=='__custom';modelName.required=!customModel.hidden;if(modelSelect.value!=='__custom')modelName.value=modelSelect.value;});
  const invalidateModels=()=>{modelListVersion++;modelSelect.replaceChildren(el('option',{value:''},'Available models appear here'),el('option',{value:'__custom'},'Enter a custom model ID…'));modelSelect.value='';modelName.value='';customModel.hidden=true;modelName.required=false;modelListStatus.textContent='Waiting for connection details…';};
  let discoveryTimer;
  const scheduleModels=()=>{
    clearTimeout(discoveryTimer);modelListVersion++;
    const ready=provider.value==='openai' ? Boolean(apiKey.value || (model.hasApiKey && model.provider==='openai' && !clearKey.checked)) : Boolean(baseUrl.value);
    if(!ready){modelListStatus.textContent='Enter your connection details to see available models.';return;}
    discoveryTimer=setTimeout(()=>{if(modelSelect.isConnected)void loadModels();},700);
  };
  provider.addEventListener('change',()=>{invalidateModels();queueMicrotask(scheduleModels);});
  baseUrl.addEventListener('input',()=>{invalidateModels();scheduleModels();});
  apiKey.addEventListener('input',scheduleModels);
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
  clearKey.addEventListener("change",scheduleModels);
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
        if (!modelName.value || !modelSelect.value) { formNotice(modelFeedback,"Choose a model or enter a custom ID."); return; }
        saveModel.disabled = true;
        try {
          const update = {
            provider: provider.value,
            baseUrl:
              provider.value === "openai"
                ? "https://api.openai.com/v1"
                : baseUrl.value,
            model: modelSelect.value === "__custom" ? modelName.value : modelSelect.value,
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
  if (model.hasApiKey || model.provider === "ollama") queueMicrotask(scheduleModels);
  const memoryCard = el(
    "section",
    { class: "settings-card full" },
    el("h2", {}, "Memory"),
    el(
      "p",
      {},
      "Let Carvis remember preferences and useful context. Set up and manage this feature in the Memory & patterns integration.",
    ),
    el(
      "a",
      { class: "button", href: "#integrations/learned-memory/settings" },
      "Enable Memory Integration",
      icon("arrow"),
    ),
  );
  main.replaceChildren(
    el(
      "section",
      { class: "page" },
      pageHeading(
        "YOUR SPACE, YOUR PREFERENCES",
        "Settle in.",
        "Choose how Carvis thinks, how it talks, and what it remembers about you.",
      ),
      el("div", { class: "settings-grid" }, profileForm, modelForm, renderGlobalKeys(), renderModelRouter(), memoryCard),
    ),
  );
}

boot();
