/**
 * Safe, observable execution traces for the owner-facing Web UI.
 *
 * A trace is deliberately not a prompt dump or a model thought dump. It shows
 * the things an operator can verify: why a turn started, which model rounds
 * happened, the gateway calls they produced, their audit outcome, and timing.
 * The model's hidden reasoning and credentials never leave the server through
 * this shape. The authenticated owner explicitly opted to see the exact words
 * Carvis heard alongside the turn that used them, so owner speech/text is
 * included only in that invocation's Heard block.
 */

const MAX_TEXT = 360;
const MAX_OBJECT_KEYS = 30;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 5;

const SECRET_KEY = /(?:api[_-]?key|access[_-]?key|secret|token|password|authorization|credential|cookie|private[_-]?key)/i;
// Free-form values can contain spoken requests, watch instructions, camera
// labels, or the body of a Mac command. Trace is operational metadata, not a
// second place to publish that private text.
const PRIVATE_TEXT_KEY = /^(?:text|content|prompt|message|body|note|description|query|utterance|transcript|instruction|request|reason|original_reason|requested|reply|then|command|detail|target|title|value|label|name|error)$/i;
const SAFE_STRING_KEY = /^(?:id|entity_id|service|domain|state|status|type|kind|source|tool|provider|model|role|authorization|outcome|code|field|operator|event|watch_id|schedule_id|frame_id|image_revision|created_by)$/i;

function clampText(value, max = MAX_TEXT) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    // Common credential forms, including credentials hidden in an error URL.
    .replace(/(bearer\s+)[^\s,;"']+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?key|token|secret|password|authorization|credential)\s*["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|access[_-]?key|token|secret|password|authorization)=[^&#\s]*)/gi, (match) => {
      const split = match.indexOf('=');
      return `${match.slice(0, split + 1)}[redacted]`;
    })
    .replace(/\bsk(?:-[a-z]+)?-[a-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b(?:ghp|github_pat|xox[baprs])_[a-z0-9_-]{8,}\b/gi, '[redacted]');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isSecretKey(key) {
  return SECRET_KEY.test(String(key));
}

function isPrivateTextKey(key) {
  return PRIVATE_TEXT_KEY.test(String(key));
}

function isSafeStringKey(key) {
  return SAFE_STRING_KEY.test(String(key));
}

/** Redact secrets and full free-form text while keeping structured results useful. */
export function safeTraceValue(value, { key = '', depth = 0 } = {}) {
  if (isSecretKey(key)) return '[redacted]';
  if (value === null || value === undefined) return value ?? null;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') {
    // A trace must use an explicit allow-list for strings. New tool fields are
    // private by default until they are deliberately classified as metadata.
    return isPrivateTextKey(key) || (key && !isSafeStringKey(key))
      ? '[private text omitted]'
      : clampText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) return clampText(value.message);

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => safeTraceValue(entry, { key: '[array]', depth: depth + 1 }));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`[${value.length - MAX_ARRAY_ITEMS} more omitted]`);
    return out;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    const out = Object.fromEntries(entries.map(([childKey, child]) => [
      childKey,
      safeTraceValue(child, { key: childKey, depth: depth + 1 }),
    ]));
    if (Object.keys(value).length > MAX_OBJECT_KEYS) out._truncated = `${Object.keys(value).length - MAX_OBJECT_KEYS} fields omitted`;
    return out;
  }

  return clampText(value);
}

/**
 * The trigger tells us why Carvis woke. Exact owner speech/text belongs to the
 * same trace card so debugging a turn does not require hopping to Transcript.
 * Never carry arbitrary watch instructions, reasons, tool text, or event data
 * through this exception.
 */
