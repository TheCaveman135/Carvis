import { listHostAudio } from '../../integrations/assistant-runtime/server/host-audio.js';
import { SECTION_OWNERS, sectionFields } from '../assistant-config.js';
import { runtimeFor } from '../assistant-runtime.js';
import { decorateAssistantIntegration } from './assistant-catalog.js';

const descriptions = {
  'assistant-engine': ['Advanced assistant', 'Conversation, fast commands, model roles, detailed execution traces, and coordination of your enabled Integrations.', 'Intelligence & routines'],
  voice: ['Voice conversation', 'Speech recognition, contextual follow-ups, and acknowledgements through the normal assistant.', 'Voice & display'],
  speech: ['Speech output', 'Read replies through your configured phone, Home Assistant speaker, or physical Carvis.', 'Voice & display'],
  protocols: ['Protocols, timers & alarms', 'Create and manage deterministic routines, timers, alarms, variables, and their execution history.', 'Intelligence & routines'],
  proactivity: ['Proactivity & sessions', 'Notice meaningful changes, respect your interruption settings, and track activity sessions.', 'Intelligence & routines'],
  'learned-memory': ['Memory & patterns', 'Retain facts, preferences, owner rules, and tentative patterns with recall and dismissal controls.', 'Intelligence & routines'],
  cameras: ['Cameras & images', 'Inspect selected cameras or uploaded images with an objective and your room context.', 'Home & devices'],
  'web-search': ['Web search', 'Look up current information using your configured search provider.', 'Connected services'],
  atlas: ['Project Atlas', 'Bring project context, captures, and reviewed task workflows into Carvis.', 'Connected services'],
  desktop: ['Desktop bridge', 'Send requests to your desktop agent through its configured queue or push endpoint.', 'Connected services'],
  'physical-carvis': ['Physical Carvis', 'Pair a physical device, receive status reports, and deliver acknowledged commands and speech.', 'Voice & display'],
};
const password = (key, label, group = 'Credentials') => ({ key, label, type: 'password', group, description: 'Stored privately. Leave blank to keep the current value.' });
function validateFields(fields, input = {}) {
  const output = { ...input };
  for (const field of fields) {
    let value = output[field.key] ?? field.default;
    if(field.key==='stt__engine' && value==='')value='deepgram';
    if (value === undefined) continue;
    if (field.type === 'json') {
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw Error(`${field.label} must be valid JSON.`); } }
      if (value === null || typeof value !== 'object') throw Error(`${field.label} must be an object or array.`);
      if (JSON.stringify(value).length > 100000) throw Error(`${field.label} is too large.`);
      if (field.key === 'models__providers' && Array.isArray(value) && value.some(p => Object.keys(p || {}).some(key => /^(apiKey|token|accessToken|password|secret)$/i.test(key))))
        throw Error('Use a provider API-key environment binding or the private credential fields, not inline secrets in provider JSON.');
    } else if (field.type === 'room-notes' && (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(note => typeof note !== 'string'))) throw Error('Room notes must pair room names with text.');
    else if (field.type === 'string-array' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw Error(`${field.label} must contain one text value per line.`);
    else if (field.type === 'select' && !field.options.some(option => option.value === value)) throw Error(`Choose a valid ${field.label.toLowerCase()}.`);
    else if (field.type === 'boolean' && typeof value !== 'boolean') throw Error(`${field.label} must be on or off.`);
    else if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw Error(`${field.label} must be a number.`);
    else if (['text', 'textarea', 'password'].includes(field.type) && typeof value !== 'string') throw Error(`${field.label} must be text.`);
    output[field.key] = value;
  }
  return output;
}
export function registerAssistantServices(registry) {
  const runtime = runtimeFor(registry);
  for (const [id, [name, description, category]] of Object.entries(descriptions)) {
    const fields = sectionFields(id);
    if (id === 'assistant-engine') fields.push(password('openaiKey', 'OpenAI key override (optional)'), password('anthropicKey', 'Anthropic key override (optional)'));
    if (id === 'atlas') fields.push(password('atlasToken', 'Atlas API token'));
    const module = {
      id, name, description, category, version: '1.0.0', icon: 'sparkles', fields,
      dependsOn: id === 'assistant-engine' ? [] : ['assistant-engine'],
      permissions: id === 'assistant-engine' ? ['Coordinate enabled Integrations through their existing guards', 'Retain private execution traces and conversation context'] : [`Use ${name.toLowerCase()} only while enabled`, 'Keep existing selection and authorization requirements'],
      validateConfig: cfg => validateFields(fields, cfg),
      async test() { return runtime.status(); },
      async route({ method, path }) {
        if(method==='GET'&&path==='/audio-devices'&&['voice','speech'].includes(id)){
          let devices=[],warning='';try{devices=await listHostAudio();}catch(e){warning=e.message;}
          const inputs=devices.filter(d=>d.input).map(d=>({value:`local:${d.uid}`,label:d.name}));
          if(registry.store.config.integrations['even-realities']?.enabled)inputs.push({value:'even-glasses',label:'Even glasses (paired companion)'});
          return {inputs,outputs:devices.filter(d=>d.output).map(d=>({value:d.uid,label:d.name})),warning};
        }
        return method === 'GET' && path === '/status' ? runtime.status() : null;
      },
    };
    if (id === 'assistant-engine') Object.assign(module, {
      start: () => runtime.refresh(), stop: () => runtime.close(),
      configurationChanged: () => runtime.refresh(),
      respond: (request) => runtime.respond(request),
      hasConfirmation: id => runtime.confirmations.has(id),
      confirm: (id, accepted, options) => runtime.confirm(id, accepted, options),
      confirmationResolved: (pending, decision, result) => runtime.confirmationResolved(pending, decision, result),
      matchRawRoute: (method, path) => runtime.matchRoute(method, path),
      deviceRoute: (method, path) => runtime.deviceRoute(method, path),
      authorizeDevice: (req, path) => runtime.authorizeDevice(req, path),
      rawRoute: (req, res, parsed) => runtime.proxy(req, res, parsed),
    });
    decorateAssistantIntegration(module);
    registry.register(module);
  }
  for (const id of ['home-assistant', 'apple-tv', 'even-realities']) {
    const module = registry.modules.get(id);
    if (!module) continue;
    module.category = id === 'even-realities' ? 'Voice & display' : 'Home & devices';
    const extra = sectionFields(id).filter(f => !module.fields.some(old => old.key === f.key));
    if (id === 'home-assistant') extra.push(
      { key: 'areaNotes', label: 'Room and landmark context', type: 'json', group: 'Context', default: {}, description: 'Notes by room name. These help Carvis interpret your home and camera images.' },
      { key: 'allowInsecureTls', label: 'Allow a self-signed HA certificate', type: 'boolean', group: 'Connection', default: false },
    );
    module.fields.push(...extra);
    const validate = module.validateConfig;
    module.validateConfig = config => {
      let candidate = config, importedUrl;
      if (id === 'even-realities' && runtime.enabled()) {
        const saved = registry.store.config.integrations[id]?.config;
        const original = registry.store.plugin('assistant-engine').get('originalLegacyConfig', {});
        // An unchanged, explicitly imported companion address must not prevent
        // saving display preferences. New or changed destinations still pass
        // the normal HTTPS validator; this never changes the device endpoint.
        if (config.publicBaseUrl && config.publicBaseUrl === saved?.publicBaseUrl) {
          const url = new URL(config.publicBaseUrl);
          if (url.protocol === 'http:' && url.hostname === original.server?.host && Number(url.port || 80) === Number(original.server?.port)) {
            importedUrl = config.publicBaseUrl;
            const validationUrl = new URL(url); validationUrl.protocol = 'https:';
            candidate = { ...config, publicBaseUrl: validationUrl.toString() };
          }
        }
      }
      return { ...validateFields(extra, config), ...validate(candidate), ...(importedUrl ? { publicBaseUrl: importedUrl } : {}) };
    };
    decorateAssistantIntegration(module);
    if (id === 'home-assistant') {
      const tools = module.tools;
      module.tools = async ctx => (await tools(ctx)).map(tool => {
        if (tool.name !== 'ha_command') return tool;
        const execute = tool.execute;
        return { ...tool, async execute(args, options) {
          const domains = ctx.config.agent__allowedDomains;
          if (Array.isArray(domains) && !domains.includes(args.entity_id?.split('.')[0])) throw Error('This device domain is not permitted in Home Assistant Integration settings.');
          if (runtime.enabled()) return runtime.call('command', { arguments: args, context: { triggerType: 'user_text', reason: options.userText || options.reason || '', confirmed: options.confirmed === true } }, options);
          return execute(args, options);
        } };
      });
    }
  }
  return runtime;
}
