import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Voice,
  classifyRiskTier,
  confirmationDecision,
  confirmationPrompt,
  isObservationRequest,
  leadingWake,
} from '../server/voice.js';

function testVoice() {
  const invocations = [];
  const feed = [];
  const config = {
    voice: {
      enabled: true,
      requireWakeWord: false,
      wakeWords: ['carvis', 'carvus'],
      minChars: 3,
      dedupeWindowSec: 0,
      confirmWithoutWakeWord: true,
      confirmationTimeoutSec: 120,
      implicitIntents: false,
    },
  };
  const gatewayCalls = [];
  const carvis = {
    async invoke(request) {
      invocations.push(request);
      return { outcome: 'done', reply: 'Done.', calls: [], ms: 1, costUsd: 0 };
    },
    state() {
      return { turns: 0 };
    },
    // Only the dashboard/direct confirmation path reaches this — it resolves
    // by re-calling the gateway with the exact command a click already knew,
    // never by re-invoking Carvis's model loop.
    gateway: {
      async call(name, args, ctx) {
        gatewayCalls.push({ name, args, ctx });
        return { success: true, entity_id: args.entity_id, name: args.entity_id, service: args.service };
      },
    },
  };
  const persisted = [];
  const deletedTranscriptCalls = [];
  const confirmationChanges = [];
  const voice = new Voice({
    getConfig: () => config,
    carvis,
    atlas: { snapshot: { projects: [] } },
    feed: { push: (...args) => feed.push(args) },
    // Never the real one: db.js has no path override, so the default would
    // write fixtures into the owner's live transcript corpus.
    persistTranscript: (entry) => persisted.push(entry),
    deleteAllTranscripts: () => deletedTranscriptCalls.push(Date.now()),
    onConfirmationChange: (confirmation) => confirmationChanges.push(confirmation),
    // Never a real model binding either: Standard/Digital's no-wake-word
    // path always consults triage now (it's their only remaining safety net
    // for "was this actually addressed to Carvis" once the swipe requirement
    // was dropped for those two tiers), and this fixture has no models
    // config to satisfy it. Every test utterance here reads as a plain
    // addressed command, matching what a real triage call on these sentences
    // would say.
    complete: async () => ({
      json: { addressed: true, project_relevant: false, implicit_intent: false, category: 'home' },
    }),
  });
  return { voice, invocations, feed, config, carvis, persisted, gatewayCalls, deletedTranscriptCalls, confirmationChanges };
}

test('Live conversation uses ordinary typed-request authorization and keeps protected confirmations',async()=>{
 const h=testVoice();
 const blocked=await h.voice.request('unlock the front door',{source:'live'});
 assert.equal(blocked.outcome,'confirmation');assert.equal(h.invocations.length,0);
 const allowed=await h.voice.request('what is the printer status?',{source:'live'});
 assert.equal(allowed.outcome,'acted');assert.equal(h.invocations.at(-1).trigger.type,'user_text');
 assert.equal(h.invocations.at(-1).trigger.wake_word,false);assert.equal(h.invocations.at(-1).trigger.confirmed,false);
});

test('living-room camera commands become a glanceable G2 confirmation', () => {
  assert.equal(
    confirmationPrompt('Put the Living Room camera on my HUD.'),
    'Move LR cam to HUD?',
  );
});

test('the 3-class risk tier is guessed from the words, Critical winning any overlap', () => {
  for (const spoken of ['unlock the front door', 'unlatch the deadbolt', 'arm the alarm', 'start the car', 'set the thermostat to 68', 'run the movie night scene', 'press the button', 'turn off my CPAP']) {
    assert.equal(classifyRiskTier(spoken), 'critical', `"${spoken}" should be critical`);
  }
  for (const spoken of ['turn on the lights', 'turn on the fan', 'play music', 'lock the front door']) {
    assert.equal(classifyRiskTier(spoken), 'standard', `"${spoken}" should be standard`);
  }
  for (const spoken of ['put the Living Room camera on my HUD', 'what is the weather', 'search for pizza recipes', 'is the deadbolt locked?', 'watch the door and tell me when it unlocks']) {
    assert.equal(classifyRiskTier(spoken), 'digital', `"${spoken}" should be digital`);
  }
});

