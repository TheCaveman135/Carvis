import {
  AudioInputSource,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { Display } from "./display";
import { WidgetFocus } from "./focus";
import { UtteranceDetector, toBase64 } from "./audio";
import { parseCarvisUrl } from "../shared/connection.js";
import type { Hud, Result, Confirmation } from "./types";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = (message: string) => {
  $("status").textContent = message;
};
const fail = (error: unknown) => {
  $("error").textContent =
    error instanceof Error ? error.message : String(error);
};
const empty = (): Hud => ({
  revision: 0,
  slots: [null, null, null, null],
  reply: "",
  replyExpires: 0,
  voiceEnabled: false,
});
let hud = empty(),
  bridge: EvenAppBridge | undefined,
  display: Display | undefined;
let baseUrl = "",
  token = "",
  conversationId = "",
  connected = false,
  polling = false,
  disposed = false;
let microphone = false,
  micChanging = false,
  busy = false,
  confirmation: Confirmation | undefined;
let confirmationQueue: Confirmation[] = [];
let clickTimer: ReturnType<typeof setTimeout> | undefined,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
const focus = new WidgetFocus(),
  detector = new UtteranceDetector();
const storageKey = "carvis.connection.v1";
let lastCaption = "";

async function request<T>(path: string, body?: unknown): Promise<T> {
  if (!baseUrl || !token)
    throw new Error("Enter your Carvis URL and pairing token first.");
  const response = await fetch(
    `${baseUrl}/api/integrations/even-realities${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(
        path === "/audio" || path === "/chat" ? 120000 : 20000,
      ),
    },
  );
  const result = await response.json();
  if (!response.ok || result.error)
    throw new Error(
      result.error ||
        (response.status === 401
          ? "Pairing token rejected. Check the token and that the integration is enabled."
          : `Carvis returned ${response.status}.`),
    );
  return result;
}
function addMessage(role: string, text: string) {
  const item = document.createElement("div");
  item.className = "message";
  const label = document.createElement("b");
  label.textContent = role;
  item.append(label, document.createTextNode(text));
  $("messages").append(item);
  while ($("messages").children.length > 20)
    $("messages").firstElementChild?.remove();
  $("messages").scrollTop = $("messages").scrollHeight;
}
function caption() {
  if (confirmation) return `Confirm on your phone: ${confirmation.summary}`;
  return hud.replyExpires > Date.now() ? hud.reply : "";
}
async function render() {
  confirmationQueue = confirmationQueue.filter(
    (item) => !item.expiresAt || item.expiresAt > Date.now(),
  );
  if (confirmation?.expiresAt && confirmation.expiresAt <= Date.now()) {
    confirmation = confirmationQueue.shift();
    fail("The confirmation expired. Ask Carvis again to retry.");
  }
  focus.sync(hud);
  $("widgets").replaceChildren(
    ...hud.slots.map((widget, index) => {
      const slot = document.createElement("div");
      slot.className = `widget${focus.selected === index + 1 ? " selected" : ""}`;
      if (widget && !widget.display.blank) {
        const label = document.createElement("strong");
        label.textContent = widget.display.title;
        slot.append(
          label,
          document.createTextNode(
            focus.preview(widget) ?? widget.display.value,
          ),
        );
      }
      return slot;
    }),
  );
  const text = caption();
  $("caption").textContent = text;
  const mic = $<HTMLButtonElement>("mic");
  mic.disabled = !connected || !hud.voiceEnabled || !bridge || micChanging;
  mic.textContent = microphone ? "Mute microphone" : "Start microphone";
  $("voice-hint").textContent = !hud.voiceEnabled
    ? "Enable voice and set a speech provider in Integrations."
    : !bridge
      ? "Open in the Even app to use the glasses microphone."
      : microphone
        ? "Listening. Quiet audio stays on this device."
        : "Off. Tap here or tap the glasses with no widget selected.";
  $("approval").hidden = !confirmation;
  $("approval-text").textContent = confirmation?.summary ?? "";
  lastCaption = text;
  if (display && !disposed)
    await display.render(
      hud,
      focus,
      text.length > 180 ? `${text.slice(0, 177)}…` : text,
    );
}
function redraw() {
  render().catch(fail);
}
function apply(result: Result) {
  if (result.hud) hud = result.hud;
  if (result.conversationId) conversationId = result.conversationId;
  const incoming = [
    ...(result.confirmations ?? []),
    ...(result.requiresConfirmation && result.confirmation
      ? [result.confirmation]
      : []),
  ];
  for (const item of incoming)
    if (
      item.id !== confirmation?.id &&
      !confirmationQueue.some((pending) => pending.id === item.id)
    )
      confirmationQueue.push(item);
  confirmation ??= confirmationQueue.shift();
  if (result.reply) addMessage("Carvis", result.reply);
  if (result.error || result.success === false)
    fail(result.error || "The action did not complete.");
  if (result.dryRun) fail("Preview mode is on: the device was not changed.");
  redraw();
}
async function poll() {
  if (!connected || disposed || polling) return;
  polling = true;
  try {
    hud = await request<Hud>("/feed");
    status("Connected");
    if (!hud.voiceEnabled && microphone) await setMicrophone(false);
    await render();
  } catch (error) {
    status("Reconnecting");
    fail(error);
  } finally {
    polling = false;
    if (connected && !disposed) pollTimer = setTimeout(poll, 2000);
  }
}
async function saveConnection() {
  if (bridge && display)
    await display.run(() =>
      bridge!.setLocalStorage(
        storageKey,
        JSON.stringify({ baseUrl, token, conversationId }),
      ),
    );
}
async function connect(url: string, pairingToken: string) {
  const parsed = parseCarvisUrl(url);
  const nextToken = pairingToken.trim();
  if (nextToken.length < 32)
    throw new Error("Paste the complete device pairing token.");
  baseUrl = parsed.toString().replace(/\/+$/, "");
  token = nextToken;
  connected = false;
  clearTimeout(pollTimer);
  hud = await request<Hud>("/feed");
  connected = true;
  $<HTMLDetailsElement>("connection").open = false;
  status("Connected");
  $("error").textContent = "";
  void poll();
  await saveConnection();
  await render();
}
async function setMicrophone(enable: boolean) {
  if (micChanging) return;
  if (!bridge || !display)
    throw new Error("Open this app in Even Hub to use the microphone.");
  if (enable && (!connected || !hud.voiceEnabled))
    throw new Error("Configure voice transcription in Integrations first.");
  micChanging = true;
  redraw();
  detector.reset();
  try {
    const ok = await display.run(() =>
      bridge!.audioControl(enable, AudioInputSource.Glasses),
    );
    if (!ok)
      throw new Error(
        "The glasses microphone could not change state. Check microphone permission in the Even app.",
      );
    microphone = enable;
  } finally {
    micChanging = false;
    redraw();
  }
}
async function sendAudio(pcm: Uint8Array) {
  if (busy || !connected || disposed || confirmation) return;
  busy = true;
  detector.reset();
  status("Thinking");
  try {
    const result = await request<Result>("/audio", {
      pcmBase64: toBase64(pcm),
      conversationId: conversationId || undefined,
    });
    if (result.transcript) addMessage("You", result.transcript);
    apply(result);
    await saveConnection();
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    detector.reset();
    status(connected ? "Connected" : "Not connected");
  }
}
function cancelClick() {
  clearTimeout(clickTimer);
  clickTimer = undefined;
}
async function press() {
  if (disposed || busy || confirmation) return;
  if (!focus.selected) {
    await setMicrophone(!microphone);
    return;
  }
  const action = focus.press(hud);
  await render();
  if (!action) return;
  busy = true;
  try {
    apply(
      await request<Result>("/action", {
        ...action,
        requestId: crypto.randomUUID(),
      }),
    );
  } finally {
    busy = false;
  }
}
async function clearScreen() {
  cancelClick();
  focus.clear();
  hud = await request<Hud>("/clear");
  await render();
}
async function answer(accepted: boolean) {
  if (!confirmation || busy) return;
  busy = true;
  try {
    const result = await request<Result>("/confirm", {
      id: confirmation.id,
      accepted,
    });
    confirmation = confirmationQueue.shift();
    apply(result);
  } finally {
    busy = false;
    redraw();
  }
}
async function stop() {
  disposed = true;
  connected = false;
  microphone = false;
  detector.reset();
  cancelClick();
  clearTimeout(pollTimer);
  if (bridge && display) await display.run(() => bridge!.audioControl(false));
}
$("connect").addEventListener("submit", (event) => {
  event.preventDefault();
  connect(
    $<HTMLInputElement>("url").value.trim(),
    $<HTMLInputElement>("token").value.trim(),
  ).catch(fail);
});
$("disconnect").addEventListener("click", async () => {
  try {
    if (microphone) await setMicrophone(false);
    connected = false;
    clearTimeout(pollTimer);
    baseUrl = "";
    token = "";
    conversationId = "";
    hud = empty();
    confirmation = undefined;
    confirmationQueue = [];
    focus.clear();
    $<HTMLInputElement>("token").value = "";
    if (bridge && display)
      await display.run(() => bridge!.setLocalStorage(storageKey, ""));
    status("Not connected");
    await render();
  } catch (error) {
    fail(error);
  }
});
$("chat").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const input = $<HTMLTextAreaElement>("message"),
    text = input.value.trim();
  if (!text) return;
  busy = true;
  $<HTMLButtonElement>("send").disabled = true;
  status("Thinking");
  addMessage("You", text);
  try {
    apply(
      await request<Result>("/chat", {
        text,
        conversationId: conversationId || undefined,
      }),
    );
    input.value = "";
    await saveConnection();
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    $<HTMLButtonElement>("send").disabled = false;
    status(connected ? "Connected" : "Not connected");
  }
});
$("mic").addEventListener("click", () =>
  setMicrophone(!microphone).catch(fail),
);
$("clear").addEventListener("click", () => clearScreen().catch(fail));
$("approve").addEventListener("click", () => answer(true).catch(fail));
$("reject").addEventListener("click", () => answer(false).catch(fail));
window.addEventListener("pagehide", () => {
  void stop();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

waitForEvenAppBridge()
  .then(async (native) => {
    bridge = native;
    display = new Display(native);
    await render();
    const unsubscribe = native.onEvenHubEvent((event) => {
      if (disposed) return;
      if (event.audioEvent?.audioPcm) {
        if (microphone && !busy && !confirmation) {
          const audio = detector.push(event.audioEvent.audioPcm);
          if (audio) void sendAudio(audio);
        }
        return;
      }
      if (event.menuItemClickEvent?.itemID === 1) {
        clearScreen().catch(fail);
        return;
      }
      if (event.textEvent) {
        cancelClick();
        if (busy || confirmation) return;
        const type = event.textEvent.eventType;
        if (type === 1 || type === 2) {
          focus.swipe(
            focus.editing ? (type === 1 ? 1 : -1) : type === 1 ? -1 : 1,
            hud,
          );
          redraw();
        }
        return;
      }
      if (event.sysEvent) {
        const type = event.sysEvent.eventType ?? 0;
        if (type === 0) {
          cancelClick();
          clickTimer = setTimeout(() => press().catch(fail), 300);
        } else if (type === 3) {
          cancelClick();
          focus.clear();
          redraw();
        } else if (type === 9) cancelClick();
        else if (type === 4 || type === 5) {
          cancelClick();
          redraw();
        } // Menus are overlays, not shutdowns.
        else if (type === 6 || type === 7) {
          stop().catch(fail);
          unsubscribe();
        }
      }
    });
    const stored = await display.run(() => native.getLocalStorage(storageKey));
    if (stored) {
      try {
        const saved = JSON.parse(stored);
        $<HTMLInputElement>("url").value = saved.baseUrl ?? "";
        $<HTMLInputElement>("token").value = saved.token ?? "";
        conversationId = saved.conversationId ?? "";
        if (saved.baseUrl && saved.token)
          await connect(saved.baseUrl, saved.token);
      } catch (error) {
        fail(error);
      }
    } else if (connected) await saveConnection();
  })
  .catch(fail);

// Expire captions independently of the network connection so idle stays blank.
setInterval(() => {
  if (lastCaption !== caption()) redraw();
}, 1000);
redraw();
