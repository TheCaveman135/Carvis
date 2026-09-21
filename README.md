# Carvis

A chatbot first. The rest is up to you.

Carvis is a self-hosted conversational assistant with an optional integration system. A fresh installation can chat with your chosen model and remember context you choose to save. Connecting your home, TV, or glasses is an explicit choice—not a requirement.

## Start

Requires **Node.js 22.18 or later** (Node.js 24 LTS recommended).

```sh
npm install
npm start
```

Open **http://localhost:8788**, create your local owner account, and configure a model in **Settings**. Choose OpenAI, an OpenAI-compatible endpoint, or Ollama. Enter a model ID available from your provider. For Ollama, use its compatible endpoint, normally `http://localhost:11434/v1`.

No API keys, home configuration, transcripts, personal memories, or device credentials are included. No integration is enabled by default. You provide your own model account; provider usage may have a cost.

## Make it yours

- **Chat:** separate conversations, real streamed responses, recent conversational context, and visible integration activity.
- **Memory:** add and remove facts or preferences yourself in Settings. Nothing is silently learned into long-term memory.
- **Integrations:** connect a service, configure its permissions, test it, and explicitly enable it. Disabled integrations supply no model tools.
- **Personality:** choose your name, your assistant's name, and how it should speak.

## Included integrations

| Integration | Adds | Setup |
| --- | --- | --- |
| Home Assistant | Selected entity state and typed device controls; per-device guards and dry run | [Guide](docs/integrations-home-assistant.md) |
| Apple TV AI | Visual TV tasks, direct buttons through the AI controller, progress, cancellation, and mid-task guidance | [Guide](docs/integrations-apple-tv.md) |
| Even Realities | Optional glasses companion, replies, interactive widgets, and opt-in microphone input | [Guide](docs/integrations-even-realities.md) |

Apple TV AI connects to an existing compatible controller installed as a Home Assistant add-on. This repository does not install that external controller or bundle its model/service credentials.

## Private by installation

Carvis binds to `127.0.0.1` by default. Your account, settings, conversations, memory, and integration state live in `.carvis/`, outside source control. Configuration and data are encrypted with a local installation key. The key is stored alongside the data with owner-only file permissions; this protects accidental file exposure, not a compromised operating-system account. Back up the entire data directory including `.key`.

Model requests are sent to the provider you configure. Enabled integrations may send task data to their configured services. Carvis does not include analytics or a hosted account service. Password fields are never returned by the settings API.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8788` | Web server port |
| `HOST` | `127.0.0.1` | Listening interface |
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

The root server has no runtime npm dependencies. Tests isolate data in temporary directories and mock external services. The glasses companion has a separate package and build instructions in its guide. CI checks the core, release hygiene, and companion build.

## Release scope

The public edition starts fresh. It does not migrate a configured legacy Carvis installation or run its home automations, desktop agents, or stored protocols. Those future capabilities can be implemented as integrations. Existing installations can keep running independently on their original port and data directory.