test('watching and status questions are never mistaken for protected control', () => {
  for (const spoken of [
    'is the deadbolt locked?',
    'show me the front door lock status',
    'watch the door and tell me when it unlocks',
    'notify me when the deadbolt is unlocked',
  ]) {
    assert.equal(isObservationRequest(spoken), true, `"${spoken}" should remain observation`);
  }
  for (const spoken of ['unlock the front door', 'unlatch the deadbolt', 'open the garage door']) {
    assert.equal(isObservationRequest(spoken), false, `"${spoken}" is an action request`);
  }
});

test('only a leading Carvis address counts as an exact wake word', () => {
  const words = ['carvis', 'carvus'];
  const leading = leadingWake('Hey, Carvis, unlock the door', words);
  assert.equal(leading.exact, true);
  assert.equal(leading.fuzzy, false);
  assert.equal(leading.stripped, 'unlock the door');

  const mentioned = leadingWake('I told Carvis to unlock the door', words);
  assert.equal(mentioned.exact, false);
  assert.equal(mentioned.fuzzy, false);
  assert.equal(mentioned.stripped, 'I told Carvis to unlock the door');
});

test('a mangled wake word is fuzzy, never exact — and the built trigger reflects that', async () => {
  // Real Whisper output for "Carvis" from one recorded session, plus the
  // command that follows it in the actual failure case this fixes. Verified
  // against every one of the 33 recognized command verbs with zero
  // false-positive overlap — see the FUZZY_WAKE_MAX_DISTANCE comment.
  const words = ['carvis', 'carvus', 'carvas', 'karvis', 'jarvis'];
  const mishearings = ['Carpis', 'Carson', 'Tartars', 'Harvest'];
  for (const heard of mishearings) {
    const wake = leadingWake(`${heard}, unlock the front door`, words);
    assert.equal(wake.exact, false, `${heard} must never be an exact match`);
    assert.equal(wake.fuzzy, true, `${heard} should be recognized as a fuzzy attempt`);
  }

  // This is the assertion that matters, not the matcher in isolation. A
  // tri-state 'exact'|'fuzzy'|false return would be truthy under
  // Boolean('fuzzy') === true — that is the exact shape of bug that would let
  // "Harvest, unlock the front door" skip the swipe confirmation a lock
  // command requires and invoke Carvis directly, wake_word looking
  // authenticated. Staging a confirmation, rather than acting immediately, IS
  // the proof wake.exact came through false. If this ever starts invoking
  // directly instead, the fix has regressed.
  const { voice, invocations } = testVoice();
  const result = await voice.ingest('Harvest, unlock the front door', { source: 'glasses' });
  assert.equal(result.outcome, 'confirmation');
  assert.equal(invocations.length, 0);
});

test('command verbs never fuzzy-match as a mangled wake word', () => {
  const words = ['carvis', 'carvus', 'carvas', 'karvis', 'jarvis'];
  for (const verb of ['clear', 'arm', 'capture', 'create', 'mark', 'pause', 'run']) {
    const wake = leadingWake(`${verb} the HUD`, words);
    assert.equal(wake.exact, false);
    assert.equal(wake.fuzzy, false, `"${verb}" must not be treated as an attempted wake word`);
  }
});

test('quiet hours plus a wake word still pauses a light command for a swipe', () => {
  const midnight = new Date(2026, 0, 1, 23, 30); // 11:30pm, inside the default 23:00-07:00 window
  const decision = confirmationDecision({
    spoken: 'turn on all the lights',
    wakeExact: true,
    quietHoursEnabled: true,
    quietHours: { start: 23, end: 7 },
    now: midnight,
  });
  assert.equal(decision.confirm, true);
});

test('the same command outside quiet hours never pauses', () => {
  const noon = new Date(2026, 0, 1, 12, 0);
  const decision = confirmationDecision({
    spoken: 'turn on all the lights',
    wakeExact: true,
    quietHoursEnabled: true,
    quietHours: { start: 23, end: 7 },
    now: noon,
  });
  assert.equal(decision.confirm, false);
});

test('without the exact wake word, quiet hours never apply here — the earlier gates already handle that case', () => {
  const midnight = new Date(2026, 0, 1, 23, 30);
  const decision = confirmationDecision({
    spoken: 'turn on all the lights',
    wakeExact: false,
    quietHoursEnabled: true,
    quietHours: { start: 23, end: 7 },
    now: midnight,
  });
  assert.equal(decision.confirm, false);
});

