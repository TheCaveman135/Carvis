import { RISK } from './gateway.js';
import { str, COMMAND_PROPERTIES } from './schema.js';
import { isVisibleEntity, visibleEntities, unavailableEntity } from './entity-access.js';
import { APPLE_TV_BUTTONS, requiresLiveOwner, vetAction } from '../guards.js';

export function buildHomeAssistantTools({ ha, agent, worldState, getConfig }) {
  return [
    /* ── Home Assistant ─────────────────────────────────────── */
    {
      name: 'ha.get_state',
      description:
        'Read the current state of one Home Assistant entity. Use this instead of assuming what a device is doing.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { entity_id: str('Full entity id, e.g. light.kitchen_underglow') },
        required: ['entity_id'],
      },
      execute: ({ entity_id }) => {
        if (!isVisibleEntity(getConfig, entity_id)) return unavailableEntity();
        const state = ha.states.get(entity_id);
        if (!state) return unavailableEntity();
        return {
          success: true,
          entity_id,
          name: ha.friendlyName(entity_id),
          area: ha.areaNameFor(entity_id),
          state: state.state,
          guard: requiresLiveOwner(entity_id, state, getConfig()) ? 'protected: use ha.secure.command' : 'standard',
          attributes: pickAttributes(state.attributes),
          // Freshness, per the spec: the model must be able to tell live state
          // from something that has not moved in a day.
          updated_at: state.last_changed,
          age_seconds: Math.round((Date.now() - Date.parse(state.last_changed)) / 1000),
        };
      },
    },

    {
      name: 'ha.get_area_state',
      description:
        'Everything Carvis can see in one room: presence, lights, and other devices, with how long each has been that way.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { area: str('Room name, e.g. Bedroom, Kitchen, workspace') },
        required: ['area'],
      },
      execute: ({ area }) => {
        const snapshot = worldState.area(area);
        if (!snapshot) {
          return { success: false, error: `no area "${area}". Known areas: ${worldState.areaNames().join(', ')}` };
        }
        return { success: true, ...snapshot };
      },
    },

    {
      name: 'ha.find_entities',
      description:
        'Find Home Assistant entities the owner made available to Carvis, by spoken name, entity id, room, or domain. Use it before guessing an entity id or binding one to the HUD.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: str('Words from the owner, e.g. living room camera. Empty lists by area/domain.', 120),
          area: str('Optional exact or partial room name', 80),
          domain: str('Optional HA domain, e.g. camera, lock, sensor', 60),
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: [],
      },
      execute: ({ query = '', area = '', domain = '', limit = 20 }) => {
        const needle = query.toLowerCase().trim();
        const room = area.toLowerCase().trim();
        const wantedDomain = domain.toLowerCase().trim();
        const matches = visibleEntities(ha, getConfig).filter((entity) => {
          if (wantedDomain && entity.domain !== wantedDomain) return false;
          if (room && !entity.area.toLowerCase().includes(room)) return false;
          if (!needle) return true;
          return `${entity.name} ${entity.entity_id} ${entity.area} ${entity.domain}`.toLowerCase().includes(needle);
        });
        return { success: true, entities: matches.slice(0, limit), total: matches.length };
      },
    },

    {
      name: 'ha.light.set',
      description:
        'Turn lights on or off, change brightness, RGB color, or white temperature. For settings use state on, even if already on. Read ha.get_state for supported color modes and Kelvin limits. Target a whole room by name or one entity id. A spoken request may switch lights on in an empty room — the safety layer knows the request came from the owner.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: str('A room name, or a single light entity id'),
          state: { type: 'string', enum: ['on', 'off'], description: 'What the lights should end up as' },
          rgb_color: COMMAND_PROPERTIES.rgb_color,
          color_temp_kelvin: COMMAND_PROPERTIES.color_temp_kelvin,
          brightness: { type: 'integer', minimum: 1, maximum: 100, description: 'Percent. Only when turning on.' },
        },
        required: ['target', 'state'],
      },
      execute: async ({ target, state, brightness, rgb_color, color_temp_kelvin }, ctx) =>
        applyHa({ ha, agent, worldState }, { target, state, brightness, rgb_color, color_temp_kelvin, domains: ['light'], ctx }),
    },

    {
      name: 'ha.light.list_effects',
      description:
        'Search the live effect/scenes built into one light. Use this before setting a named lamp scene such as Fire, Aurora, or Rainbow. Pass query from the owner wording; it returns exact selectable effect names for that one light. This is not for whole Home Assistant scenes.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entity_id: str('Exact light entity id'),
          query: str('Optional effect-name search, e.g. fire', 120),
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['entity_id'],
      },
      execute: ({ entity_id, query = '', limit = 30 }) => {
        if (!isVisibleEntity(getConfig, entity_id)) return unavailableEntity();
        const state = ha.states.get(entity_id);
        if (!state) return unavailableEntity();
        if (!entity_id.startsWith('light.')) return { success: false, error: `${entity_id} is not a light` };
        const effects = Array.isArray(state.attributes?.effect_list)
          ? state.attributes.effect_list.filter((effect) => String(effect).trim())
          : [];
        if (!effects.length) return { success: false, error: `${ha.friendlyName(entity_id)} does not expose selectable effects` };
        const needle = effectSearchText(query);
        const matches = needle ? effects.filter((effect) => effectSearchText(effect).includes(needle)) : effects;
        return {
          success: true,
          entity_id,
          name: ha.friendlyName(entity_id),
          current_effect: state.attributes?.effect || null,
          total: effects.length,
          matches: matches.slice(0, limit),
          ...(matches.length > limit ? { note: `Showing ${limit} of ${matches.length}; search with a narrower query.` } : {}),
        };
      },
    },

    {
      name: 'ha.light.set_effect',
      description:
        'Set one selected light to an exact, live-verified effect returned by ha.light.list_effects. This calls light.turn_on with that effect, so it also turns the lamp on when needed. Never guess an effect name or substitute a similarly named one.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entity_id: str('Exact selected light entity id'),
          effect: str('Exact effect name from ha.light.list_effects', 160),
        },
        required: ['entity_id', 'effect'],
      },
      execute: ({ entity_id, effect }, ctx) =>
        isVisibleEntity(getConfig, entity_id)
          ? applyHaCommand({ ha, agent }, { entity_id, service: 'turn_on', effect }, ctx)
          : unavailableEntity(),
    },

    {
      name: 'ha.switch.set',
      description: 'Turn a switch, fan, or plug on or off. Target a room name or one entity id.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: str('A room name, or a single switch/fan entity id'),
          state: { type: 'string', enum: ['on', 'off'] },
        },
        required: ['target', 'state'],
      },
      execute: async ({ target, state }, ctx) =>
        applyHa({ ha, agent, worldState }, { target, state, domains: ['switch', 'fan', 'input_boolean'], ctx }),
    },

    {
      name: 'ha.scene.activate',
      description: 'Activate a Home Assistant scene by entity id.',
      risk: RISK.SENSITIVE,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { entity_id: str('Scene entity id, e.g. scene.evening') },
        required: ['entity_id'],
      },
      execute: async ({ entity_id }, ctx) =>
        applyHa({ ha, agent, worldState }, { target: entity_id, state: 'on', domains: ['scene'], ctx }),
    },

    {
      name: 'ha.media.navigate', available:()=>isVisibleEntity(getConfig,getConfig().appleTv?.mediaPlayer),
      description: 'Send one exact Apple TV button to Apple TV AI. Use for explicit button requests only; use ha.apple_tv.task for visual navigation, finding content or complex goals. Resolve short follow-ups from recent TV context. menu is back; top_menu is home; select is enter. The selected TV’s guards apply; the controller owns its remote connection. Never retry an accepted press.',
      risk: RISK.SENSITIVE,
      schema: { type:'object', additionalProperties:false, properties:{ entity_id:{type:'string',enum:[getConfig().appleTv?.mediaPlayer]}, button:{type:'string',enum:APPLE_TV_BUTTONS} }, required:['entity_id','button'] },
      execute: async ({entity_id,button},ctx) => {
        if (entity_id===getConfig().appleTv?.remoteEntity) entity_id=getConfig().appleTv?.mediaPlayer; // legacy callers; never exposed in the schema
        if (!isVisibleEntity(getConfig,entity_id)) return unavailableEntity();
        if (entity_id !== getConfig().appleTv?.mediaPlayer || !APPLE_TV_BUTTONS.includes(button)) return {success:false,error:'Unsupported Apple TV navigation button'};
        const cfg=getConfig();
        const vet=vetAction({entity_id,service:'media_pause',reason:ctx.reason || 'TV navigation'},{cfg,ha,origin:'voice',triggerType:ctx.triggerType,wakeWord:ctx.wakeWord===true,confirmed:ctx.confirmed===true,now:Date.now(),cooldown:agent.cooldown,manualTouch:agent.manualTouch});
        if(!vet.ok)return {success:false,entity_id,error:vet.reason};
        if(cfg.agent.dryRun)return {success:true,entity_id,dry_run:true};
        const delivery=await ha.appleTv.command('remote','send_command',{entity_id:getConfig().appleTv?.remoteEntity,command:button});
        const result={success:true,entity_id,controller:delivery};
        return {...result,button,...(result.success && !result.dry_run ? {verified:false,note:'Apple TV AI delivered the button; this exact-button command does not inspect the screen.'} : {})};
      },
    },

    {
      name:'ha.apple_tv.task',available:()=>isVisibleEntity(getConfig,getConfig().appleTv?.mediaPlayer), risk:RISK.SENSITIVE,
      description:'Delegate the entire Apple TV goal to Apple TV AI, which sees HDMI capture and uses GPT Luna to navigate, launch apps, search, type, and verify results. Use one task for complex TV requests rather than issuing individual remote calls. Returns running, NOT done; completion arrives separately. Purchases and account changes remain blocked for manual attention. Do not start another task or send buttons while running. Use ha.apple_tv.context for owner corrections without restarting.',
      schema:{type:'object',additionalProperties:false,properties:{goal:str('Complete owner-requested TV goal, including relevant conversation context',2000)},required:['goal']},
      execute:async({goal},ctx)=>{
        const cfg=getConfig();
        if(!['user_voice','user_text'].includes(ctx?.triggerType))return {success:false,error:'Apple TV visual tasks require a live owner request.'};
        for(const action of [{entity_id:getConfig().appleTv?.mediaPlayer,service:'media_pause'}]){
          const vet=vetAction({...action,reason:ctx.reason || goal},{cfg,ha,origin:'voice',triggerType:ctx.triggerType,wakeWord:ctx.wakeWord===true,confirmed:ctx.confirmed===true,now:Date.now(),cooldown:agent.cooldown,manualTouch:agent.manualTouch});
          if(!vet.ok)return {success:false,error:vet.reason};
        }
        if(cfg.agent.dryRun)return {success:true,dry_run:true,note:'Dry run: no Apple TV task was sent.'};
        if(!ha.appleTv)return {success:false,error:'Apple TV AI is not connected.'};
        return ha.appleTv.start(goal,ctx);
      },
    },
    {
      name:'ha.apple_tv.context',available:()=>isVisibleEntity(getConfig,getConfig().appleTv?.mediaPlayer),risk:RISK.SENSITIVE,
      description:'Add an owner correction or extra context to the running TV task WITHOUT restarting it. Use for “it is on Netflix, not Prime”, “the other version”, or additional requirements. First get the current task ID from status if needed. The next controller decision applies it; a command already sent cannot be recalled. A completed task cannot receive updates.',
      schema:{type:'object',additionalProperties:false,properties:{id:str('Running task ID from status/start',80),context:str('Relevant owner correction or new context, preserving the original objective',2000)},required:['id','context']},
      execute:async({id,context},ctx)=>{
        const cfg=getConfig();
        if(!['user_voice','user_text'].includes(ctx?.triggerType))return {success:false,error:'TV context updates require a live owner request.'};
        const vet=vetAction({entity_id:getConfig().appleTv?.mediaPlayer,service:'media_pause',reason:ctx.reason || context},{cfg,ha,origin:'voice',triggerType:ctx.triggerType,wakeWord:ctx.wakeWord===true,confirmed:ctx.confirmed===true,now:Date.now(),cooldown:agent.cooldown,manualTouch:agent.manualTouch});
        if(!vet.ok)return {success:false,error:vet.reason};
        if(cfg.agent.dryRun)return {success:true,dry_run:true};
        return ha.appleTv.addContext(id,context,ctx);
      },
    },
    {
      name:'ha.apple_tv.status',available:()=>isVisibleEntity(getConfig,getConfig().appleTv?.mediaPlayer),risk:RISK.READ,
      description:'Read the stored Apple TV AI task progress or a specific task ID. This does NOT capture a fresh screen or prove current playback. If the owner contradicts a completed task, send a corrective task rather than repeating the old success claim.',
      schema:{type:'object',additionalProperties:false,properties:{id:str('Optional task ID',80)}},
      execute:async({id})=>{
        if(!isVisibleEntity(getConfig,getConfig().appleTv?.mediaPlayer))return unavailableEntity();
        const run=await ha.appleTv.status(id);
        return {success:true,source:'apple_tv_ai',id:run.id,status:run.status,goal:run.goal,message:run.message,steps:run.steps,cost_usd:run.cost_usd,model:run.model,context_revision:run.context_revision || 0,applied_context_revision:run.applied_context_revision || 0,latest_observation:run.events?.at(-1)?.observation || '',latest_action:run.events?.at(-1)?.action || '',finished_at:run.finished_at || null,live_observation:false,completion_verified:run.completion_check?.confirmed===true,completion_check:run.completion_check || null,note:'Historical task report, not a fresh screen inspection. Owner corrections require rechecking.'};
      },
    },
    {
      name:'ha.apple_tv.stop',available:()=>isVisibleEntity(getConfig,getConfig().appleTv?.mediaPlayer),risk:RISK.LOW,
      description:'Stop one Apple TV AI task by its ID from status/start. Already accepted device actions cannot be undone.',
      schema:{type:'object',additionalProperties:false,properties:{id:str('Exact task ID',80)},required:['id']},
      execute:async({id},ctx)=>{
        if(!isVisibleEntity(getConfig,getConfig().appleTv?.mediaPlayer))return unavailableEntity();
        if(!['user_voice','user_text'].includes(ctx?.triggerType))return {success:false,error:'Stopping a TV task requires a live owner request.'};
        if(getConfig().agent.dryRun)return {success:true,dry_run:true};
        return ha.appleTv.stop(id);
      },
    },
    {
      name: 'ha.media.power',
      description: 'Turn a selected TV or media player ON or OFF. Use this for wake/power requests such as turn on Apple TV. Play/pause are playback commands, not power commands. Verify current state after waking.',
      risk: RISK.LOW,
      schema: {type:'object',additionalProperties:false,properties:{entity_id:str('Exact selected media_player entity'),state:{type:'string',enum:['on','off']}},required:['entity_id','state']},
      execute: async ({entity_id,state},ctx) => {
        if (!isVisibleEntity(getConfig,entity_id)) return unavailableEntity();
        if (!entity_id.startsWith('media_player.')) return {success:false,error:'Expected a media player'};
        const result = await applyHaCommand({ha,agent},{entity_id,service:state === 'on' ? 'turn_on' : 'turn_off'},ctx);
        if (!result.success || result.dry_run || typeof ha.waitForState !== 'function') return result;
        const expected = state === 'on' ? ['on','idle','playing','paused','buffering'] : ['off','standby'];
        const observed = await ha.waitForState(entity_id,expected,{timeoutMs:10000});
        const actual = observed?.state || ha.states.get(entity_id)?.state || 'unknown';
        return expected.includes(actual) ? {...result,actual_state:actual,verified:true} : {...result,success:false,pending:true,actual_state:actual,error:'Power command accepted, but Home Assistant has not confirmed the new state. Do not substitute playback for power or immediately retry.'};
      },
    },

    {
      name: 'ha.media.control',
      description: 'Control music playback, NOT device power (use ha.media.power to turn on/off a TV): play resumes, pause/stop halt, next/previous skip tracks, select_source chooses an exact source from ha.get_state, play_media starts a Spotify track/album/playlist/artist link. Read source_list before selecting a device. Select a device before starting Spotify when none is active. Obtain a real Spotify link from the user or search; never invent IDs. Song-name search is not built in.',
      risk: RISK.LOW,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entity_id: str('Media player entity id'),
          action: { type: 'string', enum: ['play', 'pause', 'stop', 'next', 'previous', 'select_source', 'play_media'] },
          source: COMMAND_PROPERTIES.source,
          media_content_id: COMMAND_PROPERTIES.media_content_id,
          media_content_type: COMMAND_PROPERTIES.media_content_type,
        },
        required: ['entity_id', 'action'],
      },
      execute: async ({ entity_id, action, source, media_content_id, media_content_type }, ctx) => {
        if (!isVisibleEntity(getConfig, entity_id)) return unavailableEntity();
        if (!entity_id.startsWith('media_player.')) return { success: false, error: 'Expected a media_player entity' };
        const service = { play: 'media_play', pause: 'media_pause', stop: 'media_stop', next: 'media_next_track', previous: 'media_previous_track', select_source: 'select_source', play_media: 'play_media' }[action];
        if (!service) return { success: false, error: 'Unknown playback action' };
        const state = ha.states.get(entity_id);
        if (!state || ['unavailable', 'unknown'].includes(state.state)) return { success: false, error: 'This media player is unavailable in Home Assistant' };
        // An idle Spotify account with SELECT_SOURCE only has no active player.
        // Explain the prerequisite rather than submitting a doomed resume call.
        if (action === 'play' && state.state === 'idle' && state.attributes?.supported_features === 2048 && Array.isArray(state.attributes.source_list)) {
          return { success: false, error: 'No active playback device. Use ha.get_state to list devices, ask which output the owner wants if unclear, then select_source before resuming.', sources: state.attributes.source_list };
        }
        return applyHaCommand({ ha, agent }, { entity_id, service, ...(action === 'select_source' ? { source } : {}), ...(action === 'play_media' ? { media_content_id, media_content_type } : {}) }, ctx);
      },
    },

    {
      name: 'ha.entity.command',
      description:
        'Control one selected, transparent Home Assistant entity with a typed command. Covers ordinary lights, switches, fans, media, numbers, selects, and vacuums. Security/environment devices, wellbeing-looking entities, and opaque scenes/scripts/automations/buttons/remotes must use ha.secure.command instead.',
      risk: RISK.MEDIUM,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: COMMAND_PROPERTIES,
        required: ['entity_id', 'service'],
      },
      execute: async (args, ctx) => {
        if (!isVisibleEntity(getConfig, args.entity_id)) return unavailableEntity();
        const domain = args.entity_id.split('.')[0];
        const state = ha.states.get(args.entity_id);
        if (requiresLiveOwner(args.entity_id, state, getConfig())) {
          return {
            success: false,
            error: `${domain} is a protected security, wellbeing, or indirect Home Assistant control and must use ha.secure.command`,
          };
        }
        return applyHaCommand({ ha, agent }, args, ctx);
      },
    },

    {
      name: 'ha.secure.command',
      description:
        'Control one selected protected Home Assistant entity: a lock, cover/garage, alarm, siren, valve, water heater, climate device, wellbeing-looking entity, or opaque scene/script/automation/button/remote. Use only for an authenticated live owner request. Voice needs an exact Carvis wake word OR an accepted confirmation; typed text always needs an accepted confirmation. Background events and scheduled wakes can never use this.',
      risk: RISK.SENSITIVE,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: COMMAND_PROPERTIES,
        required: ['entity_id', 'service'],
      },
      execute: async (args, ctx) => {
        if (!isVisibleEntity(getConfig, args.entity_id)) return unavailableEntity();
        const domain = args.entity_id.split('.')[0];
        const state = ha.states.get(args.entity_id);
        if (!requiresLiveOwner(args.entity_id, state, getConfig())) {
          return { success: false, error: `${domain} should use ha.entity.command` };
        }
        return applyHaCommand({ ha, agent }, args, ctx);
      },
    },

    {
      name: 'ha.printer.get_status',
      description:
        'Current state of a 3D printer: whether it is printing, how far along, and how long is left. Use this rather than guessing from an earlier answer.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { printer: str('Printer name, e.g. p2s. Omit for the first one found.') },
        required: [],
      },
      execute: ({ printer }) => {
        const found = worldState.printer(printer);
        if (!found) return { success: false, error: 'No matching print-status sensor is selected and readable by Carvis. This does not mean the printer is offline. Ask the owner to select its print-status and remaining-time sensors for observation.' };
        return { success: true, ...found };
      },
    },
  ];
}

