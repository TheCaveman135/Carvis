import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTools, macBoundaryError } from '../server/tools/index.js';
import { validate } from '../server/tools/gateway.js';
import { vetAction } from '../server/guards.js';
import { applyHaCommand } from '../server/tools/home-assistant.js';

test('Mac delegation cannot route around Home Assistant guards', () => {
  const ownerText = { triggerType: 'user_text' };
  assert.match(macBoundaryError('unlock the front door in Home Assistant', '', ownerText), /cannot control Home Assistant/);
  assert.match(macBoundaryError('edit config.json', 'raise Carvis risk limits', ownerText), /cannot edit/);
  assert.match(macBoundaryError('run the shortcut that opens the front door', '', ownerText), /cannot control Home Assistant|cannot run shortcuts/);
  assert.match(macBoundaryError('open CPAP settings', '', ownerText), /wellbeing equipment/);
  assert.match(macBoundaryError('open Fusion 360', '', { triggerType: 'automation' }), /live owner request/);
  assert.match(macBoundaryError('open Fusion 360', '', { triggerType: 'user_voice', wakeWord: false }), /leading Carvis wake word/);
  assert.equal(macBoundaryError('open Fusion 360', 'load the bracket model', ownerText), null);
});

test('tool schema validation enforces bounds and unique array items', () => {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      precision: { type: 'integer', minimum: 0, maximum: 12 },
      days: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string' } },
    },
    required: ['precision', 'days'],
  };
  assert.equal(validate({ precision: 0, days: ['monday'] }, schema).ok, true);
  assert.match(validate({ precision: -1, days: ['monday'] }, schema).error, /at least 0/);
  assert.match(validate({ precision: 13, days: ['monday'] }, schema).error, /at most 12/);
  assert.match(validate({ precision: 1, days: [] }, schema).error, /at least 1 items/);
  assert.match(validate({ precision: 1, days: ['monday', 'monday'] }, schema).error, /duplicate/);
});

test('Carvis tool reads cannot reveal unselected Home Assistant entities', () => {
  const states = new Map([
    ['light.selected', { entity_id: 'light.selected', state: 'on', attributes: { friendly_name: 'Selected light' }, last_changed: new Date().toISOString() }],
    ['lock.hidden_deadbolt', { entity_id: 'lock.hidden_deadbolt', state: 'locked', attributes: { friendly_name: 'Hidden deadbolt' }, last_changed: new Date().toISOString() }],
  ]);
  const tools = buildTools({
    ha: {
      states,
      friendlyName: (id) => states.get(id)?.attributes?.friendly_name || id,
      areaNameFor: () => 'Test',
      listEntities: () => [...states.values()].map((state) => ({ entity_id: state.entity_id, domain: state.entity_id.split('.')[0], name: state.attributes.friendly_name, area: 'Test', state: state.state })),
    },
    getConfig: () => ({ entities: { observed: ['light.selected'], controlled: ['light.selected'] } }),
  });
  const getState = tools.find((tool) => tool.name === 'ha.get_state');
  const find = tools.find((tool) => tool.name === 'ha.find_entities');

  assert.equal(getState.execute({ entity_id: 'light.selected' }).success, true);
  const hidden = getState.execute({ entity_id: 'lock.hidden_deadbolt' });
  assert.deepEqual(hidden, { success: false, error: 'that entity is not available to Carvis' });
  assert.deepEqual(find.execute({ query: 'hidden' }).entities, []);
  assert.deepEqual(find.execute({ domain: 'lock' }).entities, []);
});

test('malformed entity selection cannot authorize reads through a string substring match', () => {
  const tools = buildTools({
    ha: {
      states: new Map([['light.selected', { state: 'on', attributes: {}, last_changed: new Date().toISOString() }]]),
      friendlyName: () => 'Selected light',
      areaNameFor: () => 'Test',
    },
    getConfig: () => ({ entities: { observed: 'light.selected', controlled: 'light.selected' } }),
  });
  assert.deepEqual(tools.find((tool) => tool.name === 'ha.get_state').execute({ entity_id: 'light.selected' }), {
    success: false, error: 'that entity is not available to Carvis',
  });
});

