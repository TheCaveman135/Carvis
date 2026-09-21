import test from 'node:test';
import assert from 'node:assert/strict';

import { requiresLiveOwner, requiresOwnerConfirmation, vetAction } from '../server/guards.js';

function context(entityId, state = 'locked', attributes = {}, overrides = {}) {
  return {
    cfg: {
      appleTv: {remoteEntity:'remote.apple_tv'},
      entities: { controlled: [entityId] },
      agent: {
        allowedDomains: [entityId.split('.')[0]],
        cooldownSec: 0,
        respectManualOverrideSec: 0,
        enforceOccupancyEnvelope: false,
      },
    },
    ha: { states: new Map([[entityId, { state, attributes }]]) },
    cooldown: new Map(),
    manualTouch: new Map(),
    now: Date.now(),
    origin: 'voice',
    triggerType: 'user_voice',
    wakeWord: true,
    ...overrides,
  };
}

test('unlock requires a live wake-word-addressed owner turn', () => {
  const entityId = 'lock.front_door';
  const action = { entity_id: entityId, service: 'unlock', reason: 'Carvis, unlock the front door' };

  assert.equal(vetAction(action, context(entityId, 'locked', {}, { triggerType: 'home_event', origin: 'automation' })).ok, false);
  assert.match(
    vetAction(action, context(entityId, 'locked', {}, { wakeWord: false })).reason,
    /wake word/,
  );
  assert.equal(vetAction(action, context(entityId)).ok, true);
});

test('locking a selected deadbolt is protective, but still never background automation', () => {
  const entityId = 'lock.front_door';
  const action = { entity_id: entityId, service: 'lock', reason: 'lock the front door' };

  assert.equal(requiresLiveOwner(entityId, { attributes: {} }), true);
  assert.equal(requiresOwnerConfirmation(entityId, { attributes: {} }, 'lock'), false);
  assert.equal(requiresOwnerConfirmation(entityId, { attributes: {} }, 'unlock'), true);

  assert.equal(vetAction(action, context(entityId, 'unlocked', {}, {
    triggerType: 'user_voice', wakeWord: false, confirmed: false,
  })).ok, true, 'a direct owner can lock without an extra security ritual');
  const background = vetAction(action, context(entityId, 'unlocked', {}, {
    triggerType: 'automation', origin: 'automation', wakeWord: false, confirmed: false,
  }));
  assert.equal(background.ok, false, 'a model wake still cannot change any protected lock state');
  assert.match(background.reason, /live owner request/);
});

test('an explicit swipe confirmation is an accepted alternate to the wake word', () => {
  const entityId = 'lock.front_door';
  const action = { entity_id: entityId, service: 'unlock', reason: 'Carvis, unlock the front door' };

  // No wake word, no confirmation: denied, same as always.
  assert.match(
    vetAction(action, context(entityId, 'locked', {}, { wakeWord: false })).reason,
    /wake word/,
  );
  // No wake word, but an owner-accepted swipe: now allowed. This is the new
  // capability — a Critical command used to have no path through without the
  // wake word at all.
  assert.equal(
    vetAction(action, context(entityId, 'locked', {}, { wakeWord: false, confirmed: true })).ok,
    true,
  );
});

test('typed protected controls require confirmation and cannot borrow wake-word authorization', () => {
  const entityId = 'lock.front_door';
  const action = { entity_id: entityId, service: 'unlock', reason: 'unlock the front door' };

  const unconfirmed = vetAction(action, context(entityId, 'locked', {}, {
    triggerType: 'user_text',
    wakeWord: true,
    confirmed: false,
  }));
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.reason, /confirm/);

  const confirmed = vetAction(action, context(entityId, 'locked', {}, {
    triggerType: 'user_text',
    wakeWord: false,
    confirmed: true,
  }));
  assert.equal(confirmed.ok, true);
});