/** Attributes worth showing a model. The rest is noise that costs tokens. */
function pickAttributes(attributes = {}) {
  const keep = [
    'brightness', 'supported_color_modes', 'color_mode', 'rgb_color', 'hs_color', 'color_temp_kelvin', 'min_color_temp_kelvin', 'max_color_temp_kelvin', 'current_temperature', 'temperature', 'temperature_unit', 'humidity',
    'percentage', 'media_title', 'media_artist', 'media_album_name', 'media_duration',
    'media_position', 'media_position_updated_at', 'source', 'source_list', 'supported_features',
    'shuffle', 'repeat', 'is_volume_muted', 'volume_level', 'unit_of_measurement', 'min', 'max',
    'step', 'options', 'device_class', 'effect',
  ];
  const out = {};
  for (const key of keep) if (attributes[key] !== undefined) out[key] = attributes[key];
  return out;
}

/** Normalise only for searching; the write guard still requires HA's exact name. */
function effectSearchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Resolve a target to entities and push them through the guard layer.
 *
 * Every Home Assistant write funnels here so that the guards see all of them.
 * The gateway said Carvis may act; the guards still get to say the entity is
 * not on the controllable list, or is already off, or is a lock.
 */
async function applyHa({ ha, agent, worldState }, { target, state, brightness, rgb_color, color_temp_kelvin, domains, ctx }) {
  if (state !== 'on' && [brightness,rgb_color,color_temp_kelvin].some(v => v !== undefined)) return {success:false,error:'Use state on to change light settings'};
  const entities = worldState.resolveTarget(target, domains);
  if (!entities.length) {
    return {
      success: false,
      error: `nothing controllable matching "${target}" in ${domains.join('/')}. Known areas: ${worldState.areaNames().join(', ')}`,
    };
  }

  const service = state === 'on' ? 'turn_on' : 'turn_off';
  const actions = entities.map((entity_id) => ({
    entity_id,
    service,
    ...(brightness !== undefined && state === 'on' ? { brightness_pct: brightness } : {}),
    ...(rgb_color !== undefined ? {rgb_color} : {}),
    ...(color_temp_kelvin !== undefined ? {color_temp_kelvin} : {}),
    reason: ctx?.reason || 'spoken request',
  }));

  const { executed, rejected } = await agent.executeVoiceActions(actions, ctx || {});

  // Report what actually happened per entity. "success: true" with three of
  // four lights blocked would be a lie the model repeats to the owner.
  return {
    success: executed.length > 0,
    changed: executed.map((a) => ({
      entity_id: a.entity_id,
      name: ha.friendlyName(a.entity_id),
      service: a.service,
      dry_run: Boolean(a.dryRun),
      ...(a.white_tone ? { white_tone: a.white_tone } : {}),
    })),
    blocked: rejected.map((r) => ({ entity_id: r.entity_id, name: ha.friendlyName(r.entity_id), reason: r.reason })),
    ...(executed.length === 0
      ? { error: `nothing changed: ${rejected.map((r) => r.reason).join('; ') || 'no applicable entities'}` }
      : {}),
    ...(executed.some((a) => a.dryRun) ? { note: 'Dry run is on — nothing was actually sent to Home Assistant.' } : {}),
  };
}

