# Assistant runtime

This is the optional implementation behind Carvis's advanced integrations. It preserves the original voice routing, tool gateway, protocols, learned preferences, vision, HUD, speaker routing, physical device API, execution traces, and advanced controls. The basic public chatbot does not import or launch this code unless the assistant integration is enabled.

Install runtime dependencies with `npm ci --prefix integrations/assistant-runtime`. Run regressions with `npm test --prefix integrations/assistant-runtime`.

## Configuration and data

`defaults.js` is pure data. Every integration starts disabled. Provider URLs and models, Home Assistant addresses/entities, TV controller identifiers, tokens, owner context, and optional services must be supplied through Carvis's Integration settings. No private installation directory is referenced.

The parent writes complete configuration to `CARVIS_RUNTIME_DIR/config.json` with owner-only permissions. SQLite, conversation history, and learned patterns also live in that private directory. Source files and web assets remain here. Browser configuration redacts credentials recursively; raw configuration is available only over parent IPC.

Disabling learned memory stops learned fact/preference retrieval and mutation. Existing standing owner rules remain constraints. Disabling an integration removes its tools and rejects calls before the adapter is reached. `CARVIS_RUNTIME_PAUSED=1` suppresses classifiers, sessions, protocols, preference learning, and other background tool execution while allowing explicit owner requests for staging checks.

Apple TV settings accept `mediaPlayer`, `remoteEntity`, `addonSlug` for a configured Home Assistant add-on, or `baseUrl` plus `token` for a direct AI controller. `silentNavigation` and `shortReplies` preserve the default fast navigation and short power/playback replies but are owner-configurable. Commands continue through original selection and guard checks.

## Process boundary

The parent forks `server/index.js` with IPC, `CARVIS_RUNTIME_DIR`, and a random `CARVIS_RUNTIME_SECRET` of at least 32 characters. The worker listens on `127.0.0.1` with a dynamically selected port and reports `{type:'ready',port}`. Every HTTP request, including assets and preflight, requires the parent's `x-carvis-internal` header. Devices cannot connect directly. Parent disconnect, SIGTERM, and SIGINT stop the worker; there are no detached restarts.

IPC requests use `{id,method,args}` and return `{id,result}` or `{id,error}`. Supported methods are `request`, `tools`, `call`, `command`, `context`, `reply`, `config`, `state`, `confirm`, `integrations`, and `clear_external_confirmation`. `request` accepts current-conversation history and owner-managed context, replacing stale shared conversation context for that turn. Direct tool calls still run through the original gateway. Confirmation is single-use and tied to its originating channel; device requests cannot consume owner confirmations. Saving configuration invalidates pending confirmations before emitting `{type:'config_changed',config}`.

The parent serves advanced controls at `/integrations/assistant-engine/` and intercepts configuration writes so its Integration registry remains authoritative. Hashes select the existing dashboard, carvis, automations, transcript, trace, chat, entities, behavior, models, tools, and settings views. The workspace has a link back to the main Carvis interface.

New integrations are registered over IPC as `integration.<tool name>`. Their typed calls return to the parent registry, which rechecks current permissions and confirmation before executing. The worker never turns a model argument into confirmation. Parent-owned context is included with the active tool catalog. Unaddressed speech retains its original restricted Atlas-only tool set.
