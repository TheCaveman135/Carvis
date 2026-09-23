import { randomUUID } from "node:crypto";
import { validate } from "../validation.js";
import { projectRuntimeConfig } from "../assistant-config.js";
import { Transcriber, speechProvider, wavFromPcm } from "../../integrations/assistant-runtime/server/stt.js";
import { voiceInputIssue, transcribeVoiceInput } from "../../integrations/assistant-runtime/server/voice-input.js";

const stateKey = "hud";
const emptyState = () => ({
  revision: 0,
  slots: [null, null, null, null],
  reply: "",
  replyExpires: 0,
});
const requests = new Map();
const liveReads = new Map();
const confirmations = new Map();
let actionBusy = false;
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const trim = (value, max) =>
  String(value ?? "")
    .trim()
    .slice(0, max);
function action(value) {
  assert(
    object(value) && /^[a-z][a-z0-9_-]{1,63}$/.test(value.tool),
    "Choose a valid integration tool.",
  );
  assert(
    !value.tool.startsWith("even_realities_"),
    "Widgets cannot call other widget tools.",
  );
  assert(object(value.arguments ?? {}), "Action arguments must be an object.");
  return {
    tool: value.tool,
    arguments: structuredClone(value.arguments ?? {}),
  };
}
export function normalizeWidget(input) {
  assert(
    Number.isInteger(input.slot) && input.slot >= 1 && input.slot <= 4,
    "Slot must be 1 through 4.",
  );
  const display = input.display ?? {};
  assert(object(display), "Display settings must be an object.");
  const widget = {
    id: randomUUID(),
    slot: input.slot,
    display: {
      title: trim(display.title, 40),
      value: trim(display.value, 80),
      blank: display.blank === true,
    },
    interaction: null,
  };
  if (display.source) {
    const source = display.source;
    assert(
      typeof source.path === "string" &&
        /^[a-zA-Z0-9_.]{1,100}$/.test(source.path) &&
        !source.path
          .split(".")
          .some((part) =>
            ["__proto__", "constructor", "prototype"].includes(part),
          ),
      "Choose a valid display field path.",
    );
    assert(
      source.scale === undefined || Number.isFinite(source.scale),
      "Display scale must be a finite number.",
    );
    widget.display.source = {
      ...action(source),
      path: source.path,
      scale: source.scale ?? 1,
      suffix: trim(source.suffix, 10),
    };
  }
  const control = input.interaction;
  if (!control) return widget;
  assert(
    ["button", "slider", "dropdown"].includes(control.kind),
    "Choose button, slider, or dropdown.",
  );
  if (control.kind === "button")
    widget.interaction = { kind: "button", action: action(control.action) };
  if (control.kind === "slider") {
    const {
      min = 0,
      max = 100,
      step = 5,
      argument = "value",
      value = min,
    } = control;
    assert(
      [min, max, step, value].every(Number.isFinite) &&
        max > min &&
        step > 0 &&
        step <= max - min,
      "Invalid slider limits.",
    );
    assert(
      /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(argument),
      "Choose a simple action argument name.",
    );
    assert(value >= min && value <= max, "Slider value is outside its limits.");
    widget.interaction = {
      kind: "slider",
      action: action(control.action),
      argument,
      min,
      max,
      step,
      value,
      unit: trim(control.unit, 10),
    };
  }
  if (control.kind === "dropdown") {
    assert(
      Array.isArray(control.options) &&
        control.options.length > 0 &&
        control.options.length <= 20,
      "Dropdowns need 1 to 20 choices.",
    );
    widget.interaction = {
      kind: "dropdown",
      index: 0,
      options: control.options.map((option) => {
        const label = trim(option.label, 40);
        assert(label, "Each dropdown choice needs a label.");
        return { label, action: action(option.action) };
      }),
    };
  }
  return widget;
}