test('opaque HA helpers are authenticated live-owner actions and never background actions', () => {
  for (const [entityId, state, service] of [
    ['scene.goodnight', 'scening', 'turn_on'],
    ['script.open_house', 'off', 'turn_on'],
    ['automation.arrival', 'on', 'trigger'],
    ['button.do_everything', 'unknown', 'press'],
    ['input_button.do_everything', 'unknown', 'press'],
    ['remote.living_room', 'off', 'turn_on'],
  ]) {
    const action = { entity_id: entityId, service, reason: `owner requested ${service}` };
    const background = vetAction(action, context(entityId, state, {}, {
      triggerType: 'home_event',
      origin: 'automation',
      wakeWord: false,
    }));
    assert.equal(background.ok, false, `${entityId} must be unavailable to background model wakes`);
    assert.match(background.reason, /live owner request/);

    const typed = vetAction(action, context(entityId, state, {}, {
      triggerType: 'user_text',
      wakeWord: true,
      confirmed: false,
    }));
    assert.equal(typed.ok, false, `${entityId} must not treat typed text as a wake word`);
    assert.match(typed.reason, /confirm/);

    const confirmed = vetAction(action, context(entityId, state, {}, {
      triggerType: 'user_text',
      wakeWord: false,
      confirmed: true,
    }));
    assert.equal(confirmed.ok, true, `${entityId} should work after exact owner confirmation`);
  }
});

test('a live voice request uses wake word OR confirmation for protected controls', () => {
  const entityId = 'scene.goodnight';
  const action = { entity_id: entityId, service: 'turn_on', reason: 'run the goodnight scene' };

  assert.equal(vetAction(action, context(entityId, 'scening', {}, { wakeWord: true, confirmed: false })).ok, true);
  assert.equal(vetAction(action, context(entityId, 'scening', {}, { wakeWord: false, confirmed: true })).ok, true);
  assert.equal(vetAction(action, context(entityId, 'scening', {}, { wakeWord: false, confirmed: false })).ok, false);
});

test('wellbeing-looking ordinary entities use the same confirmation boundary', () => {
  const entityId = 'switch.bedroom_heater';
  const action = { entity_id: entityId, service: 'turn_on', reason: 'turn on the bedroom heater' };

  assert.equal(requiresOwnerConfirmation(entityId, { attributes: {} }), true);
  assert.equal(vetAction(action, context(entityId, 'off', {}, { triggerType: 'user_text', wakeWord: true })).ok, false);
  assert.equal(vetAction(action, context(entityId, 'off', {}, { triggerType: 'user_text', confirmed: true })).ok, true);

  const ordinary = 'switch.desk_lamp';
  assert.equal(requiresOwnerConfirmation(ordinary, { attributes: { friendly_name: 'Desk Lamp' } }), false);
  assert.equal(vetAction(
    { entity_id: ordinary, service: 'turn_on', reason: 'turn on the desk lamp' },
    context(ordinary, 'off', { friendly_name: 'Desk Lamp' }, { triggerType: 'user_text', wakeWord: false, confirmed: false }),
  ).ok, true);
});

test('a lock query cannot become an actuation through model confusion', () => {
  const entityId = 'lock.front_door';
  const result = vetAction(
    { entity_id: entityId, service: 'unlock', reason: 'Carvis, is the front door locked?' },
    context(entityId),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not explicitly request/);
});

test('environmental limits are hard-coded beneath the model', () => {
  const entityId = 'climate.bedroom';
  const ctx = context(entityId, 'heat', { temperature_unit: '°F' });

  assert.match(
    vetAction({ entity_id: entityId, service: 'set_temperature', temperature: 45, reason: 'set it to 45' }, ctx).reason,
    /60 and 86/,
  );
  const invented = vetAction(
    { entity_id: entityId, service: 'set_temperature', temperature: 68, reason: 'Carvis, make it warmer' },
    ctx,
  );
  assert.equal(invented.ok, false);
  assert.match(invented.reason, /did not explicitly request the numeric target/);

  const allowed = vetAction(
    { entity_id: entityId, service: 'set_temperature', temperature: 68, reason: 'Carvis, set it to 68 degrees' },
    ctx,
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.action.service_data.temperature, 68);
});

test('hazard-like switches cannot be changed by a background wake', () => {
  const entityId = 'switch.space_heater';
  const action = { entity_id: entityId, service: 'turn_on' };
  const denied = vetAction(
    action,
    context(entityId, 'off', { friendly_name: 'Space heater' }, { triggerType: 'home_event', origin: 'automation' }),
  );
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /wellbeing guard/);
});

