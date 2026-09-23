/** Setup guidance is Integration metadata, not chatbot behavior or permissions. */
export const CATALOG = {
  'home-assistant': ['Home Assistant', ['Name your home and enter your Home Assistant URL and access token.', 'Devices appear automatically. Choose what Carvis may see and control.', 'Manage your connection, entities, and guards in Settings → Home Assistant.']],
  'apple-tv': ['TV AI Controller', ['Select a TV or remote for control in Settings → Home Assistant.', 'Configure a camera feed and remote in the controller, then choose your devices here.', 'Choose whether navigation is silent and playback replies are brief.']],
  proactivity: ['Proactive home alerts', ['Select the devices Carvis may observe in Settings → Home Assistant.', 'Choose when Carvis may interrupt you and how often.']],
  cameras: ['Cameras & Images', ['Choose a vision model and enable Advanced assistant.', 'Select cameras for observation in Settings → Home Assistant.', 'Add room notes or upload an image, then give Carvis a specific question.']],
  protocols: ['Routines, timers & alarms', ['Enable Advanced assistant.', 'Create a timer, alarm, or describe a routine to Carvis.', 'Device actions use the entities and permissions in Settings → Home Assistant.']],
  speech: ['Spoken replies', ['Choose where replies should play.', 'For phone audio, pair the Even Realities companion and enable its speaker.', 'For home speakers, select a speaker for control in Home Assistant settings and choose a TTS provider here.']],
  'even-realities': ['Even Realities glasses', ['Enter the Carvis address your phone can reach.', 'Generate a pairing token and enter it in the companion app.', 'Voice uses Voice input & chat and your global API keys. Choose Even glasses as the microphone there; Spoken replies controls audio output.']],
  'assistant-engine': ['Advanced assistant', ['Choose your main model in Carvis Settings.', 'Enable this shared component for voice, routines, memory, or other integrations that depend on it.', 'Enable the individual features you want in Integrations.']],
  voice: ['Voice input & chat', ['Choose a microphone on the Carvis server or paired Even glasses.', 'Add your speech recognition key once in Settings → Global API keys. Deepgram transcribes requests for your Carvis model.', 'Enable Spoken replies and choose a speaker to hear responses.']],
  'learned-memory': ['Continuity Memory', ['Enable Advanced assistant.', 'Review remembered facts, preferences, and changing details. Existing memories are imported automatically.', 'Explore what Carvis recalls for a question, inspect learned routines, or forget an entry.']],
  'web-search': ['Search the web', ['Choose your search provider and enter its API key.', 'Ask Carvis for current information.']],
  desktop: ['Computer agent connection', ['Configure your desktop agent and its connection.', 'Use this page to send a request and check its delivery.']],
  'physical-carvis': ['Carvis hardware', ['Pair your device with a private token.', 'Check device contact and command acknowledgements here.']],
};
const DESCRIPTIONS = {
  'home-assistant': 'Carvis’s built-in home connection. Choose which devices it can see and control, and manage their guards.',
  'apple-tv': 'Ask Carvis to find a movie, open an app, or navigate your TV. Works with a camera feed and a compatible Home Assistant remote configured in the TV AI controller.',
  proactivity: 'Let Carvis notice changes in your home and offer relevant updates without waiting for you to ask. Choose when it may interrupt.',
  cameras: 'Ask questions about uploaded pictures or selected camera feeds—for example, what is in a room. Add room notes to help Carvis understand what it sees.',
  protocols: 'Set timers and alarms, or create routines triggered by home events, schedules, and your requests. Device actions follow your Home Assistant permissions.',
  speech: 'Have Carvis read its replies aloud through a speaker on the Carvis server, your phone, a Home Assistant speaker, or Carvis hardware. Choose where the audio plays.',
  'even-realities': 'Use Carvis on Even Realities glasses: speak requests, read replies, and use interactive widgets. Requires the companion app and compatible glasses.',
  'assistant-engine': 'Adds multi-step planning and powers voice, memory, routines, and proactive alerts. Enable it for those integrations; core home control is already built into Carvis.',
  voice: 'Talk to Carvis instead of typing. Deepgram turns microphone audio into requests for your normal Carvis model. Spoken replies controls audio playback separately.',
  'learned-memory': 'Keep context across time: facts, preferences, changing details, and recurring routines. Review evidence, conflicting memories, and history; forget anything you choose.',
  'web-search': 'Let Carvis look up current information online when answering you. Requires a supported search provider and API key.',
  desktop: 'Send requests to a separate agent running on your computer and check their delivery. Requires a compatible desktop agent; this does not install one.',
  'physical-carvis': 'Connect a physical Carvis device, such as an ESP32-S3 unit, for device status, commands, and audio. Only needed if you have the hardware.',
};
const FIELD_HELP = {
  memory__maxFactsPerTurn: ['Relevant memories per request', 'Limits the facts recalled for each request. Historical records remain stored; owner rules are always respected.'],
  voice__inputDevice: ['Microphone source', 'Choose a microphone on the Carvis server, or enabled Even glasses. Local listening continues with the webpage closed.'],
  voice__inputMuted: ['Mute microphone', 'Stops local capture and rejects new audio from the selected source while muted.'],
  speech__localDevice: ['Local speaker', 'A speaker connected to the machine running Carvis. Uses the installed macOS voice.'],
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
  speech__outputMode: ['Where replies play', 'Choose a local speaker, phone, physical Carvis, Home Assistant speaker, or the configured fallback route.'],
  speech__autoReplies: ['Read replies aloud', 'Speak Carvis responses automatically, except intentionally silent actions.'],
  speech__mediaPlayer: ['Home Assistant speaker', 'A speaker selected for control in Home Assistant settings.'],
  speech__ttsEntity: ['Home Assistant voice service', 'The TTS provider entity that creates audio for your HA speaker.'],
  speech__language: ['Speech language', 'Choose a language to see the voices offered by your Home Assistant voice service.'],
  speech__voice: ['Home Assistant voice', 'Voices load automatically for your selected service and language. Leave on Service default to use its configured voice.'],
  carvis__maxRounds: ['Maximum thinking steps', 'Limits how many model/tool rounds one request can use.'],
  agent__allowedDomains: ['Allowed device types', 'Device categories Carvis may control, such as light or fan. Existing guards still apply.'],
  areaNotes: ['Room and object notes', 'Describe rooms or objects to help Carvis understand your home and camera images.'],
};
export function decorateAssistantIntegration(module) {
  const [title, steps] = CATALOG[module.id];
  if (['apple-tv','proactivity'].includes(module.id)) module.dependsOn = [...new Set([...(module.dependsOn || []), 'home-assistant'])];
  module.name = title;
  module.description = DESCRIPTIONS[module.id];
  module.setupSteps = steps;
  module.controls = { module: '/integrations/assistant-engine/controls.js', dependsOn: ['assistant-engine'] };
  delete module.workspaceUrl;
  delete module.workspaceDependsOn;
  if (module.id === 'speech') {
    const order = ['speech__outputMode', 'speech__autoReplies', 'speech__localDevice', 'speech__mediaPlayer', 'speech__ttsEntity', 'speech__language', 'speech__voice'];
    module.fields.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  for (const field of module.fields || []) {
    if (['openaiKey','anthropicKey','stt__deepgramKey','stt__assemblyaiKey','search__geminiKey'].includes(field.key)) field.description = 'Optional integration-specific key. Leave blank to use the shared key from Carvis Settings → Global API keys, or to keep an existing override.';
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
    if (field.key === 'stt__engine') {field.default='deepgram';field.type='select';field.options=[{value:'deepgram',label:'Deepgram'},{value:'assemblyai',label:'AssemblyAI'}];}
    if (field.key === 'areaNotes') field.type = 'room-notes';
    if (field.key === 'speech__outputMode') { field.type = 'select'; field.options = [
      {value:'physical_then_ha',label:'Physical Carvis, then Home Assistant speaker'},
      {value:'local_only',label:'Speaker on the Carvis server'},
      {value:'phone_only',label:'Phone only'}, {value:'physical_only',label:'Physical Carvis only'},
      {value:'ha_only',label:'Home Assistant speaker only'},
    ]; }
  }
}
