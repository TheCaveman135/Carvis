/**
 * The model registry.
 *
 * Every model call in Carvis names a *role*, never a model. The role is what
 * the job is; the config says which provider and model currently serve it.
 * That indirection is the point: the per-utterance triage can sit on a local
 * model and cost nothing, while the parts that actually answer you sit on a
 * frontier model — and either can move without touching a caller.
 */
import { randomUUID } from 'node:crypto';

import * as anthropic from './providers/anthropic.js';
import * as ollama from './providers/ollama.js';
import * as openai from './providers/openai.js';
import { MODEL_ROLES } from './config.js';
import { recordInvocation } from './db.js';

const KINDS = { anthropic, ollama, openai };

export class RoleUnconfigured extends Error {
  constructor(role, reason) {
    super(`Role "${role}" is not ready: ${reason}`);
    this.role = role;
  }
}

/** Provider + model + knobs currently serving `role`. Throws if unusable. */
export function resolve(cfg, role) {
  const binding = cfg.models?.roles?.[role];
  if (!binding) throw new RoleUnconfigured(role, 'no binding in config');

  const provider = cfg.models.providers.find((p) => p.id === binding.provider);
  if (!provider) throw new RoleUnconfigured(role, `provider "${binding.provider}" no longer exists`);
  if (!KINDS[provider.kind]) throw new RoleUnconfigured(role, `unknown provider kind "${provider.kind}"`);
  if (!binding.model) throw new RoleUnconfigured(role, `no model chosen for ${provider.label}`);

  return {
    provider,
    impl: KINDS[provider.kind],
    model: binding.model,
    temperature: binding.temperature,
    effort: binding.effort,
    maxTokens: binding.maxTokens,
    // Ollama-only knobs, harmlessly ignored by the others.
    numCtx: cfg.ollama?.numCtx,
    keepAlive: cfg.ollama?.keepAlive,
    timeoutSec: binding.timeoutSec ?? cfg.ollama?.timeoutSec ?? 120,
  };
}

function callOpts(bound, opts) {
  return {
    model: bound.model,
    system: opts.system,
    messages: opts.messages,
    schema: opts.schema,
    maxTokens: opts.maxTokens ?? bound.maxTokens,
    temperature: opts.temperature ?? bound.temperature,
    effort: opts.effort ?? bound.effort,
    numCtx: bound.numCtx,
    keepAlive: bound.keepAlive,
    timeoutSec: opts.timeoutSec ?? bound.timeoutSec,
  };
}

/**
 * One call for `role`. Pass `schema` and the answer comes back parsed and
 * shape-checked by the provider rather than by a regex here.
 *
 * Cost-recorded the same as `invokeWithTools`, not just for symmetry: triage
 * runs on every overheard utterance and the HUD reply-rewrite on nearly every
 * acted turn, both often on a paid role — leaving this path unrecorded made
 * that spend invisible to the Cost dashboard by construction, not merely
 * undercounted.
 */
export async function complete(cfg, role, opts) {
  const bound = resolve(cfg, role);
  const started = Date.now();
  let result;
  try {
    result = await bound.impl.complete(bound.provider, callOpts(bound, opts));
  } catch (err) {
    // GPT-5 Nano can occasionally spend its completion budget on internal
    // work and return an empty strict-JSON body. This is not a malformed owner
    // request and should not make voice/classifier look broken. Retry exactly
    // once, only for that empty OpenAI structured result, with room to emit
    // the tiny schema. Other provider/schema failures remain visible.
    const blankStructuredOpenAi =
      bound.provider.kind === 'openai' &&
      Boolean(opts.schema) &&
      /returned non-JSON:\s*$/i.test(String(err?.message || ''));
    if (!blankStructuredOpenAi) throw err;
    const retryTokens = Math.max(4096, Number(opts.maxTokens) || 0, Number(bound.maxTokens) || 0);
    result = await bound.impl.complete(bound.provider, callOpts(bound, { ...opts, maxTokens: retryTokens }));
  }
  const costUsd = estimateCost(cfg, bound.provider, result.model || bound.model, result.usage);
  try {
    recordInvocation({
      id: `inv_${randomUUID().slice(0, 12)}`,
      ts: started,
      triggerType: 'internal',
      trigger: { type: 'internal', role },
      role,
      provider: bound.provider.id,
      model: result.model || bound.model,
      promptVersion: '',
      rounds: 0,
      inputTokens: result.usage?.input ?? 0,
      cachedTokens: result.usage?.cachedInput ?? 0,
      outputTokens: result.usage?.output ?? 0,
      costUsd,
      ms: Date.now() - started,
      outcome: 'ok',
    });
  } catch (err) {
    // Cost visibility must never break an otherwise-successful completion.
  }
  return { ...result, role, provider: bound.provider.id, costUsd };
}