test('quiet hours never touches a tier-3 domain, even during the window', () => {
  // The word list is structurally restricted to soft domains — this proves
  // it, rather than trusting the restriction was applied correctly by eye.
  // If this ever starts returning true, someone added "lock" or "door" to
  // QUIET_HOURS_CONFIRM_DOMAINS, and resolveConfirmation's hardcoded
  // wake_word: false would make the command permanently unreachable.
  const midnight = new Date(2026, 0, 1, 23, 30);
  for (const spoken of ['unlock the front door', 'arm the alarm', 'open the garage']) {
    const decision = confirmationDecision({
      spoken,
      wakeExact: true,
      quietHoursEnabled: true,
      quietHours: { start: 23, end: 7 },
      now: midnight,
    });
    assert.equal(decision.confirm, false, `"${spoken}" must never be gated by quiet hours`);
  }
});

test('Digital and Standard commands with no wake word now execute directly, no swipe', async () => {
  // The owner's explicit "don't require the wake word as much": only
  // Critical still forces a swipe absent the wake word. A HUD display
  // (Digital) and a light (Standard) no longer do.
  const { voice, invocations } = testVoice();

  const digital = await voice.ingest('Put the Living Room camera on my HUD.', { source: 'glasses' });
  assert.equal(digital.outcome, 'acted');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].trigger.wake_word, false);
  assert.equal(invocations[0].trigger.confirmed, false);

  const standard = await voice.ingest('turn on the kitchen lights', { source: 'glasses' });
  assert.equal(standard.outcome, 'acted');
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].trigger.wake_word, false);
});

test('a no-wake request to lock a deadbolt acts directly; only unlocking needs the second signal', async () => {
  const { voice, invocations } = testVoice();
  const result = await voice.ingest('lock the front door', { source: 'glasses', confidence: 0.7 });
  assert.equal(result.outcome, 'acted');
  assert.equal(voice.confirmation, null);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].trigger.wake_word, false);
});

test('Critical commands with no wake word now stage a swipe instead of being flatly denied', async () => {
  // The new capability this build adds: guards.js used to deny a no-wake-word
  // Critical command outright with nothing offered. Now an accepted swipe is
  // a recognized alternate authorization (ctx.confirmed).
  const { voice, invocations } = testVoice();
  const staged = await voice.ingest('unlock the front door', { source: 'glasses' });

  assert.equal(staged.outcome, 'confirmation');
  assert.equal(invocations.length, 0);

  const accepted = await voice.resolveConfirmation(staged.confirmation.id, true);
  assert.equal(accepted.outcome, 'acted');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].trigger.confirmed, true);
  assert.equal(invocations[0].trigger.wake_word, false);

  const replay = await voice.resolveConfirmation(staged.confirmation.id, true);
  assert.equal(replay.outcome, 'stale');
  assert.equal(invocations.length, 1);
});

test('decline consumes a confirmation without invoking Carvis', async () => {
  const { voice, invocations } = testVoice();
  const staged = await voice.ingest('unlock the front door', {
    source: 'glasses',
  });

  const declined = await voice.resolveConfirmation(staged.confirmation.id, false);
  assert.equal(declined.outcome, 'declined');
  assert.equal(voice.confirmation, null);
  assert.equal(invocations.length, 0);
});

test('a leading wake word executes directly and retains wake-word authorization, even for Critical', async () => {
  const { voice, invocations } = testVoice();
  const result = await voice.ingest('Hey, Carvis, unlock the front door.', {
    source: 'glasses',
  });

  assert.equal(result.outcome, 'acted');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].trigger.wake_word, true);
  assert.equal(invocations[0].trigger.confirmed, false);
});

test('a Critical utterance below the 80% confidence floor is dropped even though it would pass the general 15% floor', async () => {
  const { voice, invocations } = testVoice();
  const result = await voice.ingest('unlock the front door', { source: 'glasses', confidence: 0.7 });
  assert.equal(result.outcome, 'ignored');
  assert.equal(invocations.length, 0);

  const confirmed = await voice.ingest('unlock the front door', { source: 'glasses', confidence: 0.85 });
  assert.equal(confirmed.outcome, 'confirmation');
});

