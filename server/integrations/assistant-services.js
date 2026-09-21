import { SECTION_OWNERS, sectionFields } from '../assistant-config.js';
import { runtimeFor } from '../assistant-runtime.js';

const descriptions = {
  'assistant-engine': ['Assistant engine', 'Conversation, fast commands, model roles, detailed execution traces, and coordination of your enabled Integrations.', 'Intelligence & routines'],
  voice: ['Voice conversation', 'Speech recognition, contextual follow-ups, acknowledgements, and live voice chat.', 'Voice & display'],
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
const workspaceTabs = { 'assistant-engine': 'carvis', voice: 'transcript', speech: 'settings', protocols: 'automations', proactivity: 'behavior', 'learned-memory': 'behavior', cameras: 'carvis', 'web-search': 'settings', atlas: 'settings', desktop: 'settings', 'physical-carvis': 'settings', 'home-assistant': 'entities', 'apple-tv': 'carvis', 'even-realities': 'carvis' };
const password = (key, label, group = 'Credentials') => ({ key, label, type: 'password', group, description: 'Stored privately. Leave blank to keep the current value.' });
function validateFields(fields, input = {}) {
  const output = { ...input };
  for (const field of fields) {
    let value = output[field.key] ?? field.default;
    if (value === undefined) continue;
    if (field.type === 'json') {
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw Error(`${field.label} must be valid JSON.`); } }
      if (value === null || typeof value !== 'object') throw Error(`${field.label} must be an object or array.`);
      if (JSON.stringify(value).length > 100000) throw Error(`${field.label} is too large.`);
      if (field.key === 'models__providers' && Array.isArray(value) && value.some(p => Object.keys(p || {}).some(key => /^(apiKey|token|accessToken|password|secret)$/i.test(key))))
        throw Error('Use a provider API-key environment binding or the private credential fields, not inline secrets in provider JSON.');
    } else if (field.type === 'boolean' && typeof value !== 'boolean') throw Error(`${field.label} must be on or off.`);
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
    if (id === 'assistant-engine') fields.push(password('openaiKey', 'OpenAI API key'), password('anthropicKey', 'Anthropic API key'));
    if (id === 'atlas') fields.push(password('atlasToken', 'Atlas API token'));
    const module = {
      id, name, description, category, version: '1.0.0', icon: 'sparkles', fields,
      dependsOn: id === 'assistant-engine' ? [] : ['assistant-engine'],
      workspaceUrl: `/integrations/assistant-engine/#${workspaceTabs[id]}`,
      permissions: id === 'assistant-engine' ? ['Coordinate enabled Integrations through their existing guards', 'Retain private execution traces and conversation context'] : [`Use ${name.toLowerCase()} only while enabled`, 'Keep existing selection and authorization requirements'],
      validateConfig: cfg => validateFields(fields, cfg),
      async test() { return runtime.status(); },
      async route({ method, path }) { return method === 'GET' && path === '/status' ? runtime.status() : null; },
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
    registry.register(module);
  }
  for (const id of ['home-assistant', 'apple-tv', 'even-realities']) {
    const module = registry.modules.get(id);
    if (!module) continue;
    module.category = id === 'even-realities' ? 'Voice & display' : 'Home & devices';
    module.workspaceUrl = `/integrations/assistant-engine/#${workspaceTabs[id]}`;
    module.workspaceDependsOn = ['assistant-engine'];
    const extra = sectionFields(id).filter(f => !module.fields.some(old => old.key === f.key));
    if (id === 'home-assistant') extra.push(
      { key: 'areaNotes', label: 'Room and landmark context', type: 'json', group: 'Context', default: {}, description: 'Notes by room name. These help Carvis interpret your home and camera images.' },
      { key: 'allowInsecureTls', label: 'Allow a self-signed HA certificate', type: 'boolean', group: 'Connection', default: false },
    );
    module.fields.push(...extra);
    const validate = module.validateConfig;
    module.validateConfig = config => ({ ...validateFields(extra, config), ...validate(config) });
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
