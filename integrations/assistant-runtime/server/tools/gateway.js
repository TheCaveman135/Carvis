import { toolEnabled, toolFeature } from '../features.js';
/**
 * The Tool Gateway.
 *
 * Every action Carvis takes goes through here. The model never touches an
 * adapter, a REST client, or a database — it emits a name and an arguments
 * object, and this decides whether that becomes anything.
 *
 *   tool call → schema validation → risk check → execute → audit → result
 *
 * The reason this is one chokepoint rather than a convention is that a model
 * is an untrusted argument source. It is not malicious, but it is fallible and
 * it can be talked into things by anything it reads — including a sentence
 * your microphone picked up from a podcast. Validation and authorization have
 * to live somewhere the model cannot reason its way around, which means code,
 * not the system prompt.
 */
import { randomUUID } from 'node:crypto';

import { recordToolCall, claimIdempotency, completeIdempotency, releaseIdempotency } from '../db.js';
import { log } from '../log.js';

/**
 * Risk levels, from the spec. The number is what the permission policy gates
 * on; the descriptions are what the Tools tab shows you.
 */
export const RISK = {
  READ: 0, // read state, search, list
  LOW: 1, // lights, media, HUD, scenes — reversible in one action
  MEDIUM: 2, // thermostat, printers, Mac control, Atlas writes
  SENSITIVE: 3, // locks, garage, alarm, sending messages
  CRITICAL: 4, // purchases, irreversible deletion, money
};

export const RISK_NAMES = ['read', 'low', 'medium', 'sensitive', 'critical'];

export class ToolError extends Error {
  constructor(message, code = 'tool_error') {
    super(message);
    this.code = code;
  }
}

