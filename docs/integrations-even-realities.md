# Even Realities integration

The optional Even Realities integration connects a G2 glasses companion to your own Carvis server. The chatbot works without it; it is disabled until you configure and enable it in **Integrations**.

## Connect your own installation

1. Give your Carvis server an HTTPS address reachable from your phone. Keep access authenticated. Do not publish your data directory or credentials.
2. In **Integrations → Even Realities**, enter that address and generate a **Device pairing token**. Enable the integration.
3. Build the companion for your server origin. Even Hub requires the network origin in its package permission whitelist:

   ```sh
   cd integrations/even-realities
   npm ci
   CARVIS_PUBLIC_URL=https://your-carvis.example npm run pack
   ```

4. Upload the generated `carvis.ehpk` to your Even Hub developer dashboard and open it in the Even app. The source manifest's `https://carvis.example` address is a placeholder, not a hosted Carvis service.
5. Enter your **Carvis URL** and **Device pairing token** in the companion's phone screen and tap **Connect**. Both inputs start empty. Connection details are saved through Even's device storage; the token never goes in the URL.

The companion uses SDK 0.0.15 and requires Even app 2.2.10 or later. The generated `app.local.json`, packages, and build output are ignored by Git. Your address is stored in that local package whitelist, so build your own package rather than distributing somebody else's configured package. No credentials are bundled during packaging.

The device token is restricted to the integration's device endpoints. It can send messages, see the current HUD, and invoke enabled integration tools with their normal permission checks. It cannot administer Carvis settings. Treat it as private and regenerate it if lost; reconnect each paired device afterward.

## Chat and optional voice

Type messages on the phone; Carvis's replies appear there and at the bottom of the glasses. Long replies are shortened on the HUD, with the full reply kept on the phone. Reply captions clear after 30 seconds. With no widgets or caption, the glasses are blank.

For voice, enable **Voice transcription** in the integration settings and enter a speech provider API base URL, API key, and supported transcription model. The provider must implement an OpenAI-compatible `POST /audio/transcriptions` endpoint. The API key stays encrypted on the Carvis server. An optional language code can improve recognition.

Tap **Start microphone** on the phone, or tap the glasses while no widget is selected. Tap again to mute. The mic is off on startup. Local volume-based speech detection keeps quiet audio on the device and sends an utterance after about one second of silence. A request contains at most 30 seconds of 16 kHz mono audio. Muting discards an unfinished utterance. Audio is not saved by this integration; recognized text becomes part of the conversation. Your selected provider may apply its own data retention policy.

The current companion supports text replies and voice input. It does not add speech playback; G2 has no built-in audio output. Notifications and the native menu do not tear down the microphone or the app. Closing the app stops microphone capture. Physical microphone sensitivity and Bluetooth behavior still need validation on your glasses.

## Interactive widgets

Ask naturally: “Show a brightness slider for the desk light,” or “Give me buttons for the living room.” Enable and configure the relevant device integration first. The model only receives tools from enabled integrations.

The four slots are:

```text
1 | 3
2 | 4
```

Swiping selects occupied slots numerically. A border marks the selected widget. Buttons execute on tap. For sliders and dropdowns, tap to edit, swipe to preview, and tap again to apply. Double-tap cancels an unfinished edit and removes the outline; widgets stay visible. The native contextual menu includes **Clear screen**, which removes widgets and captions. Confirmation prompts stay available on the phone until answered or expired.

Each widget has separate display and action properties. A display may be blank, static, or bound to an explicitly read-only integration tool. Bindings refresh about every five seconds while connected. Disabling or restricting the source integration makes its state unavailable. A button invokes a registered tool with its stored arguments. A slider replaces one numeric argument. Each dropdown choice has its own stored action. The phone cannot submit a replacement tool name through a gesture request.

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
cd integrations/even-realities
npm run dev
# In another terminal, with the optional simulator installed:
evenhub-simulator http://localhost:5173 --automation-port 9898
```

Server tests cover widget validation, permissions, duplicate requests, live read sources, confirmations, audio boundaries, transcription, gesture order, and local voice segmentation. Build checks verify SDK types. Simulator checks supplement physical testing; they cannot establish Bluetooth reliability or microphone recognition quality.

SDK reference: [contextual menu](https://hub.evenrealities.com/docs/build/contextual-menu).
