# Code organization

Carvis keeps home permissions and execution in the core. Optional capabilities
live in integrations. The public module entry points and HTTP endpoints remain
stable while implementation details are split by responsibility.

## Core server

| Location | Responsibility |
| --- | --- |
| `server/index.js` | Listening interfaces, retry and shutdown; re-exports `createApp` for existing callers. |
| `server/app.js` | Creates storage, registry, chat and HTTP services. |
| `server/http/handler.js` | Shared host, origin, authentication and scoped device checks. |
| `server/http/routes/` | Account, home setup, settings, conversations, integration and memory endpoints. A handler returns `true` only when it has answered the request. |
| `server/http/responses.js` | Bounded JSON requests and common responses. |
| `server/http/static.js` | Same-origin web files, content policy and conditional asset responses. |
| `server/home-assistant.js` | Home service metadata and tools; compatibility exports for integrations. |
| `server/home/` | Configuration, HTTP transport, permissions, state visibility and typed commands. |
| `server/registry.js` | Integration lifecycle, current availability, tool execution and single-use confirmations. |
| `server/global-keys.js` | Shared credential resolution, explicit overrides, and key removal without reviving old copies. |
| `server/chat.js` | Conversation orchestration and model rounds. |
| `server/conversation-context.js` | Bounded recent history and server-generated execution evidence. |

Authentication stays in the shared request handler. Account creation and login
run after host/origin validation and before the session requirement; other API
routes run after that requirement. Keep feature-specific owner checks when a
device token must not grant configuration access.

Storage restores the internal Home Assistant adapter alias whenever configuration
is loaded or replaced. Settings edits must preserve the same core home connection
and entity permissions. Required integration dependencies use one availability
check for settings, status, routes, and tools.

## Browser interface

`web/app.js` composes the application and owns navigation and shared state.
Views receive their dependencies explicitly:

- `chat.js` handles conversations; `stream-events.js` parses response events and
  batches incremental rendering.
- `home.js` owns the dashboard and voice history.
- `integrations.js`, `integration-controls.js`, `integration-settings.js` and
  `integration-metadata.js` handle the catalog, controls, schema-driven forms and
  dependency descriptions.
- `entity-selector.js` owns the home device permission selector.
- `settings.js` owns core settings. `ui.js` contains shared DOM helpers.
- `api.js` handles authenticated requests and coalesces simultaneous discovery
  reads. Completed responses are not cached, so later reads remain fresh.

These are native browser modules; there is no frontend bundler or new runtime
dependency.

## Optional integrations

- **Assistant runtime:** `server/tools/index.js` composes domain-specific tool
  builders in stable order. Schemas, entity visibility, home commands, memory,
  display, rules and other domains have their own modules. Automation helpers,
  public record shapes and database bindings live in `server/automations/`.
  `server/voice-input.js` owns microphone availability checks before and after
  transcription for local capture and both glasses companions. Speech output
  rechecks current settings before queued playback and retries.
- **Continuity Memory:** `src/dmr-store.js` owns transactions and temporal graph
  updates. `schema.js` owns migrations, `records.js` owns record conversion, and
  `retrieval.js` owns ranking and diversity selection.
- **Even Realities:** `src/main.ts` coordinates the companion. Snapshot creation
  and restoration live in `background-state.ts`, separately from display,
  microphone, navigation and lifecycle behavior.

See each integration's README for its internal module map and validation.

## Performance boundaries

Reuse computations within a single operation rather than keeping permission
snapshots between requests. Entity selections are indexed once per batch;
tool-name uniqueness uses a set; recent conversation context scans backward and
stops when its limit is reached. Memory retrieval reuses token sets, term weights
and graph indexes, and updates diversity scores incrementally.

Static assets use weak ETags based on fresh file metadata. Unchanged assets
return an empty `304` response; changed files are read normally. API responses
retain `no-store` and permission checks still run before execution.

## Validation and measurement

Run `npm test` and `npm run check` from the repository root. The release check
includes new, nonignored files as well as tracked files. For companion changes,
run `npm ci`, `npm run build` and `npm run build:basic` in
`integrations/even-realities`.

`node scripts/benchmark-core.mjs` compares old and current history/state-list
algorithms with synthetic data and asserts equal outputs before timing them.
It warms up each case and reports the median of 15 runs. Example results on a
local Node 26 run:

| Synthetic workload | Before | After |
| --- | ---: | ---: |
| Select 24 recent messages from 100,000 | 0.766 ms | 0.001 ms |
| Filter and sanitize 2,000 selected states from 4,000 | 81.454 ms | 1.052 ms |

These measure isolated CPU work, not model, network or device latency. Timing
varies by machine. Tests use temporary data and mocked service boundaries; they
must never contact a configured home or copy private installation files.