test('automation listings share one permission snapshot and honor revocation on the next call', () => {
  let reads = 0;
  const config = { entities: { observed: ['light.selected'], controlled: [] } };
  const selected = {
    id: 'selected',
    when: { all: Array.from({ length: 100 }, () => ({ left: { ref: 'ha.light.selected.state' } })) },
    then: [{ arguments: { entity_id: 'light.selected' } }],
  };
  const hidden = { id: 'hidden', then: [{ payload: { media_player: 'media_player.hidden' } }] };
  const tools = buildTools({
    getConfig: () => { reads += 1; return config; },
    automations: { list: () => [selected, hidden] },
  });
  const list = tools.find((tool) => tool.name === 'automation.list');
  reads = 0;
  assert.deepEqual(list.execute().rules, [selected]);
  assert.equal(reads, 1, 'permission work is bounded independently of rule/reference count');

  config.entities.observed.length = 0;
  assert.deepEqual(list.execute().rules, []);
  assert.equal(reads, 2, 'permission snapshots are never retained between calls');
});

test('speech is pinned to Carvis’s configured speaker', async () => {
  const states = new Map([
    ['media_player.carvis_speaker', { entity_id: 'media_player.carvis_speaker', state: 'idle', attributes: { friendly_name: 'Carvis Speaker' } }],
    ['media_player.other_room', { entity_id: 'media_player.other_room', state: 'idle', attributes: { friendly_name: 'Other Room' } }],
    ['tts.openai_tts', { entity_id: 'tts.openai_tts', state: 'ready', attributes: {} }],
  ]);
  const calls = [];
  const tools = buildTools({
    ha: {
      states,
      listEntities: () => [...states.values()].map((state) => ({ entity_id: state.entity_id, domain: state.entity_id.split('.')[0], name: state.attributes.friendly_name || state.entity_id, area: 'Test', state: state.state })),
      callService: async (domain, service, data) => calls.push({ domain, service, data }),
    },
    getConfig: () => ({
      entities: { observed: ['media_player.carvis_speaker'], controlled: ['media_player.carvis_speaker'] },
      speech: { mediaPlayer: 'media_player.carvis_speaker', ttsEntity: 'tts.openai_tts' },
    }),
  });
  const say = tools.find((tool) => tool.name === 'speech.say');
  const result = await say.execute({ text: 'Testing' });
  assert.equal(result.success, true);
  assert.equal(result.media_player, 'media_player.carvis_speaker');
  assert.deepEqual(calls[0].data.media_player_entity_id, 'media_player.carvis_speaker');
  const redirected = await say.execute({ text: 'Testing', media_player: 'media_player.other_room' });
  assert.equal(redirected.success, false);
  assert.match(redirected.error, /pinned/);
});

test('protected HA entities are routed through the sensitive command tool', async () => {
  const states = new Map([
    ['switch.desk_lamp', { entity_id: 'switch.desk_lamp', state: 'off', attributes: { friendly_name: 'Desk Lamp' } }],
    ['switch.space_heater', { entity_id: 'switch.space_heater', state: 'off', attributes: { friendly_name: 'Space Heater' } }],
    ['script.open_everything', { entity_id: 'script.open_everything', state: 'off', attributes: {} }],
  ]);
  const executed = [];
  const tools = buildTools({
    ha: {
      states,
      friendlyName: (id) => id,
      listEntities: () => [...states.values()],
    },
    agent: {
      executeVoiceActions: async (actions) => {
        executed.push(...actions);
        return { executed: actions.map((action) => ({ ...action, dryRun: true })), rejected: [] };
      },
      getConfig: () => ({ atlas: {} }),
    },
    getConfig: () => ({ entities: { observed: [...states.keys()], controlled: [...states.keys()] } }),
  });
  const byName = (name) => tools.find((tool) => tool.name === name);

  assert.equal((await byName('ha.entity.command').execute(
    { entity_id: 'switch.desk_lamp', service: 'turn_on' },
    { triggerType: 'user_text' },
  )).success, true);

  for (const entity_id of ['switch.space_heater', 'script.open_everything']) {
    const ordinary = await byName('ha.entity.command').execute(
      { entity_id, service: 'turn_on' },
      { triggerType: 'user_text', confirmed: true },
    );
    assert.equal(ordinary.success, false);
    assert.match(ordinary.error, /must use ha\.secure\.command/);

    const protectedResult = await byName('ha.secure.command').execute(
      { entity_id, service: 'turn_on' },
      { triggerType: 'user_text', confirmed: true },
    );
    assert.equal(protectedResult.success, true);
  }
  assert.equal(executed.length, 3);
});