async function read(ctx) {
  return await ctx.store.get(stateKey, emptyState());
}
async function write(ctx, state) {
  state.revision += 1;
  await ctx.store.set(stateKey, state);
  return state;
}
async function checkAction(ctx, command, override = {}) {
  const tool = await ctx.registry.describe(command.tool);
  assert(tool, `The integration tool ${command.tool} is not enabled.`);
  validate({ ...command.arguments, ...override }, tool.parameters);
  return tool;
}
async function checkWidget(ctx, widget) {
  if (widget.display.source)
    assert(
      (await checkAction(ctx, widget.display.source)).readOnly === true,
      "Display sources must use an explicitly read-only tool.",
    );
  const control = widget.interaction;
  if (control?.kind === "button") await checkAction(ctx, control.action);
  if (control?.kind === "slider") {
    for (const value of [
      control.min,
      Math.min(control.max, control.min + control.step),
      control.max,
    ])
      await checkAction(ctx, control.action, { [control.argument]: value });
  }
  if (control?.kind === "dropdown")
    for (const option of control.options) await checkAction(ctx, option.action);
}
async function refresh(ctx) {
  const state = await read(ctx);
  for (const widget of state.slots) {
    const source = widget?.display.source;
    if (!source) continue;
    const cached = liveReads.get(widget.id);
    if (cached && Date.now() - cached < 5000) continue;
    liveReads.set(widget.id, Date.now());
    while (liveReads.size > 100)
      liveReads.delete(liveReads.keys().next().value);
    let text = "Unavailable",
      numeric;
    try {
      assert(
        (await checkAction(ctx, source)).readOnly === true,
        "Read-only source is no longer available.",
      );
      const result = await ctx.registry.invoke(source.tool, source.arguments, {
        confirmed: false,
        source: "device",
      });
      assert(
        !result?.requiresConfirmation &&
          result?.success !== false &&
          !result?.error,
        "State read did not complete.",
      );
      const value = source.path
        .split(".")
        .reduce((value, part) => value?.[part], result);
      assert(
        value !== undefined &&
          value !== null &&
          ["string", "number", "boolean"].includes(typeof value),
        "State field is unavailable.",
      );
      if (typeof value === "number") {
        numeric = Math.round(value * source.scale * 100) / 100;
        text = `${numeric}${source.suffix}`;
      } else text = `${value}${source.suffix}`;
    } catch {
      /* Keep the failure local to this widget, and never expose provider errors. */
    }
    const fresh = await read(ctx),
      current = fresh.slots[widget.slot - 1];
    if (current?.id !== widget.id) continue;
    let changed = current.display.value !== trim(text, 80);
    current.display.value = trim(text, 80);
    if (current.interaction?.kind === "slider" && numeric !== undefined) {
      const next = Math.max(
        current.interaction.min,
        Math.min(current.interaction.max, numeric),
      );
      changed ||= next !== current.interaction.value;
      current.interaction.value = next;
    }
    if (changed) await write(ctx, fresh);
  }
  return read(ctx);
}
async function caption(ctx, text) {
  const state = await read(ctx);
  state.reply = trim(text, 2000);
  state.replyExpires = Date.now() + 30000;
  return write(ctx, state);
}
function voiceConfig(ctx) {
  if (!ctx.registry.store || !ctx.registry.available?.("voice")) return null;
  return projectRuntimeConfig(ctx.registry.store);
}
function voiceAvailable(ctx) {
  const cfg = voiceConfig(ctx);
  return !voiceInputIssue(cfg, "even-glasses") && Boolean(speechProvider(cfg).key);
}
function publicState(state, ctx) {
  return {
    revision: state.revision,
    reply: state.replyExpires > Date.now() ? state.reply : "",
    replyExpires: state.replyExpires,
    voiceEnabled: voiceAvailable(ctx),
    slots: state.slots.map((widget) => {
      if (!widget) return null;
      const { kind, min, max, step, value, unit, options, index } =
        widget.interaction ?? {};
      const { title, value: displayValue, blank } = widget.display;
      return {
        id: widget.id,
        slot: widget.slot,
        display: { title, value: displayValue, blank },
        interaction: kind
          ? {
              kind,
              min,
              max,
              step,
              value,
              unit,
              index,
              options: options?.map((option) => ({ label: option.label })),
            }
          : null,
      };
    }),
  };
}

