"use strict";

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
    throw new Error(data.error || `Request failed (${response.status}).`);
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
  const version = ++state.navVersion;
  const [page, encodedId] = location.hash.replace(/^#/, "").split("/");
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
  if (state.page === "integrations") renderIntegrations(main);
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
  { id: "home-devices", name: "Home & devices", description: "Give Carvis a clear, permission-based connection to your physical world.", icon: "home" },
  { id: "voice-display", name: "Voice & display", description: "Choose how you talk to Carvis and where its replies appear.", icon: "glasses" },
  { id: "intelligence-routines", name: "Intelligence & routines", description: "Add useful context, reasoning, and routines when you need them.", icon: "spark" },
  { id: "connected-services", name: "Connected services", description: "Bring your other tools and services into the conversation.", icon: "plug" },
];
function integrationCategory(integration) {
  const supplied = String(integration.category?.id || integration.category || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const aliases = { "home-and-devices": "home-devices", home: "home-devices", devices: "home-devices", "voice-and-display": "voice-display", voice: "voice-display", display: "voice-display", "intelligence-and-routines": "intelligence-routines", intelligence: "intelligence-routines", routines: "intelligence-routines", services: "connected-services" };
  const mapped = aliases[supplied] || supplied;
  if (integrationCategories.some(category => category.id === mapped)) return mapped;
  if (["home-assistant", "apple-tv"].includes(integration.id)) return "home-devices";
  if (integration.id === "even-realities") return "voice-display";
  return "connected-services";
}
function integrationDependencies(integration, key = "dependsOn") {
  return (Array.isArray(integration[key]) ? integration[key] : []).map(value => {
    const id = typeof value === "string" ? value : value?.id;
    const dependency = (state.data.integrations || []).find(item => item.id === id);
    return { id, name: dependency?.name || value?.label || id || "Unknown integration", enabled: Boolean(dependency?.enabled), optional: Boolean(value?.optional), integration: dependency };
  });
}
function integrationWorkspaceUrl(value) {
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
function integrationWorkspaceMissing(integration) {
  return [...new Map([...integrationDependencies(integration), ...integrationDependencies(integration, "workspaceDependsOn")]
    .filter(item => !item.optional && !item.enabled).map(item => [item.id, item])).values()];
}
function integrationMatchesSearch(integration, query) {
  const category = integrationCategories.find(group => group.id === integrationCategory(integration));
  const fields = (integration.fields || []).flatMap(field => [field.label, field.description, field.help, typeof field.group === "string" ? field.group : field.group?.label, String(field.key || "").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("__", " ")]);
  const text = [integration.name, integration.description, category?.name, ...fields].filter(Boolean).join(" ").toLowerCase();
  return String(query).trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}
function integrationWorkspaceLink(integration, className = "button compact quiet") {
  const url = integrationWorkspaceUrl(integration.workspaceUrl);
  if (!url || !integration.enabled) return null;
  const missing = integrationWorkspaceMissing(integration);
  if (missing.length) return el("p", { class: "workspace-unavailable" }, icon("info"), `Enable ${missing.map(item => item.name).join(", ")} to open this workspace.`);
  return el("a", { class: className, href: url, target: "_blank", rel: "noopener", "aria-label": `Open ${integration.name} workspace in a new tab` }, "Open workspace", icon("arrow"));
}
function integrationCard(integration) {
  const status = integrationStatus(integration), dependencies = integrationDependencies(integration);
  return el("article", { class: "integration-card", "data-integration": integration.id },
    el("div", { class: "integration-top" }, el("div", { class: "integration-icon" }, icon(paths[integration.icon] ? integration.icon : integrationIcon(integration.id))),
      el("div", { class: `integration-status ${status.tone}` }, el("span", { class: `status-dot${status.tone === "off" ? " off" : status.tone === "attention" ? " attention" : ""}` }), status.label)),
    el("h3", {}, integration.name), el("p", {}, integration.description),
    dependencies.length ? el("div", { class: "card-dependencies" }, dependencies.map(item => el("span", { class: !item.enabled && !item.optional ? "dependency-missing" : "" }, `${item.optional ? "Works with" : "Requires"} ${item.name}${!item.enabled ? " · disabled" : ""}`))) : null,
    el("div", { class: "integration-footer" }, el("span", { class: "version" }, `v${integration.version || "1.0.0"}`), button(integration.configured ? "Configure" : "Set up", () => configureIntegration(integration), "compact", "settings")),
    integrationWorkspaceLink(integration, "integration-workspace-link"));
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
    pageHeading("MAKE IT YOURS", "More possibilities. Your choice.", "Connect your devices, shape how Carvis responds, and add new abilities. Everything has a place; you choose what to turn on."),
    el("div", { class: "integration-overview" }, el("div", {}, el("span", { class: "overview-number" }, String(enabled)), el("span", { class: "overview-label" }, "integrations enabled")),
      el("p", {}, enabled ? "Your enabled integrations add tools and context to Carvis. Their settings and workspaces are always here." : "Start with a conversation. Enable an integration whenever you’re ready for more."), el("span", { class: "overview-total" }, `${integrations.length} available`)),
    el("div", { class: "catalog-toolbar" }, filters, el("div", { class: "catalog-search" }, icon("search"), search)), resultCount, groups,
    el("div", { class: "integration-banner" }, icon("shield"), el("div", {}, el("h3", {}, "A capable assistant. Clear boundaries."), el("p", {}, "Integrations start disabled. You choose the connections, visible devices, and actions that need your confirmation."))),
    el("details", { class: "integration-help" }, el("summary", {}, "How does Carvis grow?"), el("p", {}, "New abilities arrive through integrations. Each has its own settings, permissions, and optional workspace. Your conversations, personality, and memory stay in one place."))));
  renderGroups();
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
function integrationFieldValue(definition, control) {
  const value = control.value, label = definition.label || definition.key;
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
function configureIntegration(integration) {
  const values = {}, cfg = integration.config || {}, feedback = el("div"), groups = new Map();
  const dependencies = integrationDependencies(integration), requiredMissing = dependencies.filter(item => !item.optional && !item.enabled);
  const enabled = input("enabled", "", "checkbox", { checked: integration.enabled, "aria-label": `Enable ${integration.name}` });
  const form = el("form", { class: "integration-settings-form", novalidate: true });
  const permissionText = (integration.permissions || []).map(permission => el("li", {}, icon("check"), typeof permission === "string" ? permission : permission.description || permission.name || "Integration access"));
  form.append(el("div", { class: "switch-row" }, el("div", {}, el("strong", {}, "Enable integration"), el("p", {}, "Allow Carvis to use this integration after you save.")), el("label", { class: "switch" }, enabled)));
  if (dependencies.length) form.append(el("div", { class: `integration-dependencies${requiredMissing.length ? " attention" : ""}` }, el("h3", {}, "Works with"), dependencies.map(item => el("div", { class: "dependency-row" }, el("div", {}, el("strong", {}, item.name), el("span", {}, item.optional ? "Optional connection" : "Required integration")), el("span", { class: `dependency-state${!item.enabled ? " off" : ""}` }, item.enabled ? "Enabled" : item.integration ? "Disabled" : "Not installed"))), requiredMissing.length ? el("p", {}, "Set up and enable the required integrations first. You can still save this integration’s settings while it is disabled.") : null));
  const permissions = el("details", { class: "integration-permissions" }, el("summary", {}, `Access & abilities${permissionText.length ? ` · ${permissionText.length}` : ""}`), permissionText.length ? el("ul", {}, permissionText) : el("p", { class: "small muted" }, "No extra permissions declared."));
  form.append(permissions);
  const workspace = integrationWorkspaceLink(integration, "button quiet compact");
  if (workspace) form.append(el("div", { class: "settings-workspace" }, el("div", {}, el("strong", {}, "Integration workspace"), el("p", {}, "Open its controls and detailed activity in a separate tab.")), workspace));
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
      const tab = el("button", { type: "button", class: "integration-settings-tab", id: tabId, role: "tab", "aria-controls": panelId, "aria-selected": "false", tabindex: "-1", onclick: () => activate(metadata.id) }, metadata.label);
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
    if (f.type === "boolean") control = input(f.key, "", "checkbox", { checked: Boolean(value ?? (integration.id === "home-assistant" && f.key === "dryRun")) });
    else if (f.type === "select") control = el("select", { name: f.key }, (!f.required && value === undefined) ? el("option", { value: "" }, "Choose an option") : null, (f.options || []).map(option => el("option", { value: typeof option === "string" ? option : option.value, selected: String(typeof option === "string" ? option : option.value) === String(value) }, typeof option === "string" ? option : option.label)));
    else if (["entities", "string-array", "string_array"].includes(f.type)) control = el("textarea", { name: f.key, rows: "4", placeholder: f.placeholder || "One item per line" }, Array.isArray(value) ? value.join("\n") : value ?? "");
    else if (["textarea", "json"].includes(f.type)) control = el("textarea", { name: f.key, rows: f.type === "json" ? "7" : "4", class: f.type === "json" ? "json-input" : "", spellcheck: f.type === "json" ? "false" : "true", placeholder: f.placeholder || (f.type === "json" ? "[] or {}" : "") }, typeof value === "object" || f.type === "json" && value !== undefined && typeof value !== "string" ? JSON.stringify(value, null, 2) : value ?? "");
    else control = input(f.key, f.type === "password" ? "" : value ?? "", ["password", "url", "number"].includes(f.type) ? f.type : "text", { autocomplete: f.type === "password" ? "new-password" : "off", min: f.min ?? f.minimum, max: f.max ?? f.maximum, step: f.type === "number" ? f.step ?? "any" : undefined, placeholder: f.type === "password" ? cfg[`has${f.key[0].toUpperCase()}${f.key.slice(1)}`] ? "Saved · leave blank to keep" : "Enter your secret" : f.placeholder || "" });
    let hasSecret = Boolean(cfg[`has${f.key[0].toUpperCase()}${f.key.slice(1)}`]);
    const updateRequired = () => { control.required = Boolean(enabled.checked && f.required && (f.type !== "password" || !hasSecret)); };
    updateRequired(); enabled.addEventListener("change", updateRequired);
    control.addEventListener("input", () => control.setCustomValidity(""));
    values[f.key] = { control, field: f, groupId: group.id };
    const description = [f.description, f.help, ["string-array", "string_array"].includes(f.type) ? "Enter one value per line." : f.type === "json" ? "Use JSON for lists or structured settings. Leave blank to keep the saved value; use [] or {} to clear it." : null].filter((text, index, all) => typeof text === "string" && text && all.indexOf(text) === index).join(" ");
    group.panel.append(f.type === "boolean" ? el("label", { class: "field checkbox" }, control, el("span", {}, el("span", { class: "field-label" }, f.label || f.key), description ? el("span", { class: "field-description" }, description) : null)) : field(f.label || f.key, control, description));
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
  if (groups.size) { form.append(tabs, panels); activate(groups.keys().next().value); }
  else form.append(el("p", { class: "small muted" }, "This integration has no additional settings."));
  const collectConfig = () => {
    const config = {};
    for (const [key, entry] of Object.entries(values)) {
      const { control, field: definition, groupId } = entry;
      if (!control.checkValidity()) { activate(groupId); control.reportValidity(); throw new Error(`${definition.label || key}: ${control.validationMessage}`); }
      try { const value = integrationFieldValue(definition, control); if (value !== undefined) config[key] = value; }
      catch (error) { control.setCustomValidity(errorText(error)); activate(groupId); control.reportValidity(); throw error; }
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
  form.append(feedback, el("div", { class: "modal-footer" }, test, save));
  form.addEventListener("submit", async event => {
    event.preventDefault(); save.disabled = true; feedback.replaceChildren();
    try {
      const config = collectConfig();
      if (enabled.checked && requiredMissing.length) throw new Error(`Enable ${requiredMissing.map(item => item.name).join(", ")} before enabling ${integration.name}.`);
      await api(`/api/integrations/${encodeURIComponent(integration.id)}`, { method: "PUT", body: { enabled: enabled.checked, config } });
      await refreshState(); modal.close(); await route(); toast(`${integration.name} settings saved.`);
    } catch (error) { formNotice(feedback, errorText(error)); } finally { save.disabled = false; }
  });
  openModal(integration.name, integration.description, form);
  modal.classList.add("integration-settings-modal");
}
function makeEntitySelector(config) {
  const observed = new Set(config.observed || []),
    controlled = new Set(config.controlled || []),
    guards = { ...(config.guards || {}) };
  const list = el("div");
  const count = el("p", { class: "entity-count" });
  const search = input("entity-search", "", "search", {
    placeholder: "Find a device or entity",
    "aria-label": "Search entities",
  });
  let entities = [],
    loaded = false;
  const updateCount = () => {
    count.textContent = `${observed.size} visible · ${controlled.size} controllable`;
  };
  const render = () => {
    updateCount();
    list.replaceChildren();
    list.className = "entity-list";
    const query = search.value.toLowerCase();
    const matches = entities.filter((e) =>
      `${e.name} ${e.entity_id}`.toLowerCase().includes(query),
    );
    if (!matches.length) {
      list.append(
        el(
          "div",
          { class: "empty-card" },
          loaded
            ? "No matching entities."
            : "Save the connection, then load entities to choose what Carvis can see.",
        ),
      );
      return;
    }
    for (const entity of matches) {
      const see = input(`observe-${entity.entity_id}`, "", "checkbox", {
        checked: observed.has(entity.entity_id),
        "aria-label": `Let Carvis see ${entity.name || entity.entity_id}`,
      });
      const control = input(`control-${entity.entity_id}`, "", "checkbox", {
        checked: controlled.has(entity.entity_id),
        "aria-label": `Let Carvis control ${entity.name || entity.entity_id}`,
      });
      const guard = el(
        "select",
        {
          "aria-label": `Confirmation for ${entity.name || entity.entity_id}`,
          disabled: !control.checked,
        },
        el(
          "option",
          { value: "", selected: !guards[entity.entity_id] },
          "Auto · device default",
        ),
        el(
          "option",
          {
            value: "standard",
            selected: guards[entity.entity_id] === "standard",
          },
          "Standard",
        ),
        el(
          "option",
          {
            value: "protected",
            selected: guards[entity.entity_id] === "protected",
          },
          "Require confirmation",
        ),
      );
      see.addEventListener("change", () => {
        if (see.checked) observed.add(entity.entity_id);
        else {
          observed.delete(entity.entity_id);
          controlled.delete(entity.entity_id);
          delete guards[entity.entity_id];
          guard.value = "";
          control.checked = false;
          guard.disabled = true;
        }
        updateCount();
      });
      control.addEventListener("change", () => {
        if (control.checked) {
          controlled.add(entity.entity_id);
          observed.add(entity.entity_id);
          see.checked = true;
        } else {
          controlled.delete(entity.entity_id);
          delete guards[entity.entity_id];
          guard.value = "";
        }
        guard.disabled = !control.checked;
        updateCount();
      });
      guard.addEventListener("change", () => {
        if (guard.value) guards[entity.entity_id] = guard.value;
        else delete guards[entity.entity_id];
      });
      list.append(
        el(
          "div",
          { class: "entity-row" },
          el("div", { class: "entity-title" }, entity.name || entity.entity_id),
          el("div", { class: "entity-id" }, entity.entity_id),
          el(
            "div",
            { class: "entity-options" },
            el("label", { class: "check-label" }, see, "Visible"),
            el("label", { class: "check-label" }, control, "Control"),
            guard,
          ),
        ),
      );
    }
  };
  const feedback = el("div");
  const load = button(
    "Load entities",
    async () => {
      load.disabled = true;
      feedback.replaceChildren();
      try {
        const result = await api("/api/integrations/home-assistant/entities");
        entities = result.entities || [];
        loaded = true;
        render();
      } catch (error) {
        formNotice(feedback, errorText(error));
      } finally {
        load.disabled = false;
      }
    },
    "compact",
    "refresh",
  );
  search.addEventListener("input", render);
  render();
  return {
    node: el(
      "section",
      { class: "entity-section" },
      el("h3", {}, "Choose the devices Carvis can see"),
      el(
        "p",
        { class: "small muted" },
        "Only selected entities are shared with Carvis. “Control” allows actions; “Require confirmation” asks you before each action.",
      ),
      el("div", { class: "entity-toolbar" }, search, load),
      feedback,
      count,
      list,
    ),
    value: () => ({
      observed: [...observed],
      controlled: [...controlled],
      guards,
    }),
  };
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
        saveModel.disabled = true;
        try {
          const update = {
            provider: provider.value,
            baseUrl:
              provider.value === "openai"
                ? "https://api.openai.com/v1"
                : baseUrl.value,
            model: modelName.value,
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
    field(
      "Model",
      modelName,
      "Enter the exact model ID available to your provider account.",
    ),
    keyField,
    clearField,
    modelFeedback,
    saveModel,
  );
  const memoryInput = input("memory", "", "text", {
    required: true,
    maxlength: 2000,
    placeholder: "For example: I prefer short answers with practical examples.",
    "aria-label": "New memory",
  });
  const memoryList = el("div", { class: "memory-list" });
  const memoryFeedback = el("div");
  const renderMemories = () => {
    memoryList.replaceChildren();
    if (!state.data.memory?.length)
      memoryList.append(
        el(
          "p",
          { class: "small muted" },
          "A fresh start. Add only what you’d like Carvis to remember.",
        ),
      );
    for (const memory of state.data.memory || [])
      memoryList.append(
        el(
          "div",
          { class: "memory-item" },
          el("p", {}, memory.text),
          iconButton("Delete this memory", "trash", () =>
            act(async () => {
              await api(`/api/memory/${encodeURIComponent(memory.id)}`, {
                method: "DELETE",
              });
              await refreshState();
              renderMemories();
              toast("Memory removed.");
            }),
          ),
        ),
      );
  };
  renderMemories();
  const memorySubmit = el(
    "button",
    { type: "submit", class: "button" },
    icon("plus"),
    "Add memory",
  );
  const memoryForm = el(
    "form",
    {
      class: "memory-form",
      onsubmit: async (event) => {
        event.preventDefault();
        memorySubmit.disabled = true;
        try {
          await api("/api/memory", {
            method: "POST",
            body: { text: memoryInput.value.trim() },
          });
          memoryInput.value = "";
          await refreshState();
          renderMemories();
          memoryFeedback.replaceChildren();
          toast("Memory added.");
        } catch (error) {
          formNotice(memoryFeedback, errorText(error));
        } finally {
          memorySubmit.disabled = false;
        }
      },
    },
    memoryInput,
    memorySubmit,
  );
  const memoryCard = el(
    "section",
    { class: "settings-card full" },
    el("h2", {}, "Things worth remembering"),
    el(
      "p",
      {},
      "Keep useful context across conversations. Review, add, or remove it whenever you like.",
    ),
    memoryList,
    memoryForm,
    memoryFeedback,
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
      el("div", { class: "settings-grid" }, profileForm, modelForm, memoryCard),
    ),
  );
}

boot();