test('light effect discovery searches only that light and the typed setter keeps the exact result', async () => {
  const states = new Map([
    ['light.desk_lamp', { entity_id: 'light.desk_lamp', state: 'on', attributes: { friendly_name: 'Desk Lamp', effect: 'Aurora', effect_list: ['Aurora', 'Fire', 'Firefly'] } }],
  ]);
  const executed = [];
  const tools = buildTools({
    ha: { states, friendlyName: (id) => states.get(id)?.attributes?.friendly_name || id, listEntities: () => [...states.values()] },
    agent: {
      executeVoiceActions: async (actions) => {
        executed.push(...actions);
        return { executed: actions.map((action) => ({ ...action, dryRun: true })), rejected: [] };
      },
      getConfig: () => ({ atlas: {} }),
    },
    getConfig: () => ({ entities: { observed: [...states.keys()], controlled: [...states.keys()] } }),
  });
  const effects = tools.find((tool) => tool.name === 'ha.light.list_effects');
  const setEffect = tools.find((tool) => tool.name === 'ha.light.set_effect');
  const found = effects.execute({ entity_id: 'light.desk_lamp', query: 'fire' });
  assert.deepEqual(found.matches, ['Fire', 'Firefly']);
  const result = await setEffect.execute({ entity_id: 'light.desk_lamp', effect: 'Fire' }, { triggerType: 'user_text' });
  assert.equal(result.success, true);
  assert.deepEqual(executed[0], {
    entity_id: 'light.desk_lamp', service: 'turn_on', effect: 'Fire', reason: 'owner request',
  });
});

test('lock commands wait for Home Assistant state confirmation before reporting success', async () => {
  const states = new Map([
    ['lock.front_door', { entity_id: 'lock.front_door', state: 'unlocked', attributes: { friendly_name: 'Front Door' } }],
  ]);
  const waits = [];
  const tools = buildTools({
    ha: {
      states,
      friendlyName: (id) => states.get(id)?.attributes?.friendly_name || id,
      listEntities: () => [...states.values()],
      waitForState: async (entityId, expected, options) => {
        waits.push({ entityId, expected, options });
        const state = { ...states.get(entityId), state: expected };
        states.set(entityId, state);
        return state;
      },
    },
    agent: {
      executeVoiceActions: async (actions) => ({ executed: actions.map((action) => ({ ...action, dryRun: false })), rejected: [] }),
      getConfig: () => ({ atlas: {} }),
    },
    getConfig: () => ({ entities: { observed: [...states.keys()], controlled: [...states.keys()] } }),
  });
  const secure = tools.find((tool) => tool.name === 'ha.secure.command');
  const success = await secure.execute(
    { entity_id: 'lock.front_door', service: 'lock' },
    { triggerType: 'user_text', confirmed: true },
  );
  assert.equal(success.success, true);
  assert.deepEqual(waits, [{ entityId: 'lock.front_door', expected: 'locked', options: { timeoutMs: 15_000 } }]);

  states.set('lock.front_door', { ...states.get('lock.front_door'), state: 'unlocked' });
  const failedTools = buildTools({
    ha: {
      states,
      friendlyName: (id) => states.get(id)?.attributes?.friendly_name || id,
      listEntities: () => [...states.values()],
      waitForState: async () => states.get('lock.front_door'),
    },
    agent: {
      executeVoiceActions: async (actions) => ({ executed: actions.map((action) => ({ ...action, dryRun: false })), rejected: [] }),
      getConfig: () => ({ atlas: {} }),
    },
    getConfig: () => ({ entities: { observed: [...states.keys()], controlled: [...states.keys()] } }),
  });
  const unconfirmed = await failedTools.find((tool) => tool.name === 'ha.secure.command').execute(
    { entity_id: 'lock.front_door', service: 'lock' },
    { triggerType: 'user_text', confirmed: true },
  );
  assert.equal(unconfirmed.success, false);
  assert.equal(unconfirmed.pending, true);
  assert.equal(unconfirmed.actual_state, 'unlocked');
  assert.match(unconfirmed.error, /not confirmed/);
});

