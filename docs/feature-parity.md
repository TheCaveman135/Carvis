# Full installation parity

The public edition must support the complete existing Carvis experience. A
home controller with a new interface but missing existing capabilities is not a completed migration. Capabilities
may move into optional Integrations, but moving them must preserve their behavior,
configuration, state, and permission boundaries.

Version 0.2.0 includes the complete extracted assistant, with optional services
owned by Integrations. The checks below describe software and migration coverage;
physical hardware checks are listed separately at the end.

## Base

- [x] Preserve conversation context and history, personality, model providers,
  model settings, authentication, and account sessions during migration.
- [x] Keep useful core home control and conversation with no optional Integrations enabled.
- [x] Provide generic Integration lifecycle, settings, UI, context, tool, and
  reply hooks; service-specific behavior stays inside Integrations.
- [x] Explain actions, failures, timings, confirmations, and actual outcomes in
  execution traces without exposing credentials or hidden model reasoning.

## Integrations

| Integration | Required existing behavior |
| --- | --- |
| Home Assistant | Selected entities only; live state and area context; lights, colors, effects, fans, switches, media, printers, and supported device actions; owner-editable guards; existing domain restrictions, dry run, cooldowns, occupancy rules, manual override policy, and confirmation rules. |
| Apple TV AI | All TV operations delegated to the configured controller; configurable silent successful navigation and short power/playback replies; complex tasks; progress, screen previews, stop, and additional context for a running task inside Carvis. |
| Voice conversation | Existing transcription providers and tuning; contextual coherence and follow-up commands; triage and fast actions; acknowledgement behavior; interruption handling; live voice sessions and captions. |
| Speech output | Automatic replies, action results, errors, and confirmation prompts; configured phone, HA speaker, and physical-device routing; ordered delivery, retries, acknowledgements, and delivery traces. Preserve intentional silent navigation. |
| Protocols | Existing rule engine, triggers, conditions, actions, validation, semantic event matching, editing, testing, history, variables, calculations, schedules, timers, alarms, and persisted runtime state. No duplicate execution during cutover. |
| Proactivity | Event classification, importance thresholds, rate limits, quiet behavior, session awareness, and deduplication against protocols; existing authorization boundaries for unattended actions. |
| Memory and patterns | Facts, preferences, owner rules, recall, forgetting, provenance, conversation continuity, learned patterns, dismissal, and preference learning. Patterns alone never authorize actions. |
| Cameras and images | Selected cameras, uploaded images, a focused objective for the vision model, scene/landmark context supplied by the owner, and useful location descriptions. |
| Even Realities | Existing phone/glasses connections, lifecycle recovery, microphone controls, blank idle display, configurable mute indicator, bottom replies, phone audio, interactive button/slider/dropdown widgets, numeric navigation, selection outlines, double-tap deselection, and menu clear action. History remains on the phone. |
| Web search | Configurable search provider credentials and model; grounded current-information retrieval. |
| Desktop bridge | Configurable queue/push delivery, command acknowledgements, and desktop agent state. |
| Physical Carvis | Device pairing, scoped credentials, status reports, command polling, acknowledgements, and voice support compatible with the physical device. |

Each Integration needs setup inputs, an explicit enable/disable switch, meaningful
connection/status feedback, documentation, and tests. Disabling one must revoke
its tools and stop its background activity. Dependencies must be explicit rather
than silently enabling another Integration.

## Release and migration gates

- [x] Public source contains no personal facts, scene descriptions, device IDs,
  addresses, credentials, transcripts, or configured installation data.
- [x] Import all supported settings and durable state through a private migration
  path; report unmapped settings instead of silently discarding them.
- [x] Preserve resource selections and guard policies exactly. Never broaden
  permissions because the new adapter accepts additional services or domains.
- [x] Verify existing regression tests against the extracted implementations,
  plus Integration disable/revocation, dependency, and lifecycle behavior.
- [x] Verify current companion/device API compatibility or deliver and verify a
  replacement before declaring migration complete.
- [x] Verify the new UI and configured service outside cloud-synced runtime
  storage, with the configured installation backed up and a rollback path.
- [x] Stop the previous scheduler before starting the replacement scheduler;
  verify persisted protocols and timers without causing test device actions.
- [x] Verify login, chat, context, traces, Integrations, and automatic speech;
  distinguish software checks from physical-device checks still outstanding.
- [x] Publish only the sanitized source and validated build. Switch the existing
  installation only after parity checks pass.

## Migration implementation and verified scope

`scripts/migrate-legacy.mjs` is an offline importer. It requires explicit source
and destination paths, rejects nonempty destinations and known cloud-storage
paths, stages changes privately, and never launches a runtime or contacts a
device. Run it only after selecting the private destination and cutover plan:

```sh
node scripts/migrate-legacy.mjs --source /path/to/existing-installation --data /path/to/private-carvis-data
```

The importer preserves the original configuration and environment as encrypted
Integration state. It also keeps a normalized private configuration with legacy
code defaults recovered as literal data: transcription vocabulary, live voice
connection settings, and TV controller transport identifiers. The transport
remote is not added to observed or controlled entities. Existing authentication,
primary model credentials, personality, and the latest 32 valid conversation
messages are imported. Original conversation and pattern files remain available
to the extracted runtime. SQLite's backup API copies committed WAL data, followed
by an integrity check; it preserves all database tables, including protocols,
timers, and learned memories.

Inline provider credentials are moved into private environment bindings before
settings reach the UI. Existing active bindings retain precedence, naming
collisions preserve their original values, and the exact original configuration
remains encrypted for recovery.

