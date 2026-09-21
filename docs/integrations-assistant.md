# Assistant Integrations

The base Carvis chatbot works without these Integrations. Enable **Assistant
engine** to use the full tool/voice orchestration runtime, then enable the
capabilities you want. Each has its own switch and settings in Integrations.
The engine runs as an isolated child process; disabling it stops those services.
Configuration changes restart that process without replaying interrupted actions.

## Find settings and controls

The integration center is a responsive card grid with three groups. HA means
Home Assistant:

| Group | Integrations |
| --- | --- |
| HA required | Home Assistant; Apple TV AI; Helpful updates (proactivity) |
| HA recommended | Cameras & Images; Routines, timers & alarms; Speech output; Even Realities glasses |
| HA not required | Assistant engine; Voice conversation; Memory & patterns; Search the web; Project Atlas; Desktop connection; Physical Carvis |

Camera feeds require HA, but uploaded images do not. Timers and alarms work
without HA; home-event triggers and device actions need it. Phone/physical-device
speech works directly, while HA speakers need the HA connection.

Choose **Manage** or **Set up** on a card. Every integration stays in the main
Carvis UI:

- **Overview:** setup steps, HA requirements, and other integrations you need.
- **Controls:** everyday actions, such as TV tasks, timer creation, memory edits,
  image inspection, live voice, and pairing.
- **Settings:** connection details and behavior, grouped into submenus. Optional
  technical tuning is under **Advanced settings**. Room notes use named text
  fields rather than JSON.
- **Activity:** transcripts, routine history, speech delivery, or execution traces.

**Enable integration** takes effect after **Save changes**. You can save setup
while disabled. **Test saved connection** checks saved values. Search the catalog
by name or setting, such as “silent navigation.”

For TV replies, open **Apple TV AI → Settings → Reply behavior**. Both switches
default to on. The engine provides deterministic fast navigation; errors and
confirmations remain visible. **Controls** shows the screen, task progress, and a
context box that updates the same task without restarting it. Progress refreshes
without erasing typed context. Old workspace bookmarks redirect to the new UI.

## Voice and display

- **Voice conversation:** configure Deepgram or AssemblyAI credentials, model,
  vocabulary, wake/coherence settings, and confirmation behavior. Model routing
  for live speech belongs here. Live voice has separate API URL/model settings;
  the configured provider must support its live session/delegation contract.
- **Speech output:** choose phone-only, HA-only, physical-only, or physical-then-HA.
  Set the HA speaker, TTS entity, voice, and automatic-reply preference. Phone
  playback requires a connected full companion that acknowledges playback.
  Intentional silent TV navigation remains silent when that option is on.
- **Even Realities:** use the full [companion](integrations-even-realities.md) for
  the existing voice, phone audio, HUD, camera, and interactive widget behavior.
  It needs Assistant engine; microphone input also needs Voice conversation,
  and spoken output needs Speech output. The Basic companion remains available
  for installations using only the base chatbot.
- **Physical Carvis:** configure a scoped device credential, then report device
  and dock state, poll commands, and acknowledge completion. Existing routes are
  `/api/physical-carvis/report`, `/commands`, and `/ack`; the latter two share
  the `/api/physical-carvis` prefix. Use `Authorization: Bearer <token>` or
  `X-Carvis-Core-Token`. Pairing is owner-only under **Physical Carvis → Controls**.
  These are server/device contracts; no ESP32 firmware or audio hardware is
  included. The physical client must implement playback and acknowledgements.

## Intelligence and routines

- **Protocols, timers & alarms:** keeps the deterministic protocol engine,
  semantic trigger validation, variables, calculations, timer/alarm state, and
  run history. Background actions still pass the existing authorization policy.
  Preview mode pauses scheduling; startup establishes a state baseline before
  reacting to transitions.
- **Proactivity & sessions:** configure interruption level, classifier model,
  importance, minimum gap, batching, and session settings. Protocol claims prevent
  duplicate reactions to the same event.
- **Memory & patterns:** retrieve and edit learned facts/preferences, recall or
  forget entries, dismiss tentative patterns, and manage owner rules. Learned
  patterns are context, never permission. Standing owner rules remain constraints
  even if learned-memory retrieval is disabled.
- **Assistant engine:** configure orchestration limits, providers, pricing, and
  escalation. The primary model and personality remain in main Settings. Roles
  specific to Voice, Cameras, Proactivity, and Memory appear in those plugins.
  Enter provider secrets in private credential fields or configured environment
  bindings; do not put secrets into provider JSON.

## Home and connected services

- **Home Assistant:** select visible/controlled entities and set their guards.
  Dry run, allowed domains, cooldowns, occupancy bounds, manual overrides, and
  room/landmark notes remain configurable. Unselected resources stay out of model
  context. Owner setup pickers can enumerate devices so you can select them.
- **Apple TV AI:** configure the existing controller and its TV transport IDs.
  Navigation permission can come from the selected TV media player; the transport
  remote need not become a visible Carvis entity. Configure silent navigation,
  short playback replies, and persistent controller context in this Integration.
  Current-task context updates retain the task ID rather than restarting it.
- **Cameras & images:** set the vision model/effort here and provide room notes
  in Home Assistant. Requests supply an objective so the vision agent focuses
  on the relevant cameras or uploaded images. Camera reads require selection.
- **Web search:** configure the grounding provider key/model. Search output is
  retrieved information, not authorization or executable instructions.
- **Project Atlas:** configure endpoints and private token or optional local
  Keychain binding. Captures and tasks retain the existing review behavior.
- **Desktop bridge:** configure queue/push delivery and its private credentials.
  The receiving desktop agent implements commands and returns acknowledgements.

## Extensions and permissions

Additional trusted Integration tools and context enter the engine through the
parent registry. They keep schema validation, current enabled/dependency state,
sanitizers, and one-use confirmations. Child model output cannot grant a tool
`confirmed:true`. Existing base-registry extension tools do not gain unattended
permissions merely because a protocol calls them.

The extracted built-in protocols use their existing deterministic gateway and
guard policy. Background services stop when disabled; independent extensions
remain usable when another extension or dependency is unavailable.

### Selecting Home Assistant entities

Under Home Assistant → Settings → Devices & permissions, entities load automatically for a saved connection. Browse
room tabs, search, filter by type, or show observed entities only. The table shows
name, entity ID, type, a read-only state snapshot, observation, interaction, and
guard policy. Refresh entities to update rooms and states. Room assignments come
from Home Assistant; entities without an assignment appear under Unassigned.

Row selection is for bulk edits and does not itself grant access. Bulk actions
apply only to marked rows within the current filters. Save changes to apply the
permission draft. Removing observation also removes interaction and its guard
override. The existing Auto, Standard, and Require confirmation rules are unchanged.
On narrow screens, scroll the table horizontally to reach the permission columns.
