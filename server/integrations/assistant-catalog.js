/** Setup guidance is Integration metadata, not chatbot behavior or permissions. */
export const CATALOG = {
  'home-assistant': ['required', 'Connects your own Home Assistant server. Choose exactly which devices Carvis can see and control.', 'Home Assistant', ['Enter your Home Assistant URL and long-lived access token.', 'Devices appear automatically after connecting. Choose what Carvis may see and control.']],
  'apple-tv': ['required', 'Apple TV AI sends every TV command through your Home Assistant controller.', 'Apple TV AI', ['Connect Home Assistant and select your TV for control.', 'Enter the Apple TV AI add-on and TV connection details.', 'Choose whether navigation is silent and playback replies are brief.']],
  proactivity: ['required', 'Uses Home Assistant events to notice changes around your home.', 'Proactive home alerts', ['Connect Home Assistant and select the devices to observe.', 'Choose when Carvis may interrupt you and how often.']],
  cameras: ['recommended', 'Home Assistant is needed for live camera feeds. Uploaded images can be inspected without it.', 'Cameras & Images', ['Choose a vision model and enable Advanced assistant.', 'For live cameras, connect Home Assistant and select cameras for observation.', 'Add room notes or upload an image, then give Carvis a specific question.']],
  protocols: ['recommended', 'Timers and reminders work alone. Device actions and home-event triggers need Home Assistant.', 'Routines, timers & alarms', ['Enable Advanced assistant.', 'Create a timer, alarm, or describe a routine to Carvis.', 'Connect Home Assistant for routines that use your devices.']],
  speech: ['recommended', 'Home Assistant is needed for HA speakers. Phone and physical Carvis audio can work without it.', 'Spoken replies', ['Choose where replies should play.', 'For phone audio, pair the Even Realities companion and enable its speaker.', 'For home speakers, connect Home Assistant and select a speaker and TTS provider.']],
  'even-realities': ['recommended', 'Chat and captions work without Home Assistant. Smart-home widgets need a connected home.', 'Even Realities glasses', ['Enter the Carvis address your phone can reach.', 'Generate a pairing token and enter it in the companion app.', 'Choose display, microphone, and phone-audio preferences.']],
  'assistant-engine': ['not-required', 'Works with your model provider. Home Assistant is only needed for home-related abilities.', 'Advanced assistant', ['Choose your main model in Carvis Settings.', 'Enable this shared component before adding voice, routines, memory, or other integrations that depend on it.', 'Enable the individual features you want in Integrations. Basic text chat works without this component.']],
  voice: ['not-required', 'Uses a microphone and your speech provider. No smart-home connection is needed.', 'Voice input & chat', ['Choose a speech recognition provider and add its key.', 'Use live voice here, or pair a microphone device such as the glasses companion.']],
  'learned-memory': ['not-required', 'Stores facts, preferences, and patterns in this Carvis installation.', 'Memory & patterns', ['Enable Advanced assistant.', 'Add what you want Carvis to remember, and review learned suggestions.']],
  'web-search': ['not-required', 'Connects directly to your search provider.', 'Search the web', ['Choose your search provider and enter its API key.', 'Ask Carvis for current information in chat.']],
  atlas: ['not-required', 'Connects to your Project Atlas server.', 'Project Atlas connection', ['Enter your Atlas server address and credentials.', 'Choose which project context to share with Carvis.']],
  desktop: ['not-required', 'Connects to your desktop agent directly.', 'Computer agent connection', ['Configure your desktop agent and its connection.', 'Use this page to send a request and check its delivery.']],
  'physical-carvis': ['not-required', 'Pairs with a physical Carvis device directly.', 'Carvis hardware', ['Pair your device with a private token.', 'Check device contact and command acknowledgements here.']],
};
const DESCRIPTIONS = {
  'home-assistant': 'Connect your smart home so Carvis can check devices and control the ones you allow. Requires your own Home Assistant server.',
  'apple-tv': 'Ask Carvis to find a movie, open an app, or navigate your TV. Requires Home Assistant and a separate Apple TV AI controller.',
  proactivity: 'Let Carvis notice changes in your home and offer relevant updates without waiting for you to ask. Choose when it may interrupt.',
  cameras: 'Ask questions about uploaded pictures or selected camera feeds—for example, what is in a room. Add room notes to help Carvis understand what it sees.',
  protocols: 'Set timers and alarms, or create repeatable routines. Connect Home Assistant for routines triggered by your devices or that control your home.',
  speech: 'Have Carvis read its replies aloud through your phone, a Home Assistant speaker, or Carvis hardware. Choose where the audio plays.',
  'even-realities': 'Use Carvis on Even Realities glasses: speak requests, read replies, and use interactive widgets. Requires the companion app and compatible glasses.',
  'assistant-engine': 'The shared component required by voice, memory, routines, and other advanced integrations. Enable this first, then add the features you want. Basic text chat works without it.',
  voice: 'Talk to Carvis instead of typing. Turns microphone audio into requests and supports live voice conversation. Spoken replies controls audio playback separately.',
  'learned-memory': 'Help Carvis remember your preferences and learn recurring patterns. Review what it remembers and remove anything you no longer want saved.',
  'web-search': 'Let Carvis look up current information online when answering you. Requires a supported search provider and API key.',
  atlas: 'Connect an existing Project Atlas server to share project context and save notes from Carvis. Only needed if you already use Project Atlas.',
  desktop: 'Send requests to a separate agent running on your computer and check their delivery. Requires a compatible desktop agent; this does not install one.',
  'physical-carvis': 'Connect a physical Carvis device, such as an ESP32-S3 unit, for device status, commands, and audio. Only needed if you have the hardware.',
};
const FIELD_HELP = {
  voice__enabled: ['Accept voice requests', 'Allow spoken requests to enter the assistant conversation.'],
  voice__requireWakeWord: ['Require a wake word', 'Only treat speech as a request when it includes a configured wake word.'],
  voice__wakeWords: ['Wake words', 'Names or phrases you use to address Carvis. Enter one per line.'],
  stt__enabled: ['Transcribe microphone audio', 'Turn incoming microphone audio into text using your selected provider.'],
  stt__keyterms: ['Names and important words', 'Help recognition with device names or words you use often. One per line.'],
  classifier__enabled: ['Notice home events', 'Let Carvis review changes from selected Home Assistant devices.'],
  classifier__proactivity: ['Proactivity level', 'How readily Carvis responds to changes. Keep your existing value unless you want more or fewer interruptions.'],
  sessions__enabled: ['Recognize activity sessions', 'Group related home activity into sessions.'],
  glasses__enabled: ['Accept companion connections', 'Allow the paired glasses and phone companion to connect.'],
  glasses__proactive: ['Show proactive updates', 'Allow relevant unsolicited updates to appear on your glasses.'],

  stt__engine: ['Speech recognition provider', 'The service that turns your microphone audio into text.'],
  stt__model: ['Speech recognition model', 'Use a model supported by your chosen speech provider.'],
  stt__language: ['Spoken language', 'Language code, such as en for English.'],
  speech__outputMode: ['Where replies play', 'Choose a phone, physical Carvis, Home Assistant speaker, or the configured fallback route.'],
  speech__autoReplies: ['Read replies aloud', 'Speak Carvis responses automatically, except intentionally silent actions.'],
  speech__mediaPlayer: ['Home Assistant speaker', 'A speaker selected for control in Home Assistant settings.'],
  speech__ttsEntity: ['Home Assistant voice service', 'The TTS provider entity that creates audio for your HA speaker.'],
  carvis__maxRounds: ['Maximum thinking steps', 'Limits how many model/tool rounds one request can use.'],
  liveVoice__model: ['Live conversation model', 'The voice model used for an ongoing browser conversation.'],
  liveVoice__voice: ['Live voice', 'Optional voice name supported by the live conversation model.'],
  agent__allowedDomains: ['Allowed device types', 'Device categories Carvis may control, such as light or fan. Existing guards still apply.'],
  areaNotes: ['Room and object notes', 'Describe rooms or objects to help Carvis understand your home and camera images.'],
};
export function decorateAssistantIntegration(module) {
  const [requirement, note, title, steps] = CATALOG[module.id];
  module.homeAssistant = { requirement, note };
  if (['apple-tv','proactivity'].includes(module.id)) module.dependsOn = [...new Set([...(module.dependsOn || []), 'home-assistant'])];
  module.name = title;
  module.description = DESCRIPTIONS[module.id];
  module.setupSteps = steps;
  module.controls = { module: '/integrations/assistant-engine/controls.js', dependsOn: ['assistant-engine'] };
  delete module.workspaceUrl;
  delete module.workspaceDependsOn;
  for (const field of module.fields || []) {
    const help = FIELD_HELP[field.key];
    if (help) [field.label, field.description] = help;
    const role = /^models__roles__([^_]+|voice_triage)__(.+)$/.exec(field.key);
    if (role) {
      const purpose = {carvis:'Main assistant',escalation:'Complex requests',chat:'Conversation',voice_triage:'Voice request routing',triage:'Home-event decisions',vision:'Image understanding',rule:'Preference learning'}[role[1]] || role[1];
      const setting = {provider:'provider',model:'model',effort:'reasoning level',maxTokens:'maximum reply tokens',temperature:'response variation',timeoutSec:'timeout (seconds)'}[role[2]] || role[2];
      field.label = `${purpose}: ${setting}`;
      field.description ||= role[2] === 'provider' ? 'The provider ID from Advanced assistant → Model roles → Advanced settings.' : undefined;
    }
    // Protocol/provider JSON, limits and sampling settings are optional tuning.
    field.advanced = field.type === 'json' && !['areaNotes'].includes(field.key)
      || /(?:temperature|topP|numCtx|maxTokens|maxRounds|Cooldown|backoff|retry|pricing|models__providers|ollama__)/i.test(field.key);
    if (field.type === 'json' && /(?:keyterms|allowedDomains|wakeWords|intents)$/.test(field.key)) field.type = 'string-array';
    if (['voice__wakeWords','stt__keyterms'].includes(field.key)) field.advanced = false;
    if (/^(?:tools__|memory__|voice__(?:historyTurns|minChars|dedupeWindowSec|confirmationTimeoutSec)|glasses__(?:feedSize|proactiveMinGapSec))/.test(field.key)) field.advanced = true;
    if (field.key === 'stt__engine') {field.type='select';field.options=[{value:'deepgram',label:'Deepgram'},{value:'assemblyai',label:'AssemblyAI'}];}
    if (field.key === 'areaNotes') field.type = 'room-notes';
    if (field.key === 'speech__outputMode') { field.type = 'select'; field.options = [
      {value:'physical_then_ha',label:'Physical Carvis, then Home Assistant speaker'},
      {value:'phone_only',label:'Phone only'}, {value:'physical_only',label:'Physical Carvis only'},
      {value:'ha_only',label:'Home Assistant speaker only'},
    ]; }
  }
}