export function safeTraceTrigger(trigger, triggerType = '') {
  const source = trigger && typeof trigger === 'object' ? trigger : {};
  const type = String(source.type || triggerType || 'unknown');
  const out = { type: clampText(type, 80) };
  for (const key of ['event', 'source', 'watch_id', 'schedule_id', 'confirmed', 'wake_word', 'implicit']) {
    if (source[key] !== undefined && source[key] !== null) out[key] = safeTraceValue(source[key], { key });
  }
  if (source.event_data !== undefined) out.event_data = safeTraceValue(source.event_data, { key: 'event_data' });
  if (typeof source.triage_ms === 'number' && Number.isFinite(source.triage_ms)) out.triage_ms = Math.max(0, source.triage_ms);
  const states = new Set(['on', 'off', 'open', 'closed', 'locked', 'unlocked', 'locking', 'unlocking', 'unknown', 'unavailable', 'idle', 'playing', 'paused', 'printing', 'finished', 'finish', 'failed']);
  if (source.event_data && states.has(source.event_data.from) && states.has(source.event_data.to)) {
    out.transition = `${source.event_data.from} → ${source.event_data.to}`;
  }
  if (typeof source.importance === 'number' && Number.isFinite(source.importance)) out.importance = Math.max(0, Math.min(1, source.importance));
  // This is the one deliberately owner-visible free-form field. It is bounded
  // and still credential-scrubbed by clampText; all other free-form trigger
  // fields remain private by default.
  if (['user_voice', 'user_text', 'overheard'].includes(type) && typeof source.transcript === 'string') {
    out.transcript = clampText(source.transcript, 1_200);
  }
  return out;
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeError(value) {
  return value ? '[private error omitted]' : null;
}

// Explanations come from fixed diagnostic vocabulary, never raw error text,
// owner instructions or a model's private reasoning.
function diagnostic(value, authorization = '') {
  const gates = {
    denied_risk: 'The gateway blocked this tool under the existing risk policy.',
    invalid_arguments: 'The tool arguments did not match its required schema.',
    unknown_tool: 'The requested tool is not registered.',
    in_flight: 'An identical request is already in progress.',
  };
  if (gates[authorization]) return gates[authorization];
  const text = String(value || '');
  if (!text) return null;
  if (/Light settings require light\.turn_on/i.test(text)) return 'Rejected before execution: lighting arguments were attached to a command that was not light.turn_on. No device command was sent.';
  if (/Power command accepted, but Home Assistant has not confirmed/i.test(text)) return 'Home Assistant accepted the power command, but the requested state was not confirmed. Accepted does not mean the TV turned on.';
  if (/already on|already off|already using effect/i.test(text)) return 'No change was sent: the requested setting was already active.';
  if (/timeout|timed out|abort/i.test(text)) return 'The operation exceeded its response deadline.';
  if (/401|403|unauthori[sz]ed|authentication/i.test(text)) return 'The service rejected authentication or access.';
  if (/429|rate.limit/i.test(text)) return 'The service rate limit was reached.';
  if (/not.*controllable|not.*selected|not available to Carvis/i.test(text)) return 'The requested entity is outside the available Carvis selection.';
  if (/confirm|wake.word|live.owner/i.test(text)) return 'The request did not meet the required owner confirmation conditions.';
  if (/unavailable|unreachable|not connected|ECONN|fetch failed/i.test(text)) return 'The required device or service was unavailable.';
  if (/\b5\d\d\b/.test(text)) return 'The upstream service returned a server error.';
  return 'The operation reported an error; private diagnostic text is withheld.';
}

function toolOutcome(call) {
  const result = call.result || {};
  if (!call.ok || result.success === false || (call.tool === 'mac.command' && result.status === 'failed')) return 'failed';
  if (result.deduplicated || call.authorization === 'deduplicated') return 'deduplicated';
  if (result.dry_run || result.dryRun) return 'dry_run';
  if (call.tool === 'mac.command' && ['pending', 'sent'].includes(result.status)) return 'queued';
  if (call.tool === 'speech.say') return 'accepted';
  if ((call.tool === 'ha.media.navigate' || call.tool === 'ha.media.control' || call.tool === 'ha.media.power' || (call.tool === 'ha.entity.command' && String(call.arguments?.entity_id || '').startsWith('media_player.'))) && result.verified !== true) return 'accepted';
  return Number(call.risk) === 0 ? 'read' : 'succeeded';
}

function toolFacts(call) {
  const args = call.arguments || {};
  const result = call.result || {};
  const facts = [];
  const add = (label, value) => facts.push({ label, value: String(value) });
  // Copy only structured operational values already permitted by the trace
  // filter. Free-form target names, commands and messages stay private.
  for (const key of ['entity_id', 'service', 'state', 'status']) {
    if (typeof result[key] === 'string') add(`Returned ${key.replaceAll('_', ' ')}`, clampText(result[key]));
    if (typeof args[key] === 'string') add(`Requested ${key.replaceAll('_', ' ')}`, clampText(args[key]));
  }
  const commands = {turn_on:'Power on',turn_off:'Power off',media_play:'Resume playback (not power on)',media_pause:'Pause playback',media_stop:'Stop playback',media_next_track:'Next track',media_previous_track:'Previous track',select_source:'Select playback device',play_media:'Start selected media'};
  const actions = {play:'media_play',pause:'media_pause',stop:'media_stop',next:'media_next_track',previous:'media_previous_track',select_source:'select_source',play_media:'play_media'};
  const media = /^ha\.media\./.test(call.tool || '') || String(args.entity_id || '').startsWith('media_player.');
  if (call.tool === 'ha.media.navigate' && ['up','down','left','right','select','menu','top_menu'].includes(args.button)) add('Remote button', args.button);
  if (media) {
    const service = args.service || (call.tool === 'ha.media.power' ? (args.state === 'on' ? 'turn_on' : 'turn_off') : actions[args.action]);
    if (commands[service]) add('Command meaning', commands[service]);
    const lighting = ['rgb_color','color_temp_kelvin','brightness_pct','effect'].filter(key => args[key] !== undefined);
    if (lighting.length) add('Unexpected lighting fields', lighting.join(', '));
    if (result.verified === true) add('Device confirmation', 'Home Assistant confirmed the requested state');
    else if (result.pending === true) add('Device confirmation', 'Not confirmed — still pending');
    else if (call.ok && result.success !== false && Number(call.risk) > 0 && !result.dry_run) add('Device confirmation', 'Command accepted; resulting device state not verified by this call');
    if (['on','off','idle','playing','paused','standby','buffering','unknown','unavailable'].includes(result.actual_state)) add('Observed device state', result.actual_state);
    if (/Light settings require light\.turn_on/i.test(result.error || '')) add('Sent to Home Assistant', 'No — rejected by the argument guard');
  }
  for (const [key, label] of [['brightness', 'Brightness (%)'], ['seconds', 'Duration (seconds)'], ['slot', 'HUD slot']]) {
    if (typeof args[key] === 'number' && Number.isFinite(args[key])) add(label, args[key]);
  }
  for (const [key, label] of [['total', 'Matches'], ['age_seconds', 'State age (seconds)']]) {
    if (typeof result[key] === 'number' && Number.isFinite(result[key])) add(label, result[key]);
  }
  for (const key of ['entities', 'items', 'projects', 'tasks']) {
    if (Array.isArray(result[key])) add(`Returned ${key}`, result[key].length);
  }
  if (call.tool === 'speech.say') {
    if (result.target === 'physical_core') add('Output route', 'Physical Carvis core');
    else if (/^media_player\.[a-z0-9_]+$/.test(result.media_player || '')) add('Speaker entity', result.media_player);
    if (result.recovered === true) add('Delivery recovery', 'Speaker reset and retry succeeded');
  }
  return facts;
}

function safeStep(step) {
  return {
    id: clampText(step.id || '', 100),
    sequence: finite(step.step, 0),
    round: finite(step.round ?? step.round_number, 0),
    at: finite(step.ts, 0),
    kind: clampText(step.kind || 'model', 40),
    role: clampText(step.role || '', 80),
    provider: clampText(step.provider || '', 100),
    model: clampText(step.model || '', 160),
    durationMs: finite(step.duration_ms, 0),
    toolCount: finite(step.tool_count, 0),
    outcome: clampText(step.outcome || '', 80),
    // Known phase labels are operational metadata; arbitrary detail is not.
    phase: /^(?:primary|escalated|requested|acknowledgement)$/i.test(String(step.detail || ''))
      ? String(step.detail)
      : step.detail
        ? '[private detail omitted]'
        : '',
    error: safeError(step.error),
    diagnostic: diagnostic(step.error),
  };
}

function safeToolCall(call) {
  return {
    id: clampText(call.id || '', 100),
    at: finite(call.ts, 0),
    round: call.round === null || call.round === undefined ? null : finite(call.round, 0),
    tool: clampText(call.tool || '', 160),
    risk: finite(call.risk, 0),
    authorization: clampText(call.authorization || '', 80),
    ok: Boolean(call.ok),
    durationMs: finite(call.ms, 0),
    arguments: safeTraceValue(call.arguments, { key: 'arguments' }),
    result: safeTraceValue(call.result, { key: 'result' }),
    error: safeError(call.error),
    outcome: toolOutcome(call),
    diagnostic: diagnostic(call.error || (call.result?.success === false ? call.result.error : ''), call.authorization),
    facts: toolFacts(call),
  };
}

/** Convert database audit rows into the only trace shape the Web UI may receive. */
export function buildTraceView({ invocations = [], steps = [], toolCalls = [] } = {}) {
  const stepsByInvocation = new Map();
  for (const step of steps) {
    if (!step.invocation_id) continue;
    const list = stepsByInvocation.get(step.invocation_id) || [];
    list.push(safeStep(step));
    stepsByInvocation.set(step.invocation_id, list);
  }

  const callsByInvocation = new Map();
  const unattachedToolCalls = [];
  for (const call of toolCalls) {
    const safe = safeToolCall(call);
    if (!call.invocation_id) {
      unattachedToolCalls.push(safe);
      continue;
    }
    const list = callsByInvocation.get(call.invocation_id) || [];
    list.push(safe);
    callsByInvocation.set(call.invocation_id, list);
  }

  const traceInvocations = invocations.map((invocation) => {
    const invocationSteps = (stepsByInvocation.get(invocation.id) || []).sort(
      (a, b) => a.sequence - b.sequence || a.at - b.at,
    );
    const invocationCalls = (callsByInvocation.get(invocation.id) || []).sort((a, b) => a.at - b.at);
    const counts = { read: 0, succeeded: 0, failed: 0, queued: 0, accepted: 0, deduplicated: 0, dry_run: 0 };
    for (const call of invocationCalls) counts[call.outcome]++;
    for (const item of [...invocationSteps, ...invocationCalls]) item.offsetMs = Math.max(0, item.at - finite(invocation.ts));
    return {
      id: clampText(invocation.id || '', 100),
      startedAt: finite(invocation.ts, 0),
      triggerType: clampText(invocation.trigger_type || '', 80),
      trigger: safeTraceTrigger(invocation.trigger, invocation.trigger_type),
      role: clampText(invocation.role || '', 80),
      provider: clampText(invocation.provider || '', 100),
      model: clampText(invocation.model || '', 160),
      promptVersion: clampText(invocation.prompt_version || '', 100),
      declaredRounds: finite(invocation.rounds, 0),
      modelRounds: invocationSteps.filter((step) => step.kind === 'model').length,
      usage: {
        inputTokens: finite(invocation.input_tokens, 0),
        cachedTokens: finite(invocation.cached_tokens, 0),
        outputTokens: finite(invocation.output_tokens, 0),
      },
      costUsd: finite(invocation.cost_usd, 0),
      durationMs: finite(invocation.ms, 0),
      outcome: clampText(invocation.outcome || 'unknown', 80),
      error: safeError(invocation.error),
      diagnostic: diagnostic(invocation.error),
      summary: counts,
      steps: invocationSteps,
      toolCalls: invocationCalls,
    };
  });

  return {
    generatedAt: Date.now(),
    invocations: traceInvocations,
    // These are gateway diagnostics run from the dashboard, not model-issued
    // Carvis calls. Keeping them separate prevents a manual test looking like
    // the agent made the request itself.
    unattachedToolCalls: unattachedToolCalls.sort((a, b) => b.at - a.at),
  };
}
