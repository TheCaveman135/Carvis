import { randomUUID } from "node:crypto";
import {
  validateConfig as validateHA,
  readState,
  needsConfirmation,
  liveOwner,
  commandSchema,
  commandData,
} from "./home-assistant.js";

const sessions = new Map();
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
export function validateConfig(config = {}) {
  const addonSlug = String(config.addonSlug || "local_apple_tv_ai").trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(addonSlug))
    throw Error("Enter the Home Assistant add-on slug.");
  const remoteEntity = String(config.remoteEntity || "").trim(),
    mediaPlayerEntity = String(config.mediaPlayerEntity || "").trim();
  if (!remoteEntity && !mediaPlayerEntity)
    throw Error("Select a remote or media-player entity for the TV.");
  if (
    remoteEntity &&
    (!ENTITY.test(remoteEntity) || !remoteEntity.startsWith("remote."))
  )
    throw Error("The remote entity must be a remote entity ID.");
  if (
    mediaPlayerEntity &&
    (!ENTITY.test(mediaPlayerEntity) ||
      !mediaPlayerEntity.startsWith("media_player."))
  )
    throw Error("The media-player entity must be a media_player entity ID.");
  const context = String(config.context || "").trim();
  if (context.length > 6000)
    throw Error("Keep TV context under 6,000 characters.");
  return { addonSlug, remoteEntity, mediaPlayerEntity, context, silentNavigation: config.silentNavigation !== false, shortReplies: config.shortReplies !== false };
}
function home(ctx) {
  if (!ctx.registry?.getConfig)
    throw Error("Enable and configure the Home Assistant integration first.");
  const cfg = ctx.registry.getConfig("home-assistant");
  return { ...ctx, config: validateHA(cfg) };
}

/** A short authenticated HA WebSocket session obtains the add-on ingress cookie.
 * No undocumented standalone controller authentication is assumed. */