test('alarm.create applies weekly day selection to its first occurrence', () => {
  let started;
  const automations = {
    startTimer(input) { started = input; return { id: 'alarm_test', ...input }; },
  };
  const tools = buildTools({
    automations,
    ha: { states: new Map(), listEntities: () => [] },
    atlas: {}, mac: {}, feed: {}, worldState: {}, hud: {}, glassesDisplay: {}, memory: {},
    agent: {}, getConfig: () => ({ entities: { controlled: [] } }),
  });
  const alarm = tools.find((tool) => tool.name === 'alarm.create');
  const result = alarm.execute({
    name: 'Monday planning',
    at: '2026-08-14 09:00', // Friday
    time_zone: 'America/Chicago',
    repeat: 'weekly',
    days: ['monday'],
    speak: false,
  });
  assert.equal(result.success, true);
  assert.equal(new Date(started.dueAt).toISOString(), '2026-08-17T14:00:00.000Z');
  assert.deepEqual(started.payload.schedule.days, ['monday']);
});

test('media playback maps exact commands through the existing execution guard', async () => {
 const id='media_player.spotify'; const calls=[];
 const state={state:'playing',attributes:{media_title:'Song',media_artist:'Artist',source:'Speaker',source_list:['Speaker']}};
 const tools=buildTools({ha:{states:new Map([[id,state]]),friendlyName:()=> 'Spotify'},getConfig:()=>({entities:{observed:[id],controlled:[id]}}),agent:{executeVoiceActions:async(actions,ctx)=>{calls.push({actions,ctx});return {executed:actions,rejected:[]};}}});
 const tool=tools.find(t=>t.name==='ha.media.control'); const ctx={triggerType:'user_text'};
 for(const action of ['play','pause','stop']) { assert.equal((await tool.execute({entity_id:id,action},ctx)).success,true); assert.equal(calls.at(-1).actions[0].service,'media_'+action);assert.equal(calls.at(-1).ctx,ctx); }
 assert.equal((await tool.execute({entity_id:'media_player.hidden',action:'play'},ctx)).success,false);
 state.state='idle';state.attributes.supported_features=2048;
 assert.match((await tool.execute({entity_id:id,action:'play'},ctx)).error,/No active playback device/);
 assert.equal(calls.length,3);
});

test('music tool forwards skip, source, and playlist arguments through guarded execution', async () => {
 const id='media_player.spotify';const calls=[];
 const tools=buildTools({ha:{states:new Map([[id,{state:'playing',attributes:{}}]]),friendlyName:()=> 'Spotify'},getConfig:()=>({entities:{observed:[id],controlled:[id]}}),agent:{executeVoiceActions:async(actions)=>{calls.push(actions[0]);return {executed:actions,rejected:[]};}}});
 const tool=tools.find(t=>t.name==='ha.media.control');
 for(const [action,service] of [['next','media_next_track'],['previous','media_previous_track'],['select_source','select_source'],['play_media','play_media']]) {
 const args={entity_id:id,action,source:'Echo Dot',media_content_id:'spotify:playlist:5xddIVAtLrZKtt4YGLM1SQ',media_content_type:'playlist'};
 assert.equal(validate(args,tool.schema).ok,true);assert.equal((await tool.execute(args,{})).success,true);assert.equal(calls.at(-1).service,service);
 if(action==='select_source')assert.equal(calls.at(-1).source,'Echo Dot');
 if(action==='play_media')assert.equal(calls.at(-1).media_content_id,args.media_content_id);
 }
});