export function pcmToWav(base64) {
  assert(
    typeof base64 === "string" &&
      base64.length <= 1280000 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(base64),
    "Send at most 30 seconds of PCM audio.",
  );
  const pcm = Buffer.from(base64, "base64");
  assert(
    pcm.length >= 3200 && pcm.length <= 960000 && pcm.length % 2 === 0,
    "Audio must be 16 kHz, mono, signed 16-bit PCM.",
  );
  return wavFromPcm(pcm);
}
async function transcribe(ctx, body) {
  assert(voiceAvailable(ctx), "Enable Voice input & chat, set its global speech key, select Even glasses as the microphone, and unmute it.");
  ctx.signal?.throwIfAborted();
  const pcm = pcmToWav(body.pcmBase64).subarray(44);
  const transcriber = new Transcriber(() => voiceConfig(ctx), { fetch: ctx.fetch, signal: ctx.signal });
  const result = await transcribeVoiceInput({ getConfig: () => voiceConfig(ctx), transcriber, pcm, inputDevice: "even-glasses", signal: ctx.signal });
  // A settings change while transcription is pending revokes microphone access.
  assert(!result.ignored && voiceAvailable(ctx), "Glasses microphone was muted, changed, or disabled during transcription.");
  ctx.signal?.throwIfAborted();
  const text = trim(result.text, 12000);
  assert(text, "No speech was recognized. Try again or type on your phone.");
  return text;
}
async function chat(ctx, body, text) {
  assert(
    typeof text === "string" && text.trim() && text.length <= 12000,
    "Enter a message of at most 12,000 characters.",
  );
  const confirmations = [];
  const result = await ctx.chat({
    text: text.trim(),
    conversationId: body.conversationId,
    emit: (type, value) => {
      if (type === "confirmation") confirmations.push(value);
    },
  });
  await caption(ctx, result.reply);
  return {
    ...result,
    confirmations,
    transcript: text.trim(),
    hud: publicState(await read(ctx), ctx),
  };
}
async function performAction(ctx, body) {
  assert(!actionBusy, "A widget action is already running.");
  actionBusy = true;
  try {
    const state = await read(ctx);
    assert(
      Number.isInteger(body.slot) && body.slot >= 1 && body.slot <= 4,
      "Choose an existing widget slot.",
    );
    const widget = state.slots[body.slot - 1];
    assert(
      widget?.id === body.widgetId && widget?.interaction,
      "This widget changed. Refresh before trying again.",
    );
    const control = widget.interaction;
    let command = control.action;
    if (control.kind === "slider") {
      const value = body.value;
      assert(
        Number.isFinite(value) && value >= control.min && value <= control.max,
        "Slider value is outside its limits.",
      );
      assert(
        Math.abs(
          (value - control.min) / control.step -
            Math.round((value - control.min) / control.step),
        ) < 0.00001 || value === control.max,
        "Slider value must match its step.",
      );
      command = {
        ...command,
        arguments: { ...command.arguments, [control.argument]: value },
      };
    }
    if (control.kind === "dropdown") {
      assert(
        Number.isInteger(body.index) &&
          body.index >= 0 &&
          body.index < control.options.length,
        "Choose a valid dropdown option.",
      );
      command = control.options[body.index].action;
    }
    const result = await ctx.registry.invoke(command.tool, command.arguments, {
      confirmed: false,
      source: "device",
    });
    if (result?.requiresConfirmation && result.confirmation?.id) {
      confirmations.set(result.confirmation.id, {
        ...body,
        expires: Date.now() + 120000,
      });
      for (const [id, pending] of confirmations)
        if (pending.expires < Date.now()) confirmations.delete(id);
    }
    if (
      !result?.requiresConfirmation &&
      !result?.dryRun &&
      result?.success !== false &&
      !result?.error
    ) {
      // Reload: the tool may have changed the HUD while the action was running.
      const fresh = await read(ctx),
        current = fresh.slots[body.slot - 1];
      if (current?.id === widget.id) {
        if (control.kind === "slider") {
          current.interaction.value = body.value;
          current.display.value = `${body.value}${control.unit}`;
        }
        if (control.kind === "dropdown") {
          current.interaction.index = body.index;
          current.display.value = control.options[body.index].label;
        }
        await write(ctx, fresh);
        liveReads.delete(widget.id);
      }
    }
    return { ...result, hud: publicState(await read(ctx), ctx) };
  } finally {
    actionBusy = false;
  }
}
async function invokeWidget(ctx, body) {
  assert(
    typeof body.requestId === "string" &&
      /^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId),
    "A unique request ID is required.",
  );
  const signature = JSON.stringify([
    body.slot,
    body.widgetId,
    body.value,
    body.index,
  ]);
  const cached = requests.get(body.requestId);
  if (cached) {
    assert(
      cached.signature === signature,
      "Request ID was already used for another action.",
    );
    return cached.promise;
  }
  const promise = performAction(ctx, body);
  requests.set(body.requestId, { signature, promise });
  while (requests.size > 200) requests.delete(requests.keys().next().value);
  return promise;
}