test('a Standard utterance only needs the shared 60% floor, not Critical\'s 80%', async () => {
  const { voice, invocations } = testVoice();
  const dropped = await voice.ingest('turn on the lights', { source: 'glasses', confidence: 0.5 });
  assert.equal(dropped.outcome, 'ignored');
  assert.equal(invocations.length, 0);

  const acted = await voice.ingest('turn on the lights', { source: 'glasses', confidence: 0.65 });
  assert.equal(acted.outcome, 'acted');
  assert.equal(invocations.length, 1);
});

test('Web UI text is an explicit user_text request', async () => {
  const { voice, invocations } = testVoice();

  const result = await voice.request('What is currently displayed on my HUD?', { source: 'web' });

  assert.equal(result.outcome, 'acted');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].trigger.type, 'user_text');
  assert.equal(invocations[0].trigger.wake_word, false);
  assert.equal(voice.confirmation, null);
});

test('the owner transcript records what was heard and the route it actually took', async () => {
  const { voice, invocations } = testVoice();

  const staged = await voice.ingest('unlock the front door', {
    source: 'glasses',
  });
  let [entry] = voice.transcriptState().entries;
  assert.equal(entry.kind, 'voice');
  assert.equal(entry.source, 'glasses');
  assert.equal(entry.text, 'unlock the front door');
  assert.equal(entry.outcome, 'confirmation');
  assert.match(entry.detail, /Waiting for swipe confirmation/);

  await voice.resolveConfirmation(staged.confirmation.id, false);
  [entry] = voice.transcriptState().entries;
  assert.equal(entry.outcome, 'declined');
  assert.equal(entry.detail, 'Declined on the glasses');
  assert.equal(invocations.length, 0);

  assert.equal(voice.clearTranscript(), 1);
  assert.deepEqual(voice.transcriptState().entries, []);
});

test('ignored speech and typed WebUI requests are both visible in the owner transcript', async () => {
  const { voice } = testVoice();

  const ignored = await voice.ingest('..', { source: 'glasses' });
  assert.equal(ignored.outcome, 'ignored');
  const acted = await voice.request('What is currently displayed on my HUD?', { source: 'web' });
  assert.equal(acted.outcome, 'acted');

  const [heard, typed] = voice.transcriptState().entries;
  assert.deepEqual(
    { kind: heard.kind, source: heard.source, outcome: heard.outcome, detail: heard.detail },
    { kind: 'voice', source: 'glasses', outcome: 'ignored', detail: 'Ignored — too short' },
  );
  assert.equal(typed.kind, 'typed');
  assert.equal(typed.source, 'web');
  assert.equal(typed.outcome, 'acted');
  assert.equal(typed.detail, 'Sent to Carvis');
});

test('an accepted command survives a busy Carvis and still executes exactly once', async () => {
  const { voice, invocations, carvis } = testVoice();
  let attempts = 0;
  carvis.invoke = async (request) => {
    attempts++;
    if (attempts === 1) return { outcome: 'busy' };
    invocations.push(request);
    return { outcome: 'done', reply: 'Done.', calls: [], ms: 1, costUsd: 0 };
  };

  const staged = await voice.ingest('unlock the front door', {
    source: 'glasses',
  });
  const accepted = await voice.resolveConfirmation(staged.confirmation.id, true);

  assert.equal(accepted.outcome, 'acted');
  assert.equal(attempts, 2);
  assert.equal(invocations.length, 1);
  assert.equal(voice.confirmation, null);
});

test('a typed Critical request stages a confirmation instead of acting immediately', async () => {
  // The audit's actual failure case: a typed relock request used to skip
  // straight to #act() with no wake word and no confirmation — neither of
  // the two stops Critical is supposed to require. request() now runs the
  // same #needsConfirmation decision #ingest already does for voice.
  const { voice, invocations } = testVoice();
  const staged = await voice.request('unlock the front door', { source: 'web' });

  assert.equal(staged.outcome, 'confirmation');
  assert.equal(invocations.length, 0);

  const accepted = await voice.resolveConfirmation(staged.confirmation.id, true);
  assert.equal(accepted.outcome, 'acted');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].trigger.type, 'user_text');
  assert.equal(invocations[0].trigger.confirmed, true);
  assert.equal(invocations[0].trigger.wake_word, false);
});

