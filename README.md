# Carvis

Your smart home, understood.

Carvis is a self-hosted smart home controller with Home Assistant built in.
Connect your home, choose which devices it may see and control, then expand it
with optional voice, TV control, glasses, routines, and Continuity Memory.
Conversation is one way to control your home, alongside your enabled devices.

## Start

Requires **Node.js 22.18 or later** (Node.js 24 LTS recommended).

```sh
npm install
npm start
```

Open **http://localhost:8788**, create your owner account, then complete home setup: **Home name → Home Assistant URL and token → Entity selection**. Configure your model in **Settings**. Choose OpenAI, an OpenAI-compatible endpoint, or Ollama. Choose a model from the automatically loaded dropdown. For Ollama, use its compatible endpoint, normally `http://localhost:11434/v1`.

No API keys, home configuration, transcripts, personal memories, or device credentials are included. No integration is enabled by default. You provide your own model account; provider usage may have a cost.

## Make it yours

- **Home:** the opening dashboard shows selected device states; connection, entities, and guards live under Settings → Home Assistant.
- **Conversations:** ask about your home, control selected devices, and keep context across follow-up requests.
- **Continuity Memory:** enable dated memory, historical context, linked evidence, conflicts, and tentative routines. Existing saved memories migrate automatically.
- **Integrations:** find a service or setting, configure its permissions, test, and enable it. Settings save automatically. Disabled integrations supply no model tools.
- **Personality:** choose your name, your assistant's name, and how it should speak.

## Included integrations

| Integration | Adds | Setup |
| --- | --- | --- |
| TV AI Controller | Visual TV tasks, direct buttons through the AI controller, progress, cancellation, and mid-task guidance | [Guide](docs/integrations-apple-tv.md) |
| Even Realities | Optional glasses companion, replies, interactive widgets, and opt-in microphone input | [Guide](docs/integrations-even-realities.md) |
| Advanced assistant | Fast commands, model roles, coordinated tools, and detailed execution traces | [Guide](docs/integrations-assistant.md) |
| Voice input & chat | Deepgram/AssemblyAI transcription, server microphones, and contextual follow-ups | [Guide](docs/integrations-assistant.md#voice-and-display) |
| Spoken replies | Phone, configured HA speaker, and physical-device speech routing | [Guide](docs/integrations-assistant.md#voice-and-display) |
| Routines, timers & alarms | Persisted routines, conditions, timers, alarms, variables, and run history | [Guide](docs/integrations-assistant.md#intelligence-and-routines) |
| Proactive home alerts | Event classification, interruption preferences, and session context | [Guide](docs/integrations-assistant.md#intelligence-and-routines) |
| Continuity Memory | Facts, preferences, owner rules, recall, and tentative patterns | [Guide](docs/integrations-assistant.md#intelligence-and-routines) |
| Cameras & images | Objective-driven camera/image interpretation with room context | [Guide](docs/integrations-assistant.md#home-and-connected-services) |
| Web search | Grounded current-information retrieval | [Guide](docs/integrations-assistant.md#home-and-connected-services) |
| Project Atlas | Project context, captures, tasks, and existing review workflows | [Guide](docs/integrations-assistant.md#home-and-connected-services) |
| Desktop bridge | Desktop agent queue/push delivery and acknowledgements | [Guide](docs/integrations-assistant.md#home-and-connected-services) |
| Physical Carvis | Scoped device pairing, dock status, speech commands, and acknowledgements | [Guide](docs/integrations-assistant.md#voice-and-display) |

The integration center is one grid of optional abilities. Home Assistant is a
core service configured in Settings, not an integration to enable or disable.
Open an integration for Overview, Controls, Settings, and Activity. Existing
HA selections, tokens, guards, and dry-run settings migrate without widening access.

TV AI Controller connects to an existing compatible controller installed as a Home Assistant add-on. This repository does not install that external controller or bundle its model/service credentials.

## Private by installation

Carvis binds to `127.0.0.1` by default. Your account, settings, conversations, memory, and integration state live in `.carvis/`, outside source control. Core configuration and data are encrypted with a local installation key. The optional assistant runtime also stores its working configuration, SQLite database, history, and logs in an owner-only `assistant-runtime` subdirectory. Its configuration contains working credentials and is not encrypted while in use. Back up the entire private data directory including `.key`; keep it outside cloud-synced source folders. These controls protect accidental exposure, not a compromised operating-system account.

Model requests are sent to the provider you configure. Enabled integrations may send task data to their configured services. Carvis does not include analytics or a hosted account service. Password fields are never returned by the settings API.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8788` | Web server port |
| `HOST` | `127.0.0.1` | Listening interface |
| `CARVIS_LISTEN_HOSTS` | `HOST` | Optional comma-separated explicit interfaces, e.g. loopback plus a private-network address |
| `CARVIS_SECURE_COOKIES` | unset | Set to `1` behind an HTTPS reverse proxy |
| `CARVIS_DATA_DIR` | `.carvis` in the project | Private installation data |
| `CARVIS_ALLOWED_HOSTS` | additional comma-separated hostnames | Explicit addresses permitted by the web server |
| `CARVIS_INTEGRATIONS_DIR` | `.carvis/integrations` | Trusted local integration modules |

Complete first-time setup from the server computer. For phone/glasses access, configure a reachable listening address and allowed hostname, and use HTTPS through your own trusted reverse proxy or private network. Do not forward the unauthenticated setup screen to the public Internet. This release is a single-owner self-hosted application, not a multi-tenant hosted service.

## Extend through Integrations

New capabilities belong in integrations. An integration provides its own setup fields, permissions, context, tools, and optional device routes. The core owns chat, storage, authentication, and the integration lifecycle.

See [integration development](docs/integration-development.md). Integration code runs with the server's permissions; install only modules you trust. There is no automatic third-party code download or remote marketplace installer.

## Development

```sh
npm test
npm run check
```

Core Carvis uses Node's built-in libraries. The optional assistant runtime is an npm workspace and installs its image/model dependencies with the root `npm install`. It runs in a child process with a private authenticated loopback connection and starts only when its Integration is enabled. Tests use temporary data and mock service boundaries. The glasses companion has a separate package and build instructions in its guide. CI checks the core, extracted runtime, release hygiene, and companion build.

## Existing installations

The offline [migration tool](docs/feature-parity.md#migration-implementation-and-verified-scope) imports an existing installation into a separate private directory, including its account, model configuration, selected devices, guards, protocols, timers, memories, and recent conversation. It does not start services or modify the original. Preview with `CARVIS_RUNTIME_PAUSED=1`; stop the old scheduler before starting the replacement normally so protocols cannot run twice. Keep the original installation and a consistent database backup until the new service and your physical clients have been verified.

TV navigation silence and short playback replies are options in TV AI Controller, rather than fixed assistant-wide rules. Other behavior and credentials live under the Integration that owns them. New trusted Integrations contribute tools/context to both standalone chat and the optional assistant engine through the registry.
