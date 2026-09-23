# Assistant Integrations

Carvis is a smart home controller with Home Assistant built in. Onboarding collects
your home name, connection, and entity permissions. After setup, use **Settings →
Home Assistant** to manage the connection, devices, room notes, and advanced settings.

Optional integrations add abilities to that home. **Advanced assistant** supplies
the shared planning and voice runtime for integrations such as memory, routines,
and proactive alerts. It runs as an isolated child process; configuration changes
restart it without replaying interrupted actions.

## Find settings and controls

The integration center is one responsive card grid. Search by name or setting,
or filter for enabled integrations and those needing attention. Home Assistant
is in Settings, outside this optional catalog. All integrations reuse the same
home connection and selected entity permissions.

Choose **Manage** or **Set up** on a card. Every integration stays in the main
Carvis UI:

- **Overview:** enable switch, quick controls, connection preferences, and dependencies.
- **Controls:** everyday actions, such as TV tasks, timer creation, memory edits,
  image inspection, live voice, and pairing.
- **Settings:** connection details and behavior, grouped into submenus. Optional
  technical tuning is under **Advanced settings**. Room notes use named text
  fields rather than JSON.
- **Activity:** transcripts, routine history, speech delivery, or execution traces.

**Enable integration** takes effect immediately. Settings save automatically,
including setup entered while disabled. **Test saved connection** checks saved values. Search the catalog
by name or setting, such as “silent navigation.”

For TV replies, open **TV AI Controller → Settings → Reply behavior**. Both switches
default to on. The engine provides deterministic fast navigation; errors and
confirmations remain visible. **Controls** shows the screen, task progress, and a
context box that updates the same task without restarting it. Progress refreshes
without erasing typed context. Old workspace bookmarks redirect to the new UI.

## Voice and display

**Voice Conversations** includes microphone selection, Mute/Unmute, an input meter,
connection errors, and a reconnect button. Changes save immediately without restarting
other assistant services. Local capture reconnects to the same selected device if it
stalls; it never silently switches to another microphone. Spoken replies is configured
separately, with a link to speaker setup on this screen.

- **Voice input & chat:** configure Deepgram or AssemblyAI credentials, model,
  vocabulary, wake/coherence settings, and confirmation behavior. Choose a local microphone or paired Even glasses. Local listening continues
  with the webpage closed unless muted. AI model roles are also available in
  **Settings → Model Router** when this integration is enabled.
- **Spoken replies:** choose a local speaker, phone-only, HA-only, physical-only, or physical-then-HA.
  Speakers and Home Assistant voice services load automatically into dropdowns.
  Choose a service, then optionally a language and voice from its available choices;
  **Service default** keeps the provider's configured voice. Changes autosave.
  Only speakers selected for control are offered. If no voice services are found,
  add a text-to-speech integration in Home Assistant first. Phone
  playback requires a connected full companion that acknowledges playback.
  Intentional silent TV navigation remains silent when that option is on.
- **Even Realities:** use the full [companion](integrations-even-realities.md) for
  the existing voice, phone audio, HUD, camera, and interactive widget behavior.
  It needs Advanced assistant; microphone input also needs Voice input & chat,
  and spoken output needs Spoken replies. The Basic companion remains available
  for installations using core home control without Advanced assistant.
- **Carvis hardware:** configure a scoped device credential, then report device
  and dock state, poll commands, and acknowledge completion. Existing routes are
  `/api/physical-carvis/report`, `/commands`, and `/ack`; the latter two share
  the `/api/physical-carvis` prefix. Use `Authorization: Bearer <token>` or
  `X-Carvis-Core-Token`. Pairing is owner-only under **Carvis hardware → Controls**.
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
- **Continuity Memory:** retains dated facts, preferences, owner rules, and their
  evidence. New facts can supersede older claims without losing history. Local
  reflection connects related notes; repeated successful requests can become
  tentative routines. Explore recalled context to see why information was chosen,
  edit or forget memories, and dismiss patterns. Existing memories and patterns
  migrate automatically. Patterns never grant permission; standing owner rules
  remain constraints even when learning is disabled.
- **Advanced assistant:** configure orchestration limits, providers, pricing, and
  escalation. The primary model and personality remain in main Settings. Roles
  specific to Voice, Cameras, Proactivity, and Memory appear in those plugins.
  Enter provider secrets in private credential fields or configured environment
  bindings; do not put secrets into provider JSON.

## Home and connected services

- **Settings → Home Assistant (core):** select visible/controlled entities and set their guards.
  Dry run, allowed domains, cooldowns, occupancy bounds, manual overrides, and
  room/landmark notes remain configurable. Unselected resources stay out of model
  context. Owner setup pickers can enumerate devices so you can select them.
- **TV AI Controller:** configure the existing controller and its TV transport IDs.
  Navigation permission can come from the selected TV media player; the transport
  remote need not become a visible Carvis entity. Configure silent navigation,
  short playback replies, and persistent controller context in this Integration.
  Current-task context updates retain the task ID rather than restarting it.
- **Cameras & images:** set the vision model/effort here and provide room notes
  in Home Assistant. Requests supply an objective so the vision agent focuses
  on the relevant cameras or uploaded images. Camera reads require selection.
- **Web search:** configure the grounding provider key/model. Search output is
  retrieved information, not authorization or executable instructions.
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

Under Settings → Home Assistant → Devices & permissions, entities load automatically for a saved connection. Browse
room tabs, search, filter by type, or show observed entities only. The table shows
name, entity ID, type, a read-only state snapshot, observation, interaction, and
guard policy. Refresh entities to update rooms and states. Room assignments come
from Home Assistant; entities without an assignment appear under Unassigned.

Row selection is for bulk edits and does not itself grant access. Bulk actions
apply only to marked rows within the current filters. Changes save automatically. Removing observation also removes interaction and its guard
override. The existing Auto, Standard, and Require confirmation rules are unchanged.
On narrow screens, scroll the table horizontally to reach the permission columns.