test('typed opaque and wellbeing requests stage the same explicit confirmation', async () => {
  for (const utterance of ['run the movie night scene', 'press the garage routine button', 'turn off my CPAP']) {
    const { voice, invocations } = testVoice();
    const staged = await voice.request(utterance, { source: 'web' });
    assert.equal(staged.outcome, 'confirmation', utterance);
    assert.equal(invocations.length, 0, utterance);
  }
});

test('an unlock synonym stages before Carvis can attempt the action', async () => {
  const { voice, carvis, invocations } = testVoice();
  let attempts = 0;
  carvis.invoke = async (request) => {
    invocations.push(request);
    attempts += 1;
    return {
      outcome: 'done',
      reply: attempts === 1 ? 'I need confirmation.' : 'Done.',
      // This models the exact safe failure from guards.js after Carvis
      // resolved a euphemism that the lexical classifier did not know.
      calls: [{ name: 'ha.secure.command', ok: attempts > 1, requiresConfirmation: attempts === 1 }],
      ms: 1,
      costUsd: 0,
    };
  };

  const staged = await voice.request('unlatch the front entrance', { source: 'web' });
  assert.equal(staged.outcome, 'confirmation');
  assert.equal(invocations.length, 0, 'no model/tool attempt happens before the owner accepts');

  const accepted = await voice.resolveConfirmation(staged.confirmation.id, true);
  assert.equal(accepted.outcome, 'acted');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].trigger.confirmed, true);
  assert.equal(invocations[0].trigger.wake_word, false);
});

test('a typed Standard/Digital request is unaffected — still acts immediately, no swipe', async () => {
  const { voice, invocations } = testVoice();
  const result = await voice.request('turn on the kitchen lights', { source: 'web' });
  assert.equal(result.outcome, 'acted');
  assert.equal(invocations.length, 1);
  assert.equal(voice.confirmation, null);
});

test('a dashboard direct confirmation resolves by calling the gateway directly, never by invoking Carvis', async () => {
  const { voice, invocations, gatewayCalls } = testVoice();
  const staged = voice.stageDirectConfirmation({
    prompt: 'Lock Front Door?',
    entityId: 'lock.front_door',
    service: 'lock',
    reason: 'owner clicked lock on lock.front_door via the dashboard',
  });
  assert.equal(staged.outcome, 'confirmation');
  assert.equal(gatewayCalls.length, 0);

  const accepted = await voice.resolveConfirmation(staged.confirmation.id, true);
  assert.equal(accepted.outcome, 'acted');
  // Never re-invoked the model loop — a dashboard click already knows the
  // exact entity + service, re-asking Carvis to decide again would be both
  // wasteful and a second, unaudited decision point.
  assert.equal(invocations.length, 0);
  assert.equal(gatewayCalls.length, 1);
  assert.equal(gatewayCalls[0].name, 'ha.secure.command');
  assert.deepEqual(gatewayCalls[0].args, { entity_id: 'lock.front_door', service: 'lock' });
  assert.equal(gatewayCalls[0].ctx.confirmed, true);
  assert.equal(gatewayCalls[0].ctx.reason, 'owner clicked lock on lock.front_door via the dashboard');
});

test('declining a dashboard direct confirmation never touches the gateway', async () => {
  const { voice, gatewayCalls } = testVoice();
  const staged = voice.stageDirectConfirmation({
    prompt: 'Unlock Front Door?',
    entityId: 'lock.front_door',
    service: 'unlock',
    reason: 'owner clicked unlock on lock.front_door via the dashboard',
  });
  const declined = await voice.resolveConfirmation(staged.confirmation.id, false);
  assert.equal(declined.outcome, 'declined');
  assert.equal(gatewayCalls.length, 0);
  assert.equal(voice.confirmation, null);
});

test('a failed dashboard direct confirmation reports the real gateway error, not a false success', async () => {
  const { voice, carvis } = testVoice();
  carvis.gateway.call = async () => ({ success: false, error: 'wellbeing guard: this device can only change during a live owner request' });
  const staged = voice.stageDirectConfirmation({
    prompt: 'Lock Front Door?',
    entityId: 'lock.front_door',
    service: 'lock',
    reason: 'owner clicked lock on lock.front_door via the dashboard',
  });
  const result = await voice.resolveConfirmation(staged.confirmation.id, true);
  assert.equal(result.outcome, 'error');
});