/** Streamed text for `role`. */
export async function* stream(cfg, role, opts) {
  const bound = resolve(cfg, role);
  const started = Date.now();
  const invocationId = `inv_${randomUUID().slice(0, 12)}`;
  let usage = {};
  let model = bound.model;
  let outcome = 'ok';
  let error = null;
  try {
    yield* bound.impl.stream(bound.provider, {
      ...callOpts(bound, opts),
      onUsage: (reported, reportedModel) => {
        usage = reported || {};
        model = reportedModel || model;
      },
    });
  } catch (err) {
    outcome = 'error';
    error = err.message;
    throw err;
  } finally {
    try {
      recordInvocation({
        id: invocationId,
        ts: started,
        triggerType: 'internal',
        trigger: { type: 'internal', role, streamed: true },
        role,
        provider: bound.provider.id,
        model,
        promptVersion: '',
        rounds: 0,
        inputTokens: usage.input ?? 0,
        cachedTokens: usage.cachedInput ?? 0,
        outputTokens: usage.output ?? 0,
        costUsd: estimateCost(cfg, bound.provider, model, usage),
        ms: Date.now() - started,
        outcome,
        error,
      });
    } catch {
      // Accounting remains observational and must not break the chat stream.
    }
  }
}

/**
 * One round of the agent loop for `role`. Normalized across providers, so
 * `carvis.js` never learns which vendor it is talking to.
 */
export async function invokeWithTools(cfg, role, opts) {
  const bound = resolve(cfg, role);
  if (typeof bound.impl.invokeWithTools !== 'function') {
    throw new RoleUnconfigured(role, `${bound.provider.label} cannot do tool calling`);
  }
  const result = await bound.impl.invokeWithTools(bound.provider, {
    ...callOpts(bound, opts),
    tools: opts.tools,
  });
  return {
    ...result,
    role,
    provider: bound.provider.id,
    costUsd: estimateCost(cfg, bound.provider, result.model || bound.model, result.usage),
  };
}

/**
 * What a call cost, from the rates in config. Cache reads bill at roughly a
 * tenth of fresh input on both vendors, which matters here because the system
 * prompt is cached and is most of the prefix.
 */
export function estimateCost(cfg, provider, model, usage) {
  if (!usage) return 0;
  if (provider.local) return 0;

  const pricing = cfg.models?.pricing || {};
  const rate =
    pricing[model] ||
    // Dated ids like claude-haiku-4-5-20251001 should match their base entry.
    pricing[Object.keys(pricing).find((key) => key !== 'ollama:*' && model.startsWith(key)) || ''] ||
    null;
  if (!rate) return 0;

  const fresh = Math.max(0, (usage.input ?? 0) - (usage.cachedInput ?? 0));
  return (
    (fresh / 1e6) * rate.input +
    ((usage.cachedInput ?? 0) / 1e6) * rate.input * 0.1 +
    ((usage.output ?? 0) / 1e6) * rate.output
  );
}

export async function listModels(cfg, providerId) {
  const provider = cfg.models.providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`no provider "${providerId}"`);
  const impl = KINDS[provider.kind];
  if (!impl) throw new Error(`unknown provider kind "${provider.kind}"`);
  return impl.listModels(provider);
}

/**
 * Per-role readiness for the Models tab, so a misrouted role is visible before
 * it fails mid-turn rather than after.
 */
export function roleStatus(cfg) {
  return Object.entries(MODEL_ROLES).map(([role, purpose]) => {
    const binding = cfg.models?.roles?.[role] || {};
    let ready = true;
    let problem = '';
    try {
      resolve(cfg, role);
    } catch (err) {
      ready = false;
      problem = err.message;
    }
    const provider = cfg.models.providers.find((p) => p.id === binding.provider);
    return {
      role,
      purpose,
      provider: binding.provider,
      providerLabel: provider?.label || binding.provider,
      kind: provider?.kind || '',
      model: binding.model || '',
      effort: binding.effort || '',
      // `local` is the provider's own explicit flag, not inferred from `kind`
      // — kind is a wire protocol (Ollama, OpenAI-shaped, Anthropic), and a
      // real billed OpenAI account shares `kind: 'openai'` with a local LM
      // Studio server. Conflating the two is how a cloud-bound role used to
      // render as "Everything is local. Nothing leaves this Mac."
      local: provider?.local === true,
      ready,
      problem,
    };
  });
}

/** True when at least one role is bound to a provider that bills per token. */
export function usesCloud(cfg) {
  return roleStatus(cfg).some((r) => !r.local && r.ready);
}
