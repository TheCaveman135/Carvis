import { el, button, errorText } from "./ui.js";

/** Owner confirmation for spoken requests that need an explicit decision. */
export function mountVoiceConfirmation({ api }) {
  const endpoint = "/integrations/assistant-engine/api/glasses/confirmation";
  const title = el("h2", {}, "Carvis needs your approval");
  const prompt = el("p");
  const expiry = el("p", { class: "small muted" });
  const feedback = el("p", { role: "status" });
  const accept = button("Approve request", () => void decide(true), "primary");
  const decline = button("Decline request", () => void decide(false), "quiet");
  const card = el(
    "section",
    {
      class: "control-card voice-confirmation",
      "aria-label": "Approve or decline a Carvis voice request",
      hidden: true,
    },
    title,
    prompt,
    expiry,
    el("div", { class: "action-row" }, accept, decline),
  );
  const root = el("div", { class: "voice-confirmation-wrap" }, card, feedback);
  let current = null,
    polling = false,
    deciding = false,
    disposed = false;
  const show = (confirmation) => {
    current = confirmation && confirmation.expiresAt > Date.now()
      ? confirmation
      : null;
    card.hidden = !current;
    if (!current) return;
    prompt.textContent = current.prompt || "Allow this action?";
    const seconds = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
    expiry.textContent = `Expires in ${seconds} second${seconds === 1 ? "" : "s"}.`;
    accept.disabled = deciding;
    decline.disabled = deciding;
  };
  const poll = async () => {
    if (disposed || polling || deciding) return;
    polling = true;
    try {
      const result = await api(endpoint);
      if (disposed || deciding) return;
      if (result.confirmation?.id !== current?.id) feedback.textContent = "";
      show(result.confirmation);
    } catch (error) {
      if (!disposed && current) {
        feedback.textContent = errorText(error);
        show(null);
      }
    } finally {
      polling = false;
    }
  };
  const decide = async (accepted) => {
    if (!current || deciding || disposed) return;
    const id = current.id;
    deciding = true;
    accept.disabled = true;
    decline.disabled = true;
    feedback.textContent = accepted ? "Approving…" : "Declining…";
    try {
      const result = await api(endpoint, {
        method: "POST",
        body: { id, accepted },
      });
      if (disposed) return;
      show(result.confirmation);
      feedback.textContent =
        (result.error || result.outcome === "error")
          ? result.error || "The action failed after approval."
          : accepted
            ? "Approval sent. The result will appear below."
            : "Request declined.";
    } catch (error) {
      if (!disposed) feedback.textContent = errorText(error);
    } finally {
      deciding = false;
      if (!disposed) {
        accept.disabled = false;
        decline.disabled = false;
        void poll();
      }
    }
  };
  void poll();
  const timer = setInterval(() => {
    if (current) show(current);
    void poll();
  }, 1000);
  return {
    root,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}