const actionSchema = {
  type: "object",
  properties: {
    tool: { type: "string" },
    arguments: { type: "object", additionalProperties: true },
  },
  required: ["tool", "arguments"],
  additionalProperties: false,
};
export default {
  id: "even-realities",
  name: "Even Realities",
  privateConfigKeys: ["speechApiKey"],
  version: "1.0.0",
  icon: "glasses",
  description:
    "Take Carvis with you: replies, voice input, and interactive widgets on G2 glasses.",
  permissions: [
    "Display replies on glasses",
    "Send messages and optional microphone audio to Carvis",
    "Run enabled integration tools from widgets",
  ],
  fields: [
    {
      key: "publicBaseUrl",
      label: "Carvis URL",
      type: "url",
      required: true,
      description: "An HTTPS address reachable from your phone.",
    },
    {
      key: "pairingToken",
      label: "Device pairing token",
      type: "password",
      required: true,
      description:
        "Generate a random token, then enter it in the companion app. It grants device access, not settings access.",
    },
  ],
  validateConfig(config) {
    const url = new URL(config.publicBaseUrl);
    assert(
      url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
      "Use HTTPS for a remote Carvis connection.",
    );
    assert(
      !url.username && !url.password && !url.search && !url.hash,
      "Carvis URL must not contain credentials or query parameters.",
    );
    assert(
      typeof config.pairingToken === "string" &&
        config.pairingToken.length >= 32,
      "Generate a pairing token of at least 32 characters.",
    );
    return config;
  },
  async test(ctx) {
    return {
      success: true,
      message:
        "Device endpoint is ready. Connect the companion app with your Carvis URL and pairing token.",
      microphoneEnabled: voiceAvailable(ctx),
    };
  },
  tools(ctx) {
    return [
      {
        name: "even_realities_set_widget",
        description:
          "Create a glasses widget. Slots are 1 top-left, 2 bottom-left, 3 top-right, 4 bottom-right. Display and optional interaction are separate. Buttons run one integration tool; sliders replace one numeric argument; dropdowns run a choice action. Use only known enabled integration tools. Existing tool permissions and confirmations apply on every press. For live status, bind display.source to an explicitly read-only tool and its result path (e.g. ha_get_state and state).",
        readOnly: false,
        parameters: {
          type: "object",
          properties: {
            slot: { type: "integer", minimum: 1, maximum: 4 },
            display: {
              type: "object",
              properties: {
                title: { type: "string", maxLength: 40 },
                value: { type: "string", maxLength: 80 },
                blank: { type: "boolean" },
                source: {
                  type: "object",
                  properties: {
                    ...actionSchema.properties,
                    path: {
                      type: "string",
                      description:
                        "Dot path into the read-only tool result, e.g. state or attributes.brightness.",
                    },
                    scale: { type: "number" },
                    suffix: { type: "string" },
                  },
                  required: ["tool", "arguments", "path"],
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
            interaction: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["button", "slider", "dropdown"],
                },
                action: actionSchema,
                argument: { type: "string" },
                min: { type: "number" },
                max: { type: "number" },
                step: { type: "number" },
                value: { type: "number" },
                unit: { type: "string", maxLength: 10 },
                options: {
                  type: "array",
                  minItems: 1,
                  maxItems: 20,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", maxLength: 40 },
                      action: actionSchema,
                    },
                    required: ["label", "action"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["kind"],
              additionalProperties: false,
            },
          },
          required: ["slot", "display"],
          additionalProperties: false,
        },
        async execute(args) {
          const widget = normalizeWidget(args);
          await checkWidget(ctx, widget);
          const state = await read(ctx);
          state.slots[widget.slot - 1] = widget;
          await write(ctx, state);
          return { success: true, widgetId: widget.id, slot: widget.slot };
        },
      },
      {
        name: "even_realities_clear_screen",
        readOnly: false,
        description: "Clear the glasses widgets and reply caption.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          const state = emptyState();
          state.revision = (await read(ctx)).revision;
          await write(ctx, state);
          return { success: true };
        },
      },
      {
        name: "even_realities_show_reply",
        readOnly: false,
        description:
          "Show a short message at the bottom of the glasses display for 30 seconds.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: 1000 },
          },
          required: ["text"],
          additionalProperties: false,
        },
        async execute({ text }) {
          await caption(ctx, text);
          return { success: true };
        },
      },
    ];
  },
  async route({ method, path, body = {} }, ctx) {
    if (method === "GET" && path === "/feed")
      return publicState(await refresh(ctx), ctx);
    if (method === "POST" && path === "/chat")
      return chat(ctx, body, body.text);
    if (method === "POST" && path === "/audio")
      return chat(ctx, body, await transcribe(ctx, body));
    if (method === "POST" && path === "/action") return invokeWidget(ctx, body);
    if (method === "POST" && path === "/confirm") {
      assert(
        typeof body.id === "string" && typeof body.accepted === "boolean",
        "Choose whether to confirm this action.",
      );
      const result = await ctx.registry.confirm(body.id, body.accepted, {
        source: "device",
      });
      const pending = confirmations.get(body.id);
      confirmations.delete(body.id);
      if (
        pending &&
        body.accepted &&
        result?.success !== false &&
        !result?.error &&
        !result?.dryRun &&
        !result?.requiresConfirmation
      ) {
        const state = await read(ctx),
          current = state.slots[pending.slot - 1];
        if (current?.id === pending.widgetId) {
          if (current.interaction.kind === "slider") {
            current.interaction.value = pending.value;
            current.display.value = `${pending.value}${current.interaction.unit}`;
          }
          if (current.interaction.kind === "dropdown") {
            current.interaction.index = pending.index;
            current.display.value =
              current.interaction.options[pending.index].label;
          }
          await write(ctx, state);
          liveReads.delete(current.id);
        }
      }
      return { ...result, hud: publicState(await read(ctx), ctx) };
    }
    if (method === "POST" && path === "/clear") {
      const state = emptyState();
      state.revision = (await read(ctx)).revision;
      return publicState(await write(ctx, state), ctx);
    }
    return null;
  },
};
