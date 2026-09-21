# Home Assistant integration

Open **Integrations → Home Assistant**, enter your server URL and a long-lived access token, and save. You can keep the integration disabled while setting it up. Reopen its settings to test the saved connection and load entities, then enable it when ready. All credentials stay on your Carvis server; they are not sent to the model. Use HTTPS when connecting across networks.

Select the entities Carvis may observe and control. The owner-facing entity picker may list your devices; the model sees only your selected entities. A controlled entity is also observable. Removing an entity takes effect on the next tool execution, including previously created widgets.

**Dry run is enabled by default.** Turn it off only when you want commands to reach Home Assistant. Dry-run results are labeled and never represent actual device changes.

Each controllable entity has a guard dropdown in its settings:

- **Auto · device default** uses protection inferred from the device.
- **Standard** explicitly permits normal control, overriding inferred protection.
- **Require confirmation** asks for owner confirmation before acting.

A guard can be configured only while **Control** is selected. Removing control also removes its explicit guard override. For API clients, these choices correspond to an omitted guard, `standard`, and `protected`, respectively. Without an override, security/environment devices and opaque scripts, scenes, automations, buttons, and remotes are protected. Merely naming an ordinary light after a stove or garage does not turn it into an appliance. Locking a lock is normally permitted on a direct request without a second confirmation; unlocking is protected. Protected actions cannot run from background events.

Every execution rechecks the current allowlist, device availability, service/domain compatibility, and typed parameter bounds. Number and temperature targets must fit device-reported limits; colors, effects, sources, and dropdown options must be supported by the device. Success means HA accepted a command; the result separately identifies whether a state change was observed.

Model tools:

| Tool | Purpose |
| --- | --- |
| `ha_list_entities` | List selected entity states only |
| `ha_get_state` | Read a selected entity's fresh state |
| `ha_command` | Send a typed service command with guards |

Examples include `{"entity_id":"light.example","service":"toggle"}`, or `{"entity_id":"light.example","service":"turn_on","brightness_pct":45}`. Media volume uses `volume_percent` from 0 to 100. The owner route `GET /api/integrations/home-assistant/entities` is intended for configuration UI and is never registered as a model tool.

Apple TV commands are delegated to the enabled Apple TV AI integration. Carvis does not fall back to direct remote services when that controller is missing or unavailable.

This initial public integration provides on-demand observation and guarded control. It does not migrate the private installation's learned patterns, protocols, or personal entity lists.
