# Home Assistant — built into Carvis

Home Assistant is a core service. New owners must name their home, enter their
HA URL and long-lived token, and select entities during onboarding.
Afterward use **Settings → Home Assistant** for connection changes, entity
selection, room notes, device types, dry run, and guard overrides.
Existing installations migrate their saved settings without changing access.

## Connection and devices

Enter your server URL and long-lived access token during home setup. Settings save
automatically and entities load as soon as the connection is saved. Choose at least
one entity, then finish setup. Afterward, open **Settings → Home Assistant** to
reconfigure the connection or test it. Credentials stay on your Carvis server and
are never sent to the model. Use HTTPS when connecting across networks.

Select the entities Carvis may observe and control. The owner-facing entity picker may list your devices; the model sees only your selected entities. A controlled entity is also observable. Removing an entity takes effect on the next tool execution, including previously created widgets.

**Dry run is enabled by default.** Turn it off only when you want commands to reach Home Assistant. Dry-run results are labeled and never represent actual device changes.

Each controllable entity has a guard dropdown in its settings:

- **Auto – Standard / Auto – Critical** uses protection inferred from the device.
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

Warm, neutral, and cool white requests also work for color lights without a
dedicated white-temperature setting. Carvis sends the requested Kelvin value to
Home Assistant, which converts it to the light's supported color controls. These
results are identified as approximate white tones. Lights with native white
temperature still use their reported limits; fixed-color lights cannot change
tone. The same behavior applies to core commands, Advanced Assistant, and saved
protocol actions, with entity permissions, guards, and dry run preserved.

Apple TV commands are delegated to the enabled Apple TV AI integration. Carvis does not fall back to direct remote services when that controller is missing or unavailable.

This initial public integration provides on-demand observation and guarded control. It does not migrate the private installation's learned patterns, protocols, or personal entity lists.
