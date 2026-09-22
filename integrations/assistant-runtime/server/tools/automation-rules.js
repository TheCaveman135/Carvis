import { RISK } from './gateway.js';
import { str } from './schema.js';
import { ruleUsesOnlyVisibleEntities, visibleEntityIds } from './entity-access.js';

export function buildAutomationTools({ automations, getConfig }) {
  return [
    /* ── Deterministic automations ───────────────────────────── */
    {
      name: 'automation.create',
      description:
        'Create a persistent protocol (a standing order) from a typed rule program. Use this for anything that should happen later or repeatedly. Rule shape: {version:1,id,name,enabled,when,if?,while?,then,else?,metadata?}. Conditions are {all:[...]}, {any:[...]}, {not:condition}, or {op,left:{ref|literal},right?:{ref|literal},durationMs?,withinMs?}. Actions include tool.call, variable.set, timer.start, timer.cancel, rule.enable, rule.disable, carvis.wake, hud.*, and speech.say. The rule is validated and safety-audited before it is saved.',
      risk: RISK.MEDIUM,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { definition: { type: 'object', additionalProperties: true } },
        required: ['definition'],
      },
      execute: ({ definition }) => {
        if (!automations) return { success: false, error: 'automation engine is unavailable' };
        try {
          const rule = automations.save(definition, { createdBy: 'carvis' });
          return { success: true, rule, note: 'This rule now runs locally without another model call.' };
        } catch (err) {
          return { success: false, error: err.message, validation_errors: err.errors || [] };
        }
      },
    },
    {
      name: 'automation.update',
      description: 'Replace an existing protocol. Pass its current revision so a phone edit cannot overwrite another edit silently.',
      risk: RISK.MEDIUM,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          definition: { type: 'object', additionalProperties: true },
          expected_revision: { type: 'integer', minimum: 1 },
        },
        required: ['definition', 'expected_revision'],
      },
      execute: ({ definition, expected_revision }) => {
        if (!automations) return { success: false, error: 'automation engine is unavailable' };
        try {
          return { success: true, rule: automations.save(definition, { expectedRevision: expected_revision, createdBy: 'carvis' }) };
        } catch (err) {
          return { success: false, error: err.message, validation_errors: err.errors || [], conflict: err.code === 'revision_conflict' };
        }
      },
    },
    {
      name: 'automation.list',
      description: 'List saved protocols, including their block summary and most recent outcome.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: () => {
        const rules = automations?.list() || [];
        // One permission snapshot for this synchronous listing, refreshed on
        // every call so removing an entity takes effect immediately.
        const allowed = visibleEntityIds(getConfig);
        return {
          success: true,
          rules: rules.filter((rule) => ruleUsesOnlyVisibleEntities(rule, getConfig, allowed)),
        };
      },
    },
    {
      name: 'automation.catalog',
      description: 'Discover rule values, operators, actions, automatable tools, or HA entity references before authoring a rule. Results are bounded; use query to narrow them.',
      risk: RISK.READ,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['values', 'operators', 'actions', 'tools', 'entities', 'events', 'locations', 'weather', 'media_players', 'tts'] },
          query: str('Optional id/name/domain search', 120),
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['kind'],
      },
      execute: ({ kind, query = '', limit = 40 }) => {
        if (!automations) return { success: false, error: 'automation engine is unavailable' };
        const catalog = automations.catalog();
        const pools = {
          values: catalog.values,
          operators: catalog.operators,
          actions: catalog.actions,
          tools: catalog.tools.filter((item) => item.automatable),
          entities: catalog.options.entities,
          events: catalog.options.events,
          locations: catalog.options.locations,
          weather: catalog.options.weather,
          media_players: catalog.options.mediaPlayers,
          tts: catalog.options.tts,
        };
        const needle = String(query).trim().toLowerCase();
        const source = pools[kind] || [];
        const matches = needle
          ? source.filter((item) => JSON.stringify(item).toLowerCase().includes(needle))
          : source;
        return { success: true, kind, total: matches.length, items: matches.slice(0, limit) };
      },
    },
    {
      name: 'automation.get',
      description: 'Read one complete protocol before changing it.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: { id: str('rule id') }, required: ['id'] },
      execute: ({ id }) => {
        const rule = automations?.get(id);
        return rule && ruleUsesOnlyVisibleEntities(rule, getConfig)
          ? { success: true, rule }
          : { success: false, error: `no automation ${id}` };
      },
    },
    {
      name: 'automation.enable',
      description: 'Enable a validated protocol.',
      risk: RISK.MEDIUM,
      schema: { type: 'object', additionalProperties: false, properties: { id: str('rule id') }, required: ['id'] },
      execute: ({ id }) => {
        const existing = automations?.get(id);
        if (!existing || !ruleUsesOnlyVisibleEntities(existing, getConfig)) return { success: false, error: `no automation ${id}` };
        const rule = automations?.setEnabled(id, true);
        return rule ? { success: true, rule } : { success: false, error: `no automation ${id}` };
      },
    },
    {
      name: 'automation.disable',
      description: 'Pause a protocol without deleting its definition or history.',
      risk: RISK.LOW,
      schema: { type: 'object', additionalProperties: false, properties: { id: str('rule id') }, required: ['id'] },
      execute: ({ id }) => {
        const existing = automations?.get(id);
        if (!existing || !ruleUsesOnlyVisibleEntities(existing, getConfig)) return { success: false, error: `no automation ${id}` };
        const rule = automations?.setEnabled(id, false);
        return rule ? { success: true, rule } : { success: false, error: `no automation ${id}` };
      },
    },
    {
      name: 'automation.test',
      description: 'Validate and preview a protocol against live values. This never executes its actions.',
      risk: RISK.READ,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          definition: { type: 'object', additionalProperties: true },
          values: { type: 'object', additionalProperties: true },
          event: { type: 'object', additionalProperties: true },
          change: { type: 'object', additionalProperties: true },
          at: str('Optional ISO timestamp used by the preview clock', 80),
        },
        required: ['definition'],
      },
      execute: ({ definition, values, event, change, at }) => {
        const preview = automations?.test(definition, { values, event, change, at });
        return { success: preview?.ok !== false, preview, ...(preview?.ok === false ? { error: 'protocol did not validate or evaluate' } : {}) };
      },
    },
  ];
}