test('selection remains a mandatory control boundary', () => {
  const entityId = 'lock.front_door';
  const ctx = context(entityId);
  ctx.cfg.entities.controlled = [];
  assert.match(vetAction({ entity_id: entityId, service: 'unlock', reason: 'unlock the front door' }, ctx).reason, /controllable list/);
});

test('select commands must use an option the entity actually exposes', () => {
  const entityId = 'select.air_mode';
  const ctx = context(entityId, 'auto', { options: ['auto', 'quiet'] });
  assert.equal(vetAction({ entity_id: entityId, service: 'select_option', option: 'turbo' }, ctx).ok, false);
  const allowed = vetAction({ entity_id: entityId, service: 'select_option', option: 'quiet' }, ctx);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.action.service_data.option, 'quiet');
});

test('light effects must be exact live capabilities, including when the lamp is already on', () => {
  const entityId = 'light.desk_lamp';
  const ctx = context(entityId, 'on', { effect: 'Aurora', effect_list: ['Aurora', 'Fire'] });
  const allowed = vetAction({ entity_id: entityId, service: 'turn_on', effect: 'Fire' }, ctx);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.action.service_data.effect, 'Fire');
  assert.equal(vetAction({ entity_id: entityId, service: 'turn_on', effect: 'fire' }, ctx).ok, false);
  assert.match(vetAction({ entity_id: entityId, service: 'turn_on', effect: 'Fireworks' }, ctx).reason, /not available/);
  assert.match(vetAction({ entity_id: entityId, service: 'turn_on', effect: 'Aurora' }, ctx).reason, /already using/);
});

test('music services preserve entity allowlists and validate exact devices and Spotify identifiers', () => {
 const id='media_player.spotify';const ctx=context(id,'playing',{source_list:['Echo Dot']});
 const check=(service,fields={})=>vetAction({entity_id:id,service,reason:'play music',...fields},ctx);
 for(const service of ['media_next_track','media_previous_track']) assert.equal(check(service).ok,true);
 assert.deepEqual(check('select_source',{source:'Echo Dot'}).action.service_data,{source:'Echo Dot'});
 assert.equal(check('select_source',{source:'Unknown'}).ok,false);
 const media_content_id='https://open.spotify.com/playlist/5xddIVAtLrZKtt4YGLM1SQ?si=example';
 assert.deepEqual(check('play_media',{media_content_id,media_content_type:'playlist'}).action.service_data,{media_content_id:'spotify:playlist:5xddIVAtLrZKtt4YGLM1SQ',media_content_type:'playlist'});
 for(const invalid of ['http://127.0.0.1/admin','https://open.spotify.com.evil.test/playlist/5xddIVAtLrZKtt4YGLM1SQ','spotify:playlist:madeup']) assert.equal(check('play_media',{media_content_id:invalid,media_content_type:'playlist'}).ok,false);
 assert.equal(check('play_media',{media_content_id,media_content_type:'track'}).ok,false);
 assert.equal(vetAction({entity_id:'media_player.hidden',service:'media_next_track'},ctx).ok,false);
 assert.equal(vetAction({entity_id:'lock.front_door',service:'play_media'},context('lock.front_door')).ok,false);
});