test('light tool forwards color and white settings alongside brightness',async()=>{
 const actions=[];const tool=buildTools({getConfig:()=>({entities:{observed:['light.test'],controlled:['light.test']}}),worldState:{resolveTarget:()=>['light.test']},ha:{friendlyName:id=>id},agent:{executeVoiceActions:async list=>{actions.push(...list);return {executed:list,rejected:[]};}}}).find(t=>t.name==='ha.light.set');
 const args={target:'light.test',state:'on',rgb_color:[1,2,3],brightness:42};assert.equal(validate(args,tool.schema).ok,true);assert.equal((await tool.execute(args,{})).success,true);assert.deepEqual(actions[0].rgb_color,[1,2,3]);assert.equal(actions[0].brightness_pct,42);
 assert.equal((await tool.execute({...args,state:'off'},{})).success,false);
});

test('mixed-room white requests include color-only lights and report each limitation', async () => {
  const states = new Map([
    ['light.native', { state: 'on', attributes: { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 } }],
    ['light.color', { state: 'on', attributes: { supported_color_modes: ['xy'] } }],
    ['light.fixed', { state: 'on', attributes: { supported_color_modes: ['brightness'] } }],
  ]);
  const cfg = { entities: { controlled: [...states.keys()] }, agent: { allowedDomains: ['light'], cooldownSec: 0, respectManualOverrideSec: 0 } };
  const ha = { states, friendlyName: id => id };
  const agent = { executeVoiceActions: async actions => {
    const executed = [], rejected = [];
    for (const action of actions) {
      const result = vetAction(action, { cfg, ha, now: Date.now(), origin: 'voice', triggerType: 'user_voice', cooldown: new Map(), manualTouch: new Map() });
      if (result.ok) executed.push(result.action);
      else rejected.push(result);
    }
    return { executed, rejected };
  } };
  const tool = buildTools({ ha, agent, getConfig: () => cfg, worldState: { resolveTarget: () => [...states.keys()] } }).find(t => t.name === 'ha.light.set');
  const result = await tool.execute({ target: 'Room', state: 'on', color_temp_kelvin: 4000 }, {});
  assert.deepEqual(result.changed.map(a => a.entity_id), ['light.native', 'light.color']);
  assert.equal(result.changed[0].white_tone, undefined);
  assert.equal(result.changed[1].white_tone.approximate, true);
  assert.equal(result.blocked[0].entity_id, 'light.fixed');
  assert.match(result.blocked[0].reason, /cannot change its white tone/);
  const single = await applyHaCommand({ ha, agent }, { entity_id: 'light.color', service: 'turn_on', color_temp_kelvin: 4000 }, {});
  assert.equal(single.white_tone.approximate, true);
});

test('TV power uses turn_on/turn_off with no playback or lighting arguments',async()=>{
 const id='media_player.apple_tv',calls=[];const tool=buildTools({getConfig:()=>({entities:{controlled:[id],observed:[id]}}),ha:{states:new Map([[id,{state:'off'}]]),friendlyName:()=> 'Apple TV'},agent:{executeVoiceActions:async actions=>{calls.push(...actions);return {executed:actions,rejected:[]};}}}).find(t=>t.name==='ha.media.power');
 for(const state of ['on','off']){assert.equal((await tool.execute({entity_id:id,state},{})).success,true);assert.deepEqual(Object.keys(calls.at(-1)).sort(),['entity_id','reason','service']);assert.equal(calls.at(-1).service,'turn_'+state);}
});

test('Apple TV navigation sends exactly one typed button and reports acceptance only', async () => {
 const id='media_player.apple_tv', calls=[];
 const tool=buildTools({getConfig:()=>({appleTv:{mediaPlayer:id,remoteEntity:'remote.apple_tv'},entities:{controlled:[id]},agent:{allowedDomains:['media_player'],dryRun:false}}),ha:{states:new Map([[id,{state:'on'}]]),appleTv:{command:async(domain,service,data)=>{calls.push({domain,service,data});return {status:'completed'};}}},agent:{}}).find(t=>t.name==='ha.media.navigate');
 assert.equal(tool.risk,3);
 const result=await tool.execute({entity_id:id,button:'left'},{wakeWord:true,triggerType:'user_voice'});
 assert.equal(result.success,true);assert.equal(result.verified,false);
 assert.equal(calls[0].data.command,'left');
 assert.equal(calls[0].service,'send_command');
 assert.equal(calls[0].data.entity_id,'remote.apple_tv');
 assert.equal((await tool.execute({entity_id:id,button:'suspend'},{})).success,false);
 assert.equal(calls.length,1);
});
