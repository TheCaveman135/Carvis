# Assistant Integrations

The base Carvis chatbot works without these Integrations. Enable **Assistant
engine** to use the full tool/voice orchestration runtime, then enable the
capabilities you want. Each has its own switch and settings in Integrations.
The engine runs as an isolated child process; disabling it stops those services.
Configuration changes restart that process without replaying interrupted actions.

Use **Open workspace** for detailed execution traces, the protocol editor, image
attachments, the live TV view, transcripts, and the HUD preview. It remains on
the same Carvis origin and uses your existing owner login. The Back to Carvis
link returns to the main chat and Integration settings.

## Find settings

The catalog contains 14 integrations in four sections. Search by integration name
or by a setting, such as “silent navigation.” **All integrations** shows every
installed integration; **Enabled** and **Needs attention** narrow the list.

| Section | Integrations |
| --- | --- |
| Home & devices | Home Assistant; Apple TV AI; Cameras & images |
| Voice & display | Voice conversation; Speech output; Even Realities; Physical Carvis |
| Intelligence & routines | Assistant engine; Protocols, timers & alarms; Proactivity & sessions; Memory & patterns |
| Connected services | Web search; Project Atlas; Desktop bridge |

Choose **Configure** (or **Set up** before configuration), then the relevant
settings tab. **Enable integration** takes effect only after **Save changes**.
You can save settings while an integration is disabled. Required integrations
are listed above the tabs; workspaces are available once their dependencies are
enabled. **Test saved connection** checks the saved values, so save edits first.

For TV replies, go to **Integrations → Apple TV AI → Configure → Reply behavior**.
**Silent successful navigation** and **Short power and playback replies** both
default to on. Save either switch to choose your behavior. The deterministic fast
command path is provided by Assistant engine; failures and guarded requests still
surface. See [the TV guide](integrations-apple-tv.md) for the core-only behavior.

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
  `X-Carvis-Core-Token`. Pairing is owner-only through the workspace API.
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
