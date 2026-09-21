# Even Realities integration

The optional Even Realities integration connects G2 glasses to your own Carvis installation. The full companion preserves the phone audio, widgets, captions, and background recovery of Carvis's glasses interface. All connection fields start empty; enabling the integration does not start a microphone.

## Connect the full companion

1. Give your Carvis installation an HTTPS address reachable from your phone.
2. Enable and configure **Assistant engine** and **Even Realities** in Carvis's Integrations. Enter your server address in Even Realities and generate a **Device pairing token**.
3. For microphone input, also configure and enable **Voice conversation**. Its speech recognition settings support the providers offered by that integration, including Deepgram. For spoken replies, configure and enable **Speech output**, then choose your output on the companion's phone screen. Home speaker playback also needs Home Assistant and a selected speaker.
4. Build the companion for your server origin. Even Hub requires that origin in the package network whitelist:

   ```sh
   cd integrations/even-realities
   npm ci
   CARVIS_PUBLIC_URL=https://your-carvis.example npm run pack
   ```

5. Upload `carvis.ehpk` to your Even Hub developer dashboard. Open the app, enter your **Carvis address** and **Token** under **Connection settings**, and tap **Save and reconnect**. The placeholder `https://carvis.example` in the source manifest is not a hosted service.
6. Tap **Unmute** to begin listening. Your mute preference is remembered. Tap again to turn off capture and discard unfinished audio.

The package uses SDK 0.0.15 and requires Even app 2.2.10 or later. Generated manifests, build output, and packages are ignored by Git. Packages contain your server origin in the whitelist, but no pairing token. The pairing token is saved in Even's device storage and never placed in a URL. It is limited to companion routes and cannot administer Carvis. Regenerate it in Integrations if it is lost, then reconnect each device.

The source and full companion use a separate storage namespace from older configured installations. HTTP is accepted only for loopback development; use HTTPS from a physical phone.

## Voice, replies, and phone audio

The full companion sends 16 kHz mono PCM to the server's voice pipeline. Local volume detection retains the beginning of speech, stops after about 900 ms of silence, and limits each utterance to 15 seconds. Until an address and pairing token are saved, it makes no server requests and leaves the microphone off. Recognition quality still depends on the microphone, environment, and configured speech provider.

Replies appear in readable pages at the bottom of the glasses. A page remains long enough to read after the glasses accept it, then the next page appears. Full replies and history remain on the phone; swiping on the glasses does not open history.

Choose **This iPhone** to play replies with the phone's speech voice, then tap **Enable phone audio** to unlock playback. The companion prefers an available British English voice. Keep the phone screen active for this output and re-enable it if the host stops playback. Home speaker output runs through the server independently. G2 glasses do not provide a speaker.

Temporary notifications and native menus keep the session running. Foreground recovery rebuilds invalid display containers; closing the app stops capture. These paths are covered by logic tests, but simulator checks cannot prove Bluetooth, iOS speech, or microphone reliability on hardware.

## HUD and interactive widgets

Ask naturally: “Show a brightness slider for the desk light,” or “Give me buttons for the living room.” Configure the relevant integration and select the devices Carvis may see or control first. With the Assistant engine enabled, Carvis's HUD tools create the full companion's widgets and bindings.

The four slots are:

```text
1 | 3
2 | 4
```

Swiping visits occupied slots numerically. A border marks the selected widget. Tap a button to execute its action. Tap a slider or dropdown to edit, swipe to preview, and tap again to apply. Double-tap cancels the edit and removes the selection outline; the widgets stay visible. The app menu includes **Clear screen** to remove widgets and captions. With no selection, a tap toggles mute. Pending guarded requests use the existing confirmation flow.

Widgets have separate display and interaction properties. They can show live device values, camera images, or text. Actions continue to use the selected entities and configured guards. Disabling an integration removes its capabilities from Carvis.

An empty HUD has no status text. The optional tiny bottom-left dot is controlled by **Microphone indicator** on the phone: show when muted, show when unmuted, or off.

## Basic companion without Assistant engine

A smaller companion remains available for installations using only the core chatbot and native integrations. It uses `/api/integrations/even-realities/*` instead of the full assistant's voice/HUD routes. Build it separately:

```sh
cd integrations/even-realities
CARVIS_PUBLIC_URL=https://your-carvis.example npm run pack:basic
```

Upload `carvis-basic.ehpk`; its app identifier is separate from the full companion. It supports typed chat, optional OpenAI-compatible transcription configured directly in Even Realities, basic interactive widgets, bottom reply captions, and a mute indicator. It does not include phone speech playback, camera images, or the full assistant's voice pipeline. Basic microphone capture starts off each launch.

The following payload applies to the Basic companion's `even_realities_set_widget` tool, not to the full assistant's HUD tools.

Here is the `even_realities_set_widget` payload for a Home Assistant light slider. Replace `light.desk` with an entity you selected in that integration:

```json
{
  "slot": 1,
  "display": {
    "title": "Desk light",
    "source": {
      "tool": "ha_get_state",
      "arguments": {"entity_id": "light.desk"},
      "path": "attributes.brightness",
      "scale": 0.3921568627,
      "suffix": "%"
    }
  },
  "interaction": {
    "kind": "slider",
    "action": {
      "tool": "ha_command",
      "arguments": {"entity_id": "light.desk", "service": "turn_on"}
    },
    "argument": "brightness_pct",
    "min": 0,
    "max": 100,
    "step": 5,
    "value": 50,
    "unit": "%"
  }
}
```

Actions bypass the language model once a widget exists. They still use the integration registry, entity selection, preview mode, and confirmation rules. A guarded action asks you to confirm once on the phone. Retrying the same gesture request does not execute it twice. An outdated widget ID is rejected.

## Development and validation

```sh
npm test
npm run build --prefix integrations/even-realities
npm run build:basic --prefix integrations/even-realities
cd integrations/even-realities
npm run dev
# With the optional simulator installed:
evenhub-simulator http://localhost:5173 --automation-port 9898
```

The default dev page is the full companion; `/basic.html` opens the Basic companion. Unit checks cover pairing validation and zero requests before pairing, gesture ordering and edit cancellation, overlay lifecycle recovery, microphone segmentation, and native widget permission checks. Both builds check SDK types.
