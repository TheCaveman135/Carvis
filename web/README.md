# Frontend structure

The browser uses native ES modules; there is no bundler or framework dependency.
`app.js` owns authentication, navigation, the shell, and shared application state.
View factories receive that state and explicit navigation/API callbacks instead
of importing mutable globals from one another.

| Module                    | Responsibility                                                        |
| ------------------------- | --------------------------------------------------------------------- |
| `ui.js`                   | Shared DOM elements, icons, notices, and safe message formatting      |
| `api.js`                  | JSON requests, unauthorized responses, and concurrent discovery reads |
| `chat.js`                 | Conversation composition, messages, tools, and confirmations          |
| `stream-events.js`        | Incremental stream decoding and animation-frame rendering             |
| `integrations.js`         | Catalog, integration details, and control-module lifecycle            |
| `integration-metadata.js` | Dependencies, search, field grouping, and typed values                |
| `integration-settings.js` | Grouped forms, validation, and automatic saving                       |
| `integration-controls.js` | Schema-driven fields and device/model discovery                       |
| `entity-selector.js`      | Entity filtering, observation, control, and guards                    |
| `settings.js`             | Profile, shared keys, and integration model routing                   |
| `model-settings.js`       | Main model connection and model discovery                             |
| `home.js`                 | Home dashboard, home setup, and voice conversation history            |
| `voice-controls.js`       | Microphone controls and polling cleanup                               |

Routing invokes `state.integrationCleanup` before mounting another view. Keep
polling and integration-provided cleanup attached to that lifecycle. Device
discovery shares overlapping reads only; completed responses are not cached.
Chat updates collect stream events in order and render at most once per frame.

Always build model and integration text with DOM text nodes. Preserve dependency
checks, selected entities, dry runs, guards, and explicit confirmations when
changing controls. Never use a configured installation for frontend tests.

Focused checks:

```sh
node --test test/integration-ui.test.js test/model-router.test.js test/web-api.test.js test/web-stream.test.js
```

Run `npm test` and `npm run check` before completing a change. Browser smoke tests
must serve synthetic API responses and avoid real accounts or devices.