export class ToolGateway {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.tools = new Map();
  }

  register(tool) {
    if (!tool?.name) throw new Error('a tool needs a name');
    if (typeof tool.execute !== 'function') throw new Error(`tool ${tool.name} has no execute()`);
    const risk = tool.risk ?? RISK.READ;
    // The dedup shortcut in call() returns a cached result without ever
    // calling execute() — which means it also skips guards.js's per-call
    // re-validation of wake word / confirmed / reason. Fine for a Standard
    // Atlas write; not fine for anything that could touch a lock or an
    // alarm. Loud at registration time so this can't become a silent
    // regression later.
    if (tool.idempotent && risk >= RISK.SENSITIVE) {
      throw new Error(
        `tool ${tool.name} cannot be idempotent at ${RISK_NAMES[risk]} risk — the dedup shortcut bypasses guards.js entirely`,
      );
    }
    this.tools.set(tool.name, { risk: RISK.READ, schema: emptySchema(), ...tool });
    return this;
  }

  registerAll(tools) {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name) {
    return this.tools.get(name);
  }

  /**
   * Schemas to hand the model. `names` narrows the set — the spec's §49 point
   * that 150 schemas on every request is mostly wasted tokens.
   */
  definitions(names = null) {
    const wanted = names ? new Set(names) : null;
    return [...this.tools.values()]
      .filter((tool) => (!wanted || wanted.has(tool.name)) && toolEnabled(this.getConfig(), tool.name) && (!tool.available || tool.available()))
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        schema: tool.schema,
      }));
  }

  /** Ceiling for this trigger. Speech you asked for gets more rope than a timer. */
  maxRiskFor(triggerType) {
    const cfg = this.getConfig().tools || {};
    const byTrigger = cfg.maxRiskByTrigger || {};
    const fallback = cfg.maxRisk ?? RISK.MEDIUM;
    return byTrigger[triggerType] ?? fallback;
  }

  /**
   * Run one tool call.
   *
   * Never throws for an ordinary failure: the model is supposed to read the
   * result and adapt, and an exception it cannot see just ends the turn. Only
   * programming errors escape.
   */
  async call(name, rawArgs, ctx = {}) {
    if (this.isCancelled?.(ctx.integrationRequestId)) return {success:false,cancelled:true,error:'Request cancelled before dispatch.'};
    const started = Date.now();
    const callId = `call_${randomUUID().slice(0, 10)}`;
    const tool = this.tools.get(name);

    if (!tool) {
      const result = { success: false, error: `no such tool: ${name}` };
      this.#audit({ callId, ctx, name, args: rawArgs, risk: RISK.CRITICAL, authorization: 'unknown_tool', ok: false, started, error: result.error });
      return result;
    }

    if (!toolEnabled(this.getConfig(), name, ctx) || (tool.available && !tool.available())) {
      const result = {success:false,error:`The ${toolFeature(name)} integration is disabled or this tool is unavailable.`};
      this.#audit({callId,ctx,name,args:rawArgs,risk:tool.risk,authorization:'integration_disabled',ok:false,started,error:result.error});
      return result;
    }
    // 1. Shape. A tool must never see arguments it did not ask for.
    const validation = validate(rawArgs ?? {}, tool.schema);
    if (!validation.ok) {
      const result = { success: false, error: `invalid arguments: ${validation.error}` };
      this.#audit({ callId, ctx, name, args: rawArgs, risk: tool.risk, authorization: 'invalid_arguments', ok: false, started, error: validation.error });
      return result;
    }
    const args = validation.value;

    // 2. Authorization. Checked here, never in the prompt.
    const ceiling = this.maxRiskFor(ctx.triggerType || 'user_voice');
    if (tool.risk > ceiling) {
      const result = {
        success: false,
        error: `"${name}" is a ${RISK_NAMES[tool.risk]}-risk action; ${ctx.triggerType || 'this trigger'} is limited to ${RISK_NAMES[ceiling]}. Tell the user you are not permitted to do this rather than trying another way.`,
      };
      log('warn', `Blocked ${name} (risk ${tool.risk} > ceiling ${ceiling} for ${ctx.triggerType})`);
      this.#audit({ callId, ctx, name, args, risk: tool.risk, authorization: 'denied_risk', ok: false, started, error: result.error });
      return result;
    }

    // 3. Idempotency, for the things a retried watch must not do twice.
    let idempotencyKey = null;
    if (tool.idempotent && ctx.idempotencyPrefix) {
      idempotencyKey = `${ctx.idempotencyPrefix}:${name}:${stableKey(args)}`;
      const claim = claimIdempotency(idempotencyKey);
      if (claim?.done) {
        log('info', `Skipped duplicate ${name} (already done for ${ctx.idempotencyPrefix})`);
        // No forced success:true here — dedupe replays whatever the original
        // attempt actually recorded, success or failure, rather than
        // reporting a failed attempt back as a successful no-op.
        const result = { ...claim.result, deduplicated: true };
        // It is still an attempted gateway call. Auditing it prevents a trace
        // from looking like the model silently skipped an action.
        this.#audit({
          callId,
          ctx,
          name,
          args,
          risk: tool.risk,
          authorization: 'deduplicated',
          ok: result.success !== false,
          started,
          result,
        });
        return result;
      }
      if (claim?.inFlight) {
        const result = { success: false, error: `a previous attempt for "${name}" is still in flight`, deduplicated: false };
        this.#audit({ callId, ctx, name, args, risk: tool.risk, authorization: 'in_flight', ok: false, started, error: result.error });
        return result;
      }
    }

    // 4. Execute.
    try {
      const result = await tool.execute(args, ctx);
      const normalized = result && typeof result === 'object' ? result : { success: true, result };
      if (normalized.success === undefined) normalized.success = true;
      if (idempotencyKey) {
        // A failure releases the claim rather than completing it — a stuck
        // NULL-result row would otherwise be indistinguishable from "already
        // done" the next time this exact call is retried.
        if (normalized.success) completeIdempotency(idempotencyKey, normalized);
        else releaseIdempotency(idempotencyKey);
      }
      this.#audit({ callId, ctx, name, args, risk: tool.risk, authorization: 'allowed', ok: normalized.success !== false, started, result: normalized });
      return normalized;
    } catch (err) {
      if (idempotencyKey) releaseIdempotency(idempotencyKey);
      // Adapters throw; the model needs to be told rather than cut off.
      const result = { success: false, error: err.message };
      this.#audit({ callId, ctx, name, args, risk: tool.risk, authorization: 'allowed', ok: false, started, error: err.message });
      return result;
    }
  }

  #audit({ callId, ctx, name, args, risk, authorization, ok, started, result, error }) {
    try {
      recordToolCall({
        id: callId,
        invocationId: ctx.invocationId ?? null,
        ts: started,
        tool: name,
        arguments: args,
        risk,
        authorization,
        result: result ?? null,
        ok,
        ms: Date.now() - started,
        error: error ?? null,
        // Carvis supplies this only for model-issued calls. Dashboard/manual
        // diagnostics intentionally remain unattached to a model round.
        round: ctx.traceRound ?? null,
      });
    } catch (err) {
      log('warn', `Could not audit tool call: ${err.message}`);
    }
  }

  /** For the Tools tab: what exists, at what risk, and reachable by whom. */
  inventory() {
    return [...this.tools.values()]
      .filter(tool => toolEnabled(this.getConfig(), tool.name) && (!tool.available || tool.available()))
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        risk: tool.risk,
        riskName: RISK_NAMES[tool.risk],
        idempotent: Boolean(tool.idempotent),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/* ── validation ──────────────────────────────────────────────── */

function emptySchema() {
  return { type: 'object', additionalProperties: false, properties: {}, required: [] };
}

/**
 * A small JSON Schema subset — enough for every tool here, and deliberately
 * strict: unknown properties are an error rather than being dropped, because a
 * model inventing `{"entity_id": ..., "force": true}` should be told the
 * argument does not exist, not silently obeyed minus the part it made up.
 */
export function validate(value, schema, path = '') {
  const where = path || 'arguments';

  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `${where} must be an object` };
    }
    const out = {};
    const properties = schema.properties || {};

    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null || value[key] === '') {
        // Empty string counts as missing: models fill required string fields
        // with "" rather than omitting them, and an empty entity id is not a
        // value any tool can use.
        return { ok: false, error: `${where}.${key} is required` };
      }
    }

    for (const [key, raw] of Object.entries(value)) {
      const sub = properties[key];
      if (!sub) {
        if (schema.additionalProperties === false) {
          return { ok: false, error: `${where}.${key} is not a valid argument` };
        }
        out[key] = raw;
        continue;
      }
      if (raw === undefined || raw === null) continue;
      const checked = validate(raw, sub, `${where}.${key}`);
      if (!checked.ok) return checked;
      out[key] = checked.value;
    }
    return { ok: true, value: out };
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return { ok: false, error: `${where} must be an array` };
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return { ok: false, error: `${where} needs at least ${schema.minItems} items` };
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return { ok: false, error: `${where} allows at most ${schema.maxItems} items` };
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map(stableKey));
      if (seen.size !== value.length) return { ok: false, error: `${where} cannot contain duplicate items` };
    }
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const checked = validate(value[i], schema.items || {}, `${where}[${i}]`);
      if (!checked.ok) return checked;
      out.push(checked.value);
    }
    return { ok: true, value: out };
  }

  if (schema.enum && !schema.enum.includes(value)) {
    return { ok: false, error: `${where} must be one of: ${schema.enum.join(', ')}` };
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: `${where} must be a string` };
    if (schema.maxLength && value.length > schema.maxLength) {
      return { ok: true, value: value.slice(0, schema.maxLength) };
    }
    return { ok: true, value };
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    let num = Number(value);
    if (!Number.isFinite(num)) return { ok: false, error: `${where} must be a number` };
    if (schema.type === 'integer' && !Number.isInteger(num)) {
      num = Math.round(num);
    }
    if (schema.minimum !== undefined && num < schema.minimum) {
      return { ok: false, error: `${where} must be at least ${schema.minimum}` };
    }
    if (schema.maximum !== undefined && num > schema.maximum) {
      return { ok: false, error: `${where} must be at most ${schema.maximum}` };
    }
    return { ok: true, value: num };
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: `${where} must be true or false` };
    return { ok: true, value };
  }

  return { ok: true, value };
}

/** Order-independent key so `{a,b}` and `{b,a}` dedupe to the same thing. */
function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${k}:${stableKey(value[k])}`)
    .join(',')}}`;
}
