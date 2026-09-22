import { RISK } from './gateway.js';
import { str, COMMAND_PROPERTIES } from './schema.js';
import { isVisibleEntity, unavailableEntity } from './entity-access.js';
import { configureInteraction } from '../hud-interaction.js';
import { Hud } from '../hud.js';

export function buildDisplayTools({ ha, feed, worldState, hud, glassesDisplay, getConfig }) {
  let lastExpressionAt = 0;
  /**
   * `hud.bindWidget` succeeding only means the server recorded what it wants
   * shown — the glasses have to actually fetch and render it before that is
   * true. Attach a caveat whenever they are not currently confirmed live, so
   * "done" is never said on behalf of a device that cannot back it up.
   */
  const glassesCaveat = () => {
    if (!glassesDisplay) return null;
    const state = glassesDisplay.state();
    if (state.connected) return null;
    return state.connection === 'never'
      ? 'The glasses have never reported in — this may not display until they connect.'
      : `The glasses are not currently connected (${state.connection}, last seen ${state.ageMs == null ? 'never' : `${Math.round(state.ageMs / 1000)}s ago`}) — this will not display until they reconnect.`;
  };

  /**
   * Clamp a TTL before it reaches the HUD.
   *
   * The gateway already validates schema bounds; keeping this clamp beside the
   * HUD side effect is defense in depth for direct/internal callers too.
   */
  const ttlSeconds = (value) => {
    if (value === undefined || value === null) return 0;
    const seconds = Math.round(Number(value));
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(seconds, 86_400);
  };

  return [
    /* ── The display ────────────────────────────────────────── */
    {
      name: 'hud.show_notification',
      description:
        "Interrupt the owner's display with something worth their attention now. It takes over the glasses briefly and then the widgets come back. Keep it to a few words.",
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: str('The line itself', 120),
          detail: str('Optional second line', 120),
          seconds: { type: 'integer', minimum: 5, maximum: 120, description: 'How long to show it. Default 20.' },
          proactive: {
            type: 'boolean',
            description: 'True when the owner did not just ask for this. Rate-limited so Carvis is not a notification stream.',
          },
        },
        required: ['text'],
      },
      execute: ({ text, detail, seconds, proactive },ctx={}) => {
        const entry = feed.push('reply', text, { detail: detail || '', proactive: Boolean(proactive),source:ctx.replySource });
        if (!entry) return { success: false, error: 'suppressed — too soon after the last unprompted message' };
        hud.showNotification({ text, detail: detail || '', seconds: seconds || 20 });
        return { success: true, shown: text, seq: entry.seq };
      },
    },

    {
      name: 'hud.get_state',
      description:
        'What is on the four HUD slots right now, which are free, and what kinds of live widget you can bind. Check this before placing one.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: () => {
        const state = hud.state();
        const now = Date.now();
        return {
          success: true,
          ...state,
          // Absolute timestamps are the wrong unit for a model deciding whether
          // something is about to vanish. Derive the number it actually reasons
          // about rather than making it subtract.
          slots: state.slots.map((widget) =>
            widget
              ? {
                  ...widget,
                  expires_in_seconds: widget.expires_at
                    ? Math.max(0, Math.round((widget.expires_at - now) / 1000))
                    : null,
                }
              : null,
          ),
          available_bindings: Hud.bindingCatalogue(),
          glasses_connected: glassesDisplay ? glassesDisplay.state().connected : null,
        };
      },
    },

    {
      name: 'hud.set_lifetime',
      description:
        'Put a time limit on a slot that is already showing something, extend the one it has, or take it off. Use this when the owner asks for something to stay up longer, or once an answer they only needed to glance at has served its purpose. Seconds of 0 removes the limit and makes it permanent.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slot: { type: 'integer', minimum: 1, maximum: 4 },
          ttl_seconds: {
            type: 'integer',
            minimum: 0,
            maximum: 86400,
            description: 'Remove it this many seconds from now. 0 means no limit.',
          },
        },
        required: ['slot', 'ttl_seconds'],
      },
      execute: ({ slot, ttl_seconds }) => {
        const widget = hud.setLifetime(slot, ttlSeconds(ttl_seconds));
        if (!widget) return { success: false, error: `slot ${slot} is empty` };
        const caveat = glassesCaveat();
        return {
          success: true,
          slot: widget.slot,
          expires_in_seconds: widget.expires_at
            ? Math.max(0, Math.round((widget.expires_at - Date.now()) / 1000))
            : null,
          permanent: !widget.expires_at,
          ...(caveat ? { warning: caveat } : {}),
        };
      },
    },

    {
      name:'hud.interactive',risk:RISK.LOW,
      description:'Create a glasses widget with separate display and interactive properties. Layout: 1 top-left, 2 bottom-left, 3 top-right, 4 bottom-right; swipes visit 1,2,3,4. Button press toggles or executes one typed command. Slider press enters adjustment; swipes change a preview and a second press applies. Dropdown works the same with labeled options. Prefer visible title and live entity status; blank display is optional. Preset colors and entity_options are available, or supply custom options (including selected scenes). Creating a widget never executes it; gestures retain guards.',
      schema:{type:'object',additionalProperties:false,properties:{
        slot:{type:'integer',minimum:0,maximum:4},
        display:{type:'object',additionalProperties:false,properties:{title:str('Display label',40),entity_id:str('Selected entity for live feedback'),value:str('Optional fixed display text',60),blank:{type:'boolean'}}},
        interaction:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['button','slider','dropdown']},entity_id:str('Selected control target'),mode:{type:'string',enum:['toggle','action']},command:{type:'object',additionalProperties:false,properties:COMMAND_PROPERTIES,required:['entity_id','service']},field:{type:'string',enum:['brightness_pct','percentage','volume_percent','value']},min:{type:'number'},max:{type:'number'},step:{type:'number'},preset:{type:'string',enum:['colors','entity_options']},options:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,properties:{label:str('Option label',40),command:{type:'object',additionalProperties:false,properties:COMMAND_PROPERTIES,required:['entity_id','service']}},required:['label','command']}}},required:['kind']}
      },required:['interaction']},
      execute:args=>{const binding=configureInteraction(args,getConfig(),ha,{type:'object',additionalProperties:false,properties:COMMAND_PROPERTIES,required:['entity_id','service']});const widget=hud.bindWidget({slot:args.slot,type:'interactive',binding});return {success:true,slot:widget.slot,widget_id:binding._id,display:widget.data,interaction:binding.interaction};},
    },
    {
      name: 'hud.bind_widget',
      description:
        'Put something LIVE on a HUD slot — a value that keeps itself up to date without you being involved again. Any Home Assistant entity available to Carvis can use device_state. Prefer this over set_widget for anything that changes: print time, temperature, a countdown, or music now playing (use device_state with the media_player entity). You are asked once and it stays correct.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: str('One of the binding types from hud.get_state'),
          slot: { type: 'integer', minimum: 0, maximum: 4, description: '1-4, or 0 for the next free slot' },
          printer: str('For printer bindings'),
          area: str('For room bindings'),
          entity_id: str('For device_state'),
          project_id: str('For atlas_task'),
          until: str('For countdown — an ISO timestamp'),
          label: str('For countdown — what to call it'),
          ttl_seconds: { type: 'integer', minimum: 0, maximum: 86400, description: 'Remove it automatically after this long. 0 or absent means no limit.' },
        },
        required: ['type'],
      },
      execute: ({ type, slot, ttl_seconds, ...binding }) => {
        if (type === 'interactive') return {success:false,error:'Use hud.interactive to configure interactive widgets.'};
        if (['device_state', 'camera_image'].includes(type) && !isVisibleEntity(getConfig, binding.entity_id)) {
          return unavailableEntity();
        }
        if (['printer_remaining_time', 'printer_progress', 'printer_status'].includes(type)) {
          const printer = worldState.printer(binding.printer);
          if (!printer) return {success:false, error:'Cannot display printer data: no matching print-status sensor is selected and readable by Carvis. This is a visibility issue, not evidence the printer is offline.'};
          if (type === 'printer_remaining_time' && printer.printing && printer.remaining_minutes == null) {
            return {success:false, error:'Printer is printing, but its remaining-time reading is missing or unavailable to Carvis. No remaining-time widget was created.'};
          }
        }
        const widget = hud.bindWidget({ slot, type, binding, ttlSeconds: ttlSeconds(ttl_seconds) });
        const caveat = glassesCaveat();
        return {
          success: true,
          slot: widget.slot,
          type: widget.type,
          showing: widget.data,
          note: 'This updates itself. Do not call again to refresh it.',
          ...(caveat ? { warning: caveat } : {}),
        };
      },
    },

    {
      name: 'hud.show_camera',
      description:
        'Display a live Home Assistant camera on one HUD slot. The server fetches a fresh still and the glasses refresh it about every five seconds without another model call.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entity_id: str('Exact camera entity id, from ha.find_entities'),
          slot: { type: 'integer', minimum: 0, maximum: 4, description: '1-4, or 0 for next free' },
          ttl_seconds: { type: 'integer', minimum: 0, maximum: 86400 },
        },
        required: ['entity_id'],
      },
      execute: ({ entity_id, slot, ttl_seconds }) => {
        if (!entity_id.startsWith('camera.')) return { success: false, error: 'hud.show_camera requires a camera entity' };
        if (!isVisibleEntity(getConfig, entity_id) || !ha.states.has(entity_id)) return unavailableEntity();
        const widget = hud.bindWidget({
          slot,
          type: 'camera_image',
          binding: { entity_id },
          ttlSeconds: ttlSeconds(ttl_seconds),
        });
        const caveat = glassesCaveat();
        return {
          success: true,
          slot: widget.slot,
          camera: entity_id,
          refresh_seconds: 5,
          note: 'This refreshes itself. Do not call again for each frame.',
          ...(caveat ? { warning: caveat } : {}),
        };
      },
    },

    {
      name: 'hud.express',
      description: 'Brief, silent visual personality aside during a conversation. Fades after four seconds, never replaces a current notification or widget. Use sparingly, never for routine TV buttons or instead of reporting a failure.',
      risk: RISK.LOW,
      schema: {type:'object',additionalProperties:false,properties:{
        mood:{type:'string',enum:['amused','thoughtful','pleased','skeptical']},
        caption:str('Optional understated aside, not a device status claim',60),
      },required:['mood']},
      execute: ({mood,caption},ctx={}) => {
        if (!['user_voice','user_text'].includes(ctx.triggerType)) return {success:false,error:'Expressions are for a live conversation'};
        if (lastExpressionAt && Date.now()-lastExpressionAt < 30000) return {success:true,skipped:true,note:'Keep expressions occasional'};
        if (hud.overlay?.until > Date.now()) return {success:true,skipped:true,note:'An existing notification takes priority'};
        const labels={amused:'Duly amused.',thoughtful:'Considering that.',pleased:'Rather satisfying.',skeptical:'An interesting theory.'};
        hud.showNotification({text:caption || labels[mood],seconds:4});
        lastExpressionAt=Date.now();
        const caveat=glassesCaveat();
        return {success:true,mood,duration_seconds:4,silent:true,...(caveat?{warning:caveat}:{})};
      },
    },
    {
      name: 'hud.set_widget',
      description:
        'Put a fixed piece of text on a HUD slot. Only for something that will not change — for anything live use hud.bind_widget, or you will have to keep coming back to update it.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: str('Small label above the value', 40),
          value: str('The thing to show', 60),
          slot: { type: 'integer', minimum: 0, maximum: 4, description: '1-4, or 0 for the next free slot' },
          ttl_seconds: { type: 'integer', minimum: 0, maximum: 86400 },
        },
        required: ['value'],
      },
      execute: ({ title, value, slot, ttl_seconds }) => {
        const widget = hud.setWidget({ slot, data: { title, value }, ttlSeconds: ttlSeconds(ttl_seconds) });
        const caveat = glassesCaveat();
        return { success: true, slot: widget.slot, showing: widget.data, ...(caveat ? { warning: caveat } : {}) };
      },
    },

    {
      name: 'hud.remove_widget',
      description: 'Clear one HUD slot.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { slot: { type: 'integer', minimum: 1, maximum: 4 } },
        required: ['slot'],
      },
      execute: ({ slot }) =>
        hud.removeWidget(slot)
          ? { success: true, cleared: slot }
          : { success: false, error: `slot ${slot} was already empty` },
    },

    {
      name: 'hud.clear_all',
      description: 'Clear every HUD slot.',
      risk: RISK.LOW,
      schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: () => ({ success: true, cleared: hud.clearAll() }),
    },
  ];
}