test('confirmation staging and resolution both broadcast onConfirmationChange', async () => {
  const { voice, confirmationChanges } = testVoice();
  const staged = await voice.ingest('unlock the front door', { source: 'glasses' });
  assert.equal(confirmationChanges.length, 1);
  assert.equal(confirmationChanges[0].id, staged.confirmation.id);

  await voice.resolveConfirmation(staged.confirmation.id, false);
  assert.equal(confirmationChanges.length, 2);
  assert.equal(confirmationChanges[1], null);
});

test('clearTranscript clears the persisted copy, not just the in-memory ring', () => {
  const { voice, deletedTranscriptCalls } = testVoice();
  assert.equal(deletedTranscriptCalls.length, 0);
  voice.clearTranscript();
  assert.equal(deletedTranscriptCalls.length, 1);
});

test("answering Carvis's own clarifying question is not silently dropped by triage", async () => {
  const { voice, carvis } = testVoice();
  let triageCalls = 0;
  voice.complete = async () => {
    triageCalls++;
    // Judged alone, a bare answer like "the workbench light" reads as
    // unaddressed — this is what triage would say without the clarification
    // window's free pass.
    return { json: { addressed: false, project_relevant: false, implicit_intent: false, category: 'home' } };
  };
  const replies = ['Which camera, sir?', 'The Living Room camera is on your HUD, sir.'];
  let replyIndex = 0;
  carvis.invoke = async () => ({ outcome: 'done', reply: replies[replyIndex++], calls: [], ms: 1, costUsd: 0 });

  const asked = await voice.ingest('carvis put a camera on my HUD', { source: 'glasses' });
  assert.equal(asked.outcome, 'acted');
  assert.equal(triageCalls, 0, 'the wake word already skips triage');

  // Three words specifically exercises the cheap coherence gate. This was
  // the real regression: the clarification bypass lived after that gate, so
  // it was unreachable for a perfectly good short answer.
  const answered = await voice.ingest('the workbench light', { source: 'glasses' });
  assert.equal(answered.outcome, 'acted', "the reply to Carvis's own question must not be dropped as \"not for Carvis\"");
  assert.equal(triageCalls, 0, 'the clarification window should bypass triage, not just override its verdict');

  // One-shot: an unrelated utterance right after gets no free pass, and the
  // non-question second reply already cleared the window.
  const unrelated = await voice.ingest('what a nice day', { source: 'glasses' });
  assert.equal(unrelated.outcome, 'ignored');
  assert.equal(triageCalls, 1);
});

test('live speech uses its independent fast role without weakening wake word or confirmation context', async () => {
  const h=testVoice();
  h.config.models={roles:{voice_triage:{provider:'test',model:'fast'}}};
  let role;
  h.voice.complete=async (cfg,r)=>{role=r;return {json:{addressed:true,project_relevant:false,implicit_intent:false,category:'home'}};};
  const result=await h.voice.ingest('Turn on the workbench lamp.',{source:'glasses',confidence:0.99});
  assert.equal(result.outcome,'acted');
  assert.equal(role,'voice_triage');
  assert.equal(h.invocations[0].trigger.wake_word,false);
  assert.equal(h.invocations[0].trigger.confirmed,false);
  assert(Number.isFinite(h.invocations[0].trigger.triage_ms));
});


test('triage acknowledgement reaches only addressed turns without becoming authorization', async () => {
  const h = testVoice();
  const acknowledgement = "I'll check the printer status, sir.";
  h.voice.complete = async () => ({json: {addressed:true, project_relevant:false, implicit_intent:false, category:'question', acknowledgement}});
  await h.voice.ingest('What is the printer status?', {source:'glasses', confidence:0.99});
  assert.equal(h.invocations[0].acknowledgement, acknowledgement);
  assert.equal(h.invocations[0].trigger.wake_word, false);
  assert.equal(h.invocations[0].trigger.confirmed, false);
  assert.equal(h.invocations[0].trigger.acknowledgement, undefined);

  h.voice.complete = async () => ({json: {addressed:false, project_relevant:true, implicit_intent:false, category:'project', acknowledgement:'This must never be spoken.'}});
  await h.voice.ingest('Finished printing the insert, it fits.', {source:'glasses', confidence:0.99});
  assert.equal(h.invocations[1].acknowledgement, undefined);
  assert.equal(h.invocations[1].trigger.type, 'overheard');
});

