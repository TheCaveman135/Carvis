import { readStreamEvents, createFrameRenderer } from "./stream-events.js";
import {
  $,
  el,
  icon,
  button,
  toast,
  errorText,
  timeLabel,
  field,
  input,
  formNotice,
  formattedText,
} from "./ui.js";

export function createChatView({
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
}) {
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
        placeholder: "Ask about your home or tell Carvis what to do…",
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
        title: "Check on your home",
        detail: "See what’s happening with your selected devices.",
        prompt:
          "Give me a brief status of the home devices you can see. Highlight anything that needs attention.",
      },
      {
        icon: "book",
        title: "Explore your home controls",
        detail: "Find out what Carvis can do for your home.",
        prompt:
          "What can you help me control in my home, using my selected devices and enabled integrations?",
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
      el("div", { class: "eyebrow" }, "YOUR HOME, WITH CARVIS."),
      el("h1", {}, "Your home,", el("br"), el("span", {}, "a request away.")),
      el(
        "p",
        { class: "welcome-description" },
        "Check your devices, control your rooms, and ask for help. Carvis works with the home and permissions you’ve set up.",
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
        const silent =
          message.role === "assistant" && message.silent && !message.content;
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
            {
              class: `message ${message.role}${silent ? " silent-result" : ""}`,
            },
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
    const renderer = createFrameRenderer(() => {
      if (state.page === "chat" && state.activeId === conversation?.id)
        renderMessages();
    });
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
      for await (const { type, data } of readStreamEvents(response.body)) {
        if (type === "delta") streaming.content += data.text || "";
        else if (type === "status") state.status = data.text || "";
        else if (type === "tool") {
          const existing = streaming.tools.findLast(
            (tool) => tool.name === data.name && tool.status === "running",
          );
          if (existing && data.status !== "running")
            Object.assign(existing, data);
          else streaming.tools.push(data);
        } else if (type === "confirmation")
          state.confirmations.push({
            ...data,
            conversationId: conversation.id,
          });
        else if (type === "done" && data.conversation) {
          conversation = data.conversation;
          if (state.activeId === conversation.id)
            state.conversation = conversation;
        } else if (type === "error")
          throw new Error(data.error || "The response could not be completed.");
        if (state.activeId === conversation.id) renderer.schedule();
      }
    } catch (error) {
      if (error.name === "AbortError")
        toast("Response stopped. Actions already sent may still finish.");
      else toast(errorText(error), true);
    } finally {
      renderer.cancel();
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

  return { renameConversation, deleteConversation, renderChat };
}