Optional `--public-url https://carvis.example` supplies the new glasses connection
URL. Learned memory remains in the runtime database by default. The explicit
`--import-core-memory` option also copies distinct memory text into the standalone
chatbot's memory store; this duplication is unnecessary when using Learned Memory.

The report contains counts and booleans only. A nonzero `unmappedDefaults` count
requires review before cutover. The original private configuration remains
preserved even when a setting does not have a generated input field. The importer
does not create runtime plaintext configuration, start background jobs, or claim
that a migrated provider or physical device is reachable.

Verified with `node --test test/migration.test.js`: **9 synthetic tests pass**.
They cover account verification, custom provider-key bindings, unchanged source
files, WAL-backed memory and timer preservation, encrypted credentials, private
file permissions, conversation import, destination safeguards, failed-copy
rollback, literal-only code-default parsing, and the real configuration projector
retaining guards, domain restrictions, cooldowns, vocabulary, and device tokens.
These fixtures do not themselves establish physical hardware behavior.

Verified separately with `node --test test/assistant-runtime.test.js`: **13 HTTP and lifecycle
boundary tests pass** using actual child workers and synthetic configuration.
They cover a fresh installation with every Integration off, private worker HTTP
authentication, authenticated owner access, disabled feature endpoints, secret
redaction, device credential scopes, rejection of a forged device origin during
owner confirmation, persisted decline evidence, and worker shutdown/access
revocation after disabling Integrations. Extension bridge tests cover tool and
context availability, schema validation, parent-owned confirmation, background
denial, changed-configuration rejection, dependency revocation, Integration
sanitizers, and removal of a glasses confirmation after approval in the main UI.
They make no external device calls.

## Regression coverage

The extracted implementation's regression suite runs with Integration lifecycle
and migration checks. Coverage includes:

| Area | Required regression coverage |
| --- | --- |
| Voice and coherence | Contextual short TV follow-ups; wake-word and confirmation boundaries; low-confidence guarded actions; no extra model call for a simple acknowledgement action; STT vocabulary only on compatible models. |
| Speech and live voice | Ordered acknowledgement/results; errors and confirmations spoken; intentional silent navigation; phone playback acknowledgement; output-route changes while queued; bounded retries without replaying uncertain actions; delegated live requests deduplicated. |
| Protocols and proactivity | Startup baseline does not fire restored rules; semantic event validation; persisted timers execute once; paused timers keep remaining duration; source-unavailable conditions fail closed; event claims prevent duplicate unattended actions. |
| TV and cameras | Every TV action uses the controller; context updates preserve task identity; uncertain commands are not automatically retried; selected-resource and guard checks survive migration; camera objectives and owner scene context remain bounded; uploaded images expire. |
| Memory and patterns | Recall and explicit preferences retain provenance; conflicting observations reduce confidence; failed, dry-run, automatic, guarded, or unselected actions do not become learned permission; deleted resources disappear from current context. |
| Glasses and physical device | Overlay lifecycle recovery without pausing; existing microphone transport; widget ordering, editing, and double-tap deselection; scoped pairing; command acknowledgements; docked speech and configured fallback behavior. |
| Integration boundaries | Disabling a feature removes its tools and blocks its API and background jobs; disabling dependencies does not silently re-enable them; device credentials cannot read owner settings or consume owner confirmations. |

Passing software fixtures must be reported separately from observed login, live
voice, speaker playback, glasses display, physical-device behavior, and protocol
execution after the actual cutover. In particular, preserving a live voice model
and endpoint from the old installation does not establish current API support.

## Version 0.2.0 verification

- `npm test`: **421 tests pass**, including the standalone chatbot, extracted
  assistant, migration, confirmation evidence, cancellation, permission boundaries,
  both TV reply options, and companion contract tests.
- `npm run check`: tracked-source privacy and release-file checks pass.
- Both full and basic glasses companions build and package successfully. Simulator
  startup, blank initial configuration, idle display, and the mobile settings
  layout were checked.
- A configured migration was verified outside cloud-synced runtime storage. Account
  signing state, resource selections, guards, automation policy, model roles,
  speech settings, and pairing credentials matched the source. The prior service
  was stopped before the replacement started; its source and a final backup were
  retained.
- Authenticated pages and settings, the management workspace, a real model reply,
  the HA connection, protocol startup, configured network interfaces, and the
  existing glasses-token API were verified. The device token was also rejected
  from owner settings.

Remaining physical acceptance checks require connected hardware: audible phone or
speaker TTS, microphone quality, Bluetooth glasses interaction, and physical Carvis
device behavior. No test routine actuated household devices. Live voice session
configuration and API support were checked; an actual microphone/WebRTC call is
still a separate hardware/browser check. The Physical Carvis Integration preserves
the existing device server API; this release does not introduce ESP32 firmware.

## Integration center update (0.3.0)

The integration center uses one grid with setup guidance and native Overview,
Controls, Settings, and Activity pages. Home Assistant is configured in Settings
as a core service. The former workspace entry points redirect into Carvis.
Camera feeds require Home Assistant; uploaded images do not. TV control and
proactive home updates use the core Home Assistant connection.

Validation: 428 automated tests pass, including dependency revocation, imported
connection compatibility, authenticated control assets, and live microphone cleanup.
All 42 Controls/Settings/Activity panels were checked with synthetic browser data;
desktop grid and mobile layouts were inspected. Browser action checks verified that
TV context targets the existing task and disabled reply options save as false.
These checks do not establish physical microphone, speaker, or device behavior.