test('lighting location words do not stage appliance confirmation',()=>{
 assert.equal(classifyRiskTier('turn on the stove light'),'standard');
 assert.equal(classifyRiskTier('set the color temperature to 3000'),'standard');
 assert.equal(classifyRiskTier('turn on the stove'),'critical');
 assert.equal(classifyRiskTier('turn on the stove light and the heater'),'critical');
});

test('contextual navigation passes short gates, repeats deliberately, and still uses triage', async () => {
  const h = testVoice();
  h.config.voice.dedupeWindowSec = 12;
  h.carvis.recentConversation = () => [
    {role:'user',content:'Turn on Apple TV'},
    {role:'assistant',content:'Apple TV is awake.'},
  ];
  let calls = 0;
  h.voice.complete = async () => { calls++; return {json:{addressed:true,category:'home'}}; };
  assert.equal((await h.voice.ingest('up',{confidence:0.99})).outcome,'acted');
  assert.equal((await h.voice.ingest('up',{confidence:0.99})).reason,'duplicate');
  h.voice.lastAt = Date.now() - 1500;
  assert.equal((await h.voice.ingest('up',{confidence:0.99})).outcome,'acted');
  assert.equal(calls,2);
  assert.equal(h.invocations[0].trigger.wake_word,false);
  assert.equal(h.invocations[0].trigger.confirmed,false);
  h.config.voice.requireWakeWord = true;
  assert.equal((await h.voice.ingest('select',{confidence:0.99})).reason,'no wake word');
});

test('contextual fragments retain confidence and addressed checks', async () => {
  const h = testVoice();
  h.carvis.recentConversation = () => [{role:'user',content:'Adjust the music volume'},{role:'assistant',content:'Volume adjusted.'}];
  assert.match((await h.voice.ingest('quieter',{confidence:0.2})).reason,/confidence too low/);
  h.voice.complete = async () => ({json:{addressed:false,project_relevant:false,implicit_intent:false,category:'none'}});
  await h.voice.ingest('quieter',{confidence:0.99});
  assert.equal(h.invocations.length,0);
});

test('owner Standard overrides defer speech confirmation to the resolved entity guard', async () => {
 const h=testVoice();
 h.config.entities={guards:{'remote.apple_tv':'standard'}};
 const result=await h.voice.ingest('use the Apple TV remote to go left',{confidence:0.99});
 assert.equal(result.outcome,'acted');
 assert.equal(h.invocations[0].trigger.confirmed,false);
 assert.equal(h.invocations[0].trigger.wake_word,false);
});

test('short unmuted replies reach triage without bypassing its decision',async()=>{
 const h=testVoice();let calls=0;
 h.voice.complete=async()=>{calls++;return {json:{addressed:true,category:'question'}};};
 assert.equal((await h.voice.ingest('no',{source:'glasses',confidence:0.99})).outcome,'acted');
 assert.equal(calls,1);
 h.voice.complete=async()=>{calls++;return {json:{addressed:false,project_relevant:false,implicit_intent:false,category:'none'}};};
 assert.equal((await h.voice.ingest('hmm',{source:'glasses',confidence:0.99})).outcome,'ignored');
 assert.equal(calls,2);assert.equal(h.invocations.length,1);
});

test('widget direct confirmation retains color, brightness and other typed command parameters',async()=>{
 const h=testVoice();const command={entity_id:'light.guarded',service:'turn_on',brightness_pct:65,rgb_color:[0,0,255]};
 const {confirmation}=h.voice.stageDirectConfirmation({prompt:'Apply blue?',entityId:command.entity_id,service:command.service,reason:'Glasses widget gesture',command,source:'glasses'});
 assert.equal(h.voice.pendingConfirmation.source,'glasses');
 command.brightness_pct=1;
 const result=await h.voice.resolveConfirmation(confirmation.id,true);
 assert.equal(result.outcome,'acted');assert.equal(h.gatewayCalls[0].args.brightness_pct,65);assert.deepEqual(h.gatewayCalls[0].args.rgb_color,[0,0,255]);assert.equal(h.gatewayCalls[0].ctx.confirmed,true);
 await h.voice.resolveConfirmation(confirmation.id,true);assert.equal(h.gatewayCalls.length,1);
});
