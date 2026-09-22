# Carvis

**A self-hosted smart home AI controller built around your Home Assistant home.**

Carvis connects to Home Assistant as part of its initial setup. It gives you a home dashboard, lets you choose exactly which entities it may see and control, and uses an AI model to understand requests about those devices. Voice, routines, cameras, TV control, glasses, and memory are optional integrations that build on the same home and permissions.

[Get started](#get-started) · [How home control works](#how-home-control-works) · [Integrations](#add-abilities) · [Privacy and access](#privacy-and-access)

## Your home comes first

- **See your home:** selected devices and their current states appear on the Home dashboard. Room assignments come from Home Assistant.
- **Control it naturally:** ask about a device, change a light or fan, or follow up on a previous request. Carvis uses only entities you selected and actions the device supports.
- **Set the boundaries:** choose Observe or Interact access per entity. Configure allowed device types, dry run, and an automatic or explicit guard for each controllable entity.
- **Know what happened:** confirmations and execution traces distinguish a proposed action, an accepted command, and an observed state change.

For example, after allowing a living room light, you can ask Carvis to set it to a warmer color at 30% brightness, then ask whether it is still on. Carvis checks the entity's current capabilities and your permissions before sending a command.

## Get started

You need **Node.js 22.18 or later**, a Home Assistant server with a long-lived access token, and an AI model provider. Carvis supports OpenAI, an OpenAI-compatible endpoint, or Ollama.

```sh
git clone https://github.com/TheCaveman135/Carvis.git
cd Carvis
npm ci
npm start
```

Open **http://localhost:8788** on the server computer. Then:

1. Create the owner account.
2. Name your home, enter your Home Assistant URL and token, and select the entities Carvis may observe or control.
3. Choose your model in Settings. Available models load into a dropdown for supported providers.
4. Review **Settings → Home Assistant** before live control. **Dry run is on by default**, so initial commands are previews until you turn it off.

Settings save automatically. The Home Assistant connection and entity permissions are built into Carvis; there is no Home Assistant integration to enable. See the [home setup guide](docs/integrations-home-assistant.md) for guards, device types, and connection details.

## How home control works

Carvis shows the model only the entities you selected. For every home action, the server checks the current selection, permitted device type, device capabilities, dry-run setting, and guard. Protected actions require owner confirmation. Removing an entity's access takes effect on the next execution, including actions from widgets or integrations.

The Home dashboard, conversations, and optional input devices all use this same home connection. Carvis does not grant an integration broader device access just because it is enabled.

## Add abilities

The **Integrations** page is a grid of optional features. Each integration has its own setup, controls, and activity. Disabled integrations do not provide model tools.

| If you want to… | Enable | Learn more |
| --- | --- | --- |
| Speak to Carvis and review what it heard | Advanced assistant + Voice input & chat | [Voice and display](docs/integrations-assistant.md#voice-and-display) |
| Hear replies on a local, phone, Home Assistant, or physical speaker | Spoken replies | [Speech setup](docs/integrations-assistant.md#voice-and-display) |
| Create home routines, timers, and alarms | Routines, timers & alarms | [Routines](docs/integrations-assistant.md#intelligence-and-routines) |
| Get relevant home alerts | Proactive home alerts | [Proactivity](docs/integrations-assistant.md#intelligence-and-routines) |
| Keep preferences and context across time | Continuity Memory | [Memory](docs/integrations-assistant.md#intelligence-and-routines) |
| Ask about selected cameras or uploaded images | Cameras & images | [Vision](docs/integrations-assistant.md#home-and-connected-services) |
| Navigate a TV by looking at its screen | TV AI Controller | [TV setup](docs/integrations-apple-tv.md) |
| Use Even Realities glasses and interactive widgets | Even Realities glasses | [Companion guide](docs/integrations-even-realities.md) |

Web search, a desktop agent connection, and physical Carvis device pairing are also available. Advanced assistant supplies the shared runtime used by several integrations. The TV integration connects to an **existing compatible controller add-on** in Home Assistant; this repository does not include that separate controller.

## Privacy and access

Carvis is a single-owner application and listens on `127.0.0.1` by default. A fresh install contains no home credentials, selected entities, personal memories, or enabled integrations. Your account, settings, conversations, and integration data are stored in `.carvis/`, outside source control. Core configuration and data are encrypted with a local installation key. The optional assistant runtime keeps working files in a private subdirectory; its active configuration can contain unencrypted service credentials.

Back up the **entire** data directory, including `.key`, and keep it outside a cloud-synced source folder. Model requests go to the provider you configure, and enabled integrations may contact their configured services. Carvis has no hosted account service or built-in analytics.

For access from a phone, glasses, or another machine, configure an explicit listening interface and allowed hostname, then use your own trusted HTTPS proxy or private network. Complete the initial owner setup from the server computer; do not expose the setup screen to the public Internet.

<details>
<summary>Server configuration</summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8788` | Web server port |
| `HOST` | `127.0.0.1` | Listening interface |
| `CARVIS_LISTEN_HOSTS` | `HOST` | Explicit comma-separated interfaces |
| `CARVIS_ALLOWED_HOSTS` | None additional | Extra hostnames accepted by the web server |
| `CARVIS_SECURE_COOKIES` | Unset | Set to `1` behind an HTTPS proxy |
| `CARVIS_DATA_DIR` | `.carvis` | Private installation data |
| `CARVIS_INTEGRATIONS_DIR` | `.carvis/integrations` | Trusted local integration modules |

</details>

## License and community

Carvis is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). If you run a modified version for people over a network, the license requires you to offer them its corresponding source. Update the app's **Source code** link to point to that version. See [Contributing](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [Support](SUPPORT.md) for project guidelines. Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/TheCaveman135/Carvis/security/advisories/new).

## Extend or migrate

New capabilities belong in [Integrations](docs/integration-development.md). A trusted integration can add setup fields, permissions, context, tools, and device routes. Integration code runs with the server's permissions; Carvis does not automatically download third-party modules.

If you are moving an older Carvis installation, use the offline [migration guide](docs/feature-parity.md#migration-implementation-and-verified-scope). It imports data into a separate private directory without modifying the original installation.

For contributors, run `npm test` and `npm run check`. The Even Realities companion has [separate build instructions](docs/integrations-even-realities.md). CI checks the core, assistant runtime, release hygiene, and companion build.