test('light locations are ordinary, while actual hazards remain protected',()=>{
 assert.equal(requiresLiveOwner('light.stove',{attributes:{friendly_name:'Stove'}}),false);
 assert.equal(requiresLiveOwner('switch.stove',{attributes:{}}),true);
 assert.equal(requiresLiveOwner('light.heater',{attributes:{}}),true);
});
test('already-on lights accept brightness and supported color adjustments',()=>{
 const id='light.stove',ctx=context(id,'on',{supported_color_modes:['rgb','color_temp'],min_color_temp_kelvin:2702,max_color_temp_kelvin:6535},{wakeWord:false});
 const run=fields=>vetAction({entity_id:id,service:'turn_on',reason:'change the stove light',...fields},ctx);
 assert.equal(run({brightness_pct:40}).ok,true);assert.deepEqual(run({rgb_color:[255,0,0]}).action.service_data.rgb_color,[255,0,0]);
 assert.equal(run({color_temp_kelvin:3000}).ok,true);assert.equal(run({color_temp_kelvin:1000}).ok,false);assert.equal(run({rgb_color:[999,0,0]}).ok,false);
 ctx.ha.states.get(id).attributes.supported_color_modes=['onoff'];assert.equal(run({rgb_color:[255,0,0]}).ok,false);assert.equal(run({brightness_pct:40}).ok,false);
});
test('custom guard modes override automatic device classification',()=>{
 const id='light.desk',ctx=context(id,'off',{}, {wakeWord:false});ctx.cfg.entities.guards={[id]:'protected'};
 const action={entity_id:id,service:'turn_on',reason:'turn on desk light'};
 assert.equal(vetAction(action,ctx).ok,false);ctx.confirmed=true;assert.equal(vetAction(action,ctx).ok,true);
 ctx.triggerType='home_event';assert.equal(vetAction(action,ctx).ok,false);
 assert.equal(requiresLiveOwner('lock.door',{},{entities:{guards:{'lock.door':'standard'}}}),false);
});

test('explicit protected mode also requires confirmation for protective locking',()=>{
 const id='lock.door';assert.equal(requiresOwnerConfirmation(id,{},'lock'),false);assert.equal(requiresOwnerConfirmation(id,{},'lock',{entities:{guards:{[id]:'protected'}}}),true);
});

test('keeping a light effect does not block a simultaneous brightness change',()=>{
 const id='light.lamp',ctx=context(id,'on',{supported_color_modes:['rgb'],effect:'Rainbow',effect_list:['Rainbow']});
 assert.equal(vetAction({entity_id:id,service:'turn_on',effect:'Rainbow',brightness_pct:30},ctx).ok,true);
 assert.equal(vetAction({entity_id:id,service:'turn_on',effect:'Rainbow'},ctx).ok,false);
});

test('Apple TV navigation is bounded and retains remote authorization', () => {
  const id = 'remote.apple_tv';
  const action = {entity_id:id,service:'send_command',command:'left'};
  const accepted = vetAction(action,context(id,'on'));
  assert.equal(accepted.ok,true);
  assert.deepEqual(accepted.action.service_data,{command:'left'});
  assert.equal(vetAction(action,context(id,'on',{}, {wakeWord:false})).ok,false);
  assert.equal(vetAction(action,context(id,'on',{}, {triggerType:'automation',origin:'automation'})).ok,false);
  for (const command of ['suspend','launch_app',['left','select'],'arbitrary']) {
    assert.equal(vetAction({...action,command},context(id,'on')).ok,false);
  }
  assert.equal(vetAction({...action,entity_id:'remote.other'},context('remote.other','on')).ok,false);
  const unselected=context(id,'on');unselected.cfg.entities.controlled=[];
  assert.equal(vetAction(action,unselected).ok,false);
});

test('Standard overrides remote protection while selection and button validation remain enforced', () => {
 const id='remote.apple_tv',ctx=context(id,'on',{}, {wakeWord:false});
 const action={entity_id:id,service:'send_command',command:'left'};
 assert.equal(vetAction(action,ctx).ok,false);
 ctx.cfg.entities.guards={[id]:'standard'};
 assert.equal(vetAction(action,ctx).ok,true);
 assert.equal(requiresOwnerConfirmation(id,{},'send_command',ctx.cfg),false);
 assert.equal(vetAction({...action,command:'anything'},ctx).ok,false);
 ctx.cfg.entities.controlled=[];
 assert.equal(vetAction(action,ctx).ok,false);
});

 test('custom Apple TV remote retains the same selection and button guard',()=>{
  const id='remote.streaming_box',ctx=context(id,'on');ctx.cfg.appleTv.remoteEntity=id;
  const action={entity_id:id,service:'send_command',command:'select'};
  assert.equal(vetAction(action,ctx).ok,true);
  assert.equal(vetAction({...action,command:'arbitrary'},ctx).ok,false);
  ctx.cfg.appleTv.remoteEntity='';assert.equal(vetAction(action,ctx).ok,false);
 });