/** One exact typed command, still routed through the same deterministic guard. */
export async function applyHaCommand({ ha, agent }, args, ctx) {
  const state = ha.states.get(args.entity_id);
  if (!state) return { success: false, error: `no entity ${args.entity_id}` };

  const action = {
    ...args,
    reason: ctx?.reason || 'owner request',
  };
  const { executed, rejected } = await agent.executeVoiceActions([action], ctx || {});
  if (!executed.length) {
    return {
      success: false,
      error: rejected[0]?.reason || 'command blocked',
      blocked: rejected,
    };
  }
  const changed = executed[0];

  // HA's service endpoint acknowledges receipt, not the completed physical
  // result.  Locks in particular can take a few seconds to report their new
  // state.  Do not tell the owner a door is locked/unlocked until the
  // authoritative HA state confirms it.
  const expectedState = expectedStateForCommand(changed);
  if (expectedState && !changed.dryRun && typeof ha.waitForState === 'function') {
    // Z-Wave / battery lock reports can legitimately take several seconds;
    // 15s is deliberately patient rather than falsely calling a finished
    // physical command an error at the eight-second mark.
    const confirmationTimeoutMs = 15_000;
    const confirmed = await ha.waitForState(changed.entity_id, expectedState, { timeoutMs: confirmationTimeoutMs });
    if (!confirmed || confirmed.state !== expectedState) {
      const actual = confirmed?.state || ha.states.get(changed.entity_id)?.state || 'unknown';
      return {
        success: false,
        pending: true,
        entity_id: changed.entity_id,
        name: ha.friendlyName(changed.entity_id),
        service: changed.service,
        actual_state: actual,
        error: `Home Assistant accepted ${changed.service}, but ${ha.friendlyName(changed.entity_id)} still reports ${actual} after ${Math.round(confirmationTimeoutMs / 1_000)} seconds. The result was not confirmed.`,
      };
    }
  }
  return {
    success: true,
    entity_id: changed.entity_id,
    name: ha.friendlyName(changed.entity_id),
    service: changed.service,
    dry_run: Boolean(changed.dryRun),
    ...(changed.white_tone ? { white_tone: changed.white_tone } : {}),
    ...(changed.controller ? {controller:changed.controller} : {}),
    ...(changed.dryRun ? { note: 'Dry run is on — nothing was sent to Home Assistant.' } : {}),
  };
}

/** State transitions whose physical outcome can be stated without guessing. */
function expectedStateForCommand({ entity_id, service }) {
  const domain = String(entity_id || '').split('.')[0];
  if (domain !== 'lock') return null;
  if (service === 'lock') return 'locked';
  if (service === 'unlock') return 'unlocked';
  return null;
}