export async function connectIngress(ctx, config, ha) {
  const url = new URL(ha.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/+$/, "") + "/api/websocket";
  return new Promise((resolve, reject) => {
    let socket,
      settled = false,
      id = 0,
      ingressPath = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      try {
        socket?.close();
      } catch {}
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(Error("Apple TV connection cancelled."));
    const timer = setTimeout(
      () => finish(Error("Home Assistant ingress connection timed out.")),
      15000,
    );
    try {
      socket = ctx.createWebSocket
        ? ctx.createWebSocket(url.toString())
        : new WebSocket(url);
    } catch {
      return finish(Error("Could not open the Home Assistant connection."));
    }
    if (ctx.signal?.aborted) return abort();
    ctx.signal?.addEventListener("abort", abort, { once: true });
    const send = (payload) => {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        finish(Error("Home Assistant connection closed."));
      }
    };
    socket.addEventListener("error", () =>
      finish(Error("Could not connect to Home Assistant for TV AI Controller.")),
    );
    socket.addEventListener("close", () => {
      if (!settled)
        finish(Error("Home Assistant closed the Apple TV connection."));
    });
    socket.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === "auth_required")
        return send({ type: "auth", access_token: ha.token });
      if (msg.type === "auth_invalid")
        return finish(Error("Home Assistant rejected the access token."));
      if (msg.type === "auth_ok")
        return send({
          id: ++id,
          type: "supervisor/api",
          endpoint: `/addons/${config.addonSlug}/info`,
          method: "get",
        });
      if (msg.type !== "result" || msg.id !== id) return;
      if (msg.success === false)
        return finish(
          Error(
            "Home Assistant could not authorize the Apple TV add-on. Check the add-on slug and token permissions.",
          ),
        );
      if (id === 1) {
        const info = msg.result;
        if (
          info?.state !== "started" ||
          !/^\/api\/hassio_ingress\/[^/]+\/$/.test(info?.ingress_url || "")
        )
          return finish(
            Error("Start the TV AI Controller add-on in Home Assistant."),
          );
        ingressPath = info.ingress_url.replace(/\/$/, "");
        return send({
          id: ++id,
          type: "supervisor/api",
          endpoint: "/ingress/session",
          method: "post",
        });
      }
      const session = msg.result?.session;
      if (typeof session !== "string" || !session || /[\r\n;]/.test(session))
        return finish(
          Error("Home Assistant did not provide an ingress session."),
        );
      finish(null, {
        path: ingressPath,
        cookie: `ingress_session=${session}`,
        expires: Date.now() + 300000,
      });
    });
  });
}
async function request(ctx, path, body) {
  const config = validateConfig(ctx.config),
    ha = home(ctx).config,
    key = JSON.stringify([ha.baseUrl, ha.token, config.addonSlug]);
  let access = sessions.get(key);
  if (!access || access.expires < Date.now()) {
    access = await connectIngress(ctx, config, ha);
    sessions.set(key, access);
    while (sessions.size > 10) sessions.delete(sessions.keys().next().value);
  }
  let response;
  try {
    response = await ctx.fetch(`${ha.baseUrl}${access.path}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Cookie: access.cookie,
        "Content-Type": "application/json",
        "X-TV-Controller": "1",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
  } catch {
    throw Error(
      "TV AI Controller connection failed. Delivery is uncertain; check task status before retrying.",
    );
  }
  if ([401, 403, 404, 502, 503].includes(response.status)) sessions.delete(key);
  if (response.status === 409)
    throw Error(
      "The TV controller is busy or this task changed. Check status and add context to the existing task. No automatic retry was attempted.",
    );
  if (!response.ok)
    throw Error(
      `TV AI Controller rejected this request (${response.status}). No direct remote fallback was used.`,
    );
  try {
    return await response.json();
  } catch {
    throw Error(
      "TV AI Controller returned an unreadable result. Check status before retrying.",
    );
  }
}
async function authorize(
  ctx,
  { entityId, service = "task", control = true } = {},
) {
  const cfg = validateConfig(ctx.config),
    ha = home(ctx),
    allowed = [cfg.mediaPlayerEntity, cfg.remoteEntity].filter(Boolean);
  const selected = control ? ha.config.controlled : ha.config.observed;
  const id =
    entityId || allowed.find((candidate) => selected.includes(candidate));
  if (!id || !allowed.includes(id) || !selected.includes(id))
    throw Error(
      control
        ? "Select this TV for control in Home Assistant integration settings."
        : "Select this TV for observation in Home Assistant integration settings.",
    );
  const state = await readState(ha, id, control);
  if (control && ["unavailable", "unknown"].includes(state.state))
    throw Error("The selected TV is unavailable.");
  return {
    cfg,
    ha,
    id,
    state,
    protected: needsConfirmation(ha.config, id, state, service),
  };
}
function confirmation(a, summary, opts = {}) {
  if (!liveOwner(opts))
    throw Error("TV AI Controller actions require a live owner request.");
  if (a.protected && !opts.confirmed && !a.ha.config.dryRun)
    return { requiresConfirmation: true, summary };
  if (a.ha.config.dryRun)
    return {
      success: true,
      dryRun: true,
      message: "Dry run: no command was sent to TV AI Controller.",
    };
  return null;
}
function runResult(run) {
  if (!run || typeof run !== "object")
    throw Error("TV AI Controller returned no task.");
  return Object.fromEntries(
    [
      "id",
      "status",
      "goal",
      "message",
      "steps",
      "started_at",
      "finished_at",
      "context_revision",
      "applied_context_revision",
      "completion_check",
      "cost_usd",
    ]
      .filter((key) => run[key] !== undefined)
      .map((key) => [key, run[key]]),
  );
}
const string = { type: "string" };
const schema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error(`${label} must contain 1–${max} characters.`);
  return value.trim();
}
function taskId(id) {
  if (typeof id !== "string" || !/^[\w-]{1,150}$/.test(id))
    throw Error("Use the exact task ID returned by the controller.");
  return id;
}
export default {
  id: "apple-tv",
  name: "TV AI Controller",
  version: "1.0.0",
  icon: "tv",
  description:
    "Delegate visual TV tasks to your AI controller and steer the same task with context.",
  permissions: [
    "Use the enabled Home Assistant integration for authenticated add-on access",
    "Control only selected TV entities",
    "Read controller task status",
  ],
  fields: [
    {
      key: "addonSlug",
      label: "Home Assistant add-on slug",
      type: "text",
      description:
        "Defaults to local_apple_tv_ai. Requires an installed, running TV AI Controller add-on.",
    },
    {
      key: "remoteEntity",
      label: "TV remote",
      type: "text",
      description:
        "Choose the Home Assistant remote configured alongside the camera feed in your controller. Button support depends on that remote.",
    },
    {
      key: "mediaPlayerEntity",
      label: "TV media player (optional)",
      type: "text",
      description:
        "Optional media player for playback and power. Any brand is supported when configured in your controller.",
    },
    {
      key: "context",
      label: "TV context",
      type: "textarea",
      description:
        "Optional app preferences and useful guidance, such as which streaming services you use. Sent only to this TV controller.",
    },
    { key: 'silentNavigation', label: 'Silent successful navigation', type: 'boolean', default: true, group: 'Reply behavior', description: 'Keep directional and Select commands quiet when they succeed. Failures and confirmations are still shown.' },
    { key: 'shortReplies', label: 'Short power and playback replies', type: 'boolean', default: true, group: 'Reply behavior', description: 'Use one brief acknowledgement for successful power and playback commands.' },
  ],
  validateConfig,
  async test(ctx) {
    await authorize(ctx, { control: false });
    await request(ctx, "/api/status");
    return {
      success: true,
      message: "Connected to TV AI Controller through Home Assistant ingress.",
    };
  },
  async tools(ctx) {
    return [
      {
        name: "tv_start",
        description:
          "Start a visual task in the TV AI Controller. This is asynchronous; use tv_status for progress. Never claim completion merely because a task started.",
        parameters: schema({ goal: string }, ["goal"]),
        async confirmation(args) {
          const a = await authorize(ctx);
          return !a.ha.config.dryRun && a.protected
            ? `Start TV task: ${text(args.goal, "Goal", 4000)}`
            : null;
        },
        async execute(args, opts) {
          const goal = text(args.goal, "Goal", 4000),
            a = await authorize(ctx),
            blocked = confirmation(a, `Start TV task: ${goal}`, opts);
          if (blocked) return blocked;
          const result = await request(ctx, "/api/start", {
            request_id: randomUUID(),
            goal: a.cfg.context
              ? `${goal}\n\nOwner-provided TV context:\n${a.cfg.context}`
              : goal,
          });
          return {
            success: true,
            ...runResult(result),
            completed: false,
            message: "Task started. Check status for its outcome.",
          };
        },
      },
      {
        name: "tv_status",
        readOnly: true,
        description:
          "Read the current TV task or a specific historical task. A completed task is not a live camera observation; inspect completion_verified.",
        parameters: schema({ id: string }),
        async execute({ id }) {
          await authorize(ctx, { control: false });
          if (id) taskId(id);
          const state = await request(ctx, "/api/status"),
            run =
              !id || state.run?.id === id
                ? state.run
                : state.history?.find((r) => r.id === id);
          if (!run)
            return {
              success: true,
              task: null,
              message: "No matching TV task.",
            };
          return {
            success: true,
            ...runResult(run),
            model: state.model,
            live_observation: false,
            completion_verified: run.completion_check?.confirmed === true,
          };
        },
      },
      {
        name: "tv_context",
        description:
          "Add correction or guidance to an existing TV task for its next decision. Does not restart it. Use when the user says to search another streaming app, for example.",
        parameters: schema({ id: string, context: string }, ["id", "context"]),
        async confirmation(args) {
          const a = await authorize(ctx);
          return !a.ha.config.dryRun && a.protected
            ? `Update TV task ${taskId(args.id)}: ${text(args.context, "Context", 4000)}`
            : null;
        },
        async execute(args, opts) {
          const id = taskId(args.id),
            context = text(args.context, "Context", 4000),
            a = await authorize(ctx),
            blocked = confirmation(a, `Update TV task ${id}: ${context}`, opts);
          if (blocked) return blocked;
          const run = await request(ctx, "/api/context", {
            task_id: id,
            update_id: randomUUID(),
            context,
          });
          return {
            success: true,
            ...runResult(run),
            applied: run.applied_context_revision >= run.context_revision,
            message: "Context added to the same task for its next decision.",
          };
        },
      },
      {
        name: "tv_cancel",
        description: "Ask the AI TV controller to stop a specific task.",
        parameters: schema({ id: string }, ["id"]),
        async confirmation(args) {
          const a = await authorize(ctx);
          return !a.ha.config.dryRun && a.protected
            ? `Stop TV task ${taskId(args.id)}`
            : null;
        },
        async execute(args, opts) {
          const id = taskId(args.id),
            a = await authorize(ctx),
            blocked = confirmation(a, `Stop TV task ${id}`, opts);
          if (blocked) return blocked;
          return {
            success: true,
            ...runResult(await request(ctx, "/api/stop", { request_id: id })),
          };
        },
      },
      {
        name: "tv_button",
        description:
          `Send one navigation button through the AI TV controller. ${validateConfig(ctx.config).silentNavigation ? 'Successful navigation should stay silent.' : 'Give a brief acknowledgement on success.'} Do not send a second direct HA remote command.`,
        parameters: schema(
          {
            button: {
              type: "string",
              enum: [
                "up",
                "down",
                "left",
                "right",
                "select",
                "menu",
                "top_menu",
              ],
            },
          },
          ["button"],
        ),
        async confirmation(args) {
          const a = await authorize(ctx, {
            entityId: validateConfig(ctx.config).mediaPlayerEntity || validateConfig(ctx.config).remoteEntity,
            service: "send_command",
          });
          return !a.ha.config.dryRun && a.protected
            ? `TV button: ${args.button}`
            : null;
        },
        async execute(args, opts) {
          const cfg = validateConfig(ctx.config);
          if (!cfg.remoteEntity)
            throw Error(
              "Configure the TV remote entity to use navigation buttons.",
            );
          const a = await authorize(ctx, { entityId: cfg.mediaPlayerEntity || cfg.remoteEntity, service: 'send_command' });
          const blocked = confirmation(a, `TV button: ${args.button}`, opts);
          if (blocked) return blocked;
          const run = await request(ctx, '/api/command', { request_id: randomUUID(), entity_id: cfg.remoteEntity, service: 'send_command', data: { command: args.button } });
          if (run.status !== 'completed') throw Error('The controller has not confirmed the command. Check task status before retrying.');
          return { success: true, id: run.id, status: run.status, verified: false, silent: cfg.silentNavigation, message: cfg.silentNavigation ? '' : `TV ${args.button} accepted.` };
        },
      },
      {
        name: "tv_command",
        description:
          `Power, playback, volume, or navigation through the AI TV controller exclusively. Use configured TV entity IDs and typed Home Assistant parameters. ${validateConfig(ctx.config).silentNavigation ? 'Successful navigation should stay silent.' : 'Acknowledge successful navigation briefly.'} ${validateConfig(ctx.config).shortReplies ? 'Use one short reply for power or playback.' : 'Explain power or playback results naturally.'}`,
        parameters: commandSchema,
        async confirmation(args) {
          const a = await authorize(ctx, {
            entityId: args.entity_id,
            service: args.service,
          });
          commandData(args, a.state);
          return !a.ha.config.dryRun && a.protected
            ? `TV ${args.service}: ${args.entity_id}`
            : null;
        },
        execute: (args, opts) => executeCommand(ctx, args, opts),
      },
    ];
  },
  async context(ctx) {
    const cfg = validateConfig(ctx.config);
    let selected;
    try {
      selected = home(ctx).config.observed;
    } catch {
      return "TV AI Controller requires the enabled Home Assistant integration before it can be used.";
    }
    const targets = [cfg.mediaPlayerEntity, cfg.remoteEntity].filter((id) =>
      selected.includes(id),
    );
    return `TV control uses the AI controller exclusively, with no direct remote fallback. Configured TV targets: ${targets.join(", ") || "none selected"}. Use tv_context to steer a running task instead of restarting it. ${cfg.silentNavigation ? 'Successful navigation should stay silent.' : 'Briefly acknowledge navigation.'} ${cfg.shortReplies ? 'Keep power/playback replies to one short sentence.' : 'Use the normal conversational reply style for power/playback.'}`;
  },
  async route({ method, path }, ctx) {
    if (method === "GET" && path === "/status") {
      await authorize(ctx, { control: false });
      const result = await request(ctx, "/api/status");
      return {
        run: result.run ? runResult(result.run) : null,
        model: result.model,
      };
    }
    return null;
  },
};
async function executeCommand(ctx, args, opts) {
  const a = await authorize(ctx, {
      entityId: args.entity_id,
      service: args.service,
    }),
    data = commandData(args, a.state),
    blocked = confirmation(a, `TV ${args.service}: ${args.entity_id}`, opts);
  if (blocked) return blocked;
  const { entity_id, ...parameters } = data;
  const run = await request(ctx, "/api/command", {
    request_id: randomUUID(),
    entity_id,
    service: args.service,
    data: parameters,
  });
  if (run.status !== "completed")
    throw Error(
      "The controller has not confirmed the command. Check task status before retrying.",
    );
  return {
    success: true,
    id: run.id,
    status: run.status,
    verified: false,
    silent: args.service === "send_command" && a.cfg.silentNavigation,
    message:
      args.service === "send_command" && a.cfg.silentNavigation
        ? ""
        : `TV ${args.service.replaceAll("_", " ")} accepted.`,
  };
}
