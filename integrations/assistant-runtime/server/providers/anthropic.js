/**
 * Claude, via the official SDK.
 *
 * Three model-family rules are enforced here rather than left to the caller,
 * because getting them wrong is a 400 rather than a degraded answer:
 *
 *  - `temperature` is rejected outright by Opus 5, Sonnet 5, Opus 4.7/4.8 and
 *    Fable 5. Omitting it is always valid, so we omit by default and only send
 *    it to the older models that still accept it.
 *  - `effort` is how you control spend on the models that have it, and an error
 *    on the ones that do not (Sonnet 4.5, Haiku 4.5).
 *  - Thinking is on by default on Opus 5 and we leave it that way. Disabling it
 *    is the documented cause of `<thinking>` tags leaking into visible text;
 *    dropping to a lower effort is the cheaper lever and has no such failure.
 */
import Anthropic from '@anthropic-ai/sdk';

import { prepareTools, fromWireName } from './names.js';

/** Older families that still accept sampling parameters. Everything else omits. */
const ACCEPTS_SAMPLING =
  /^claude-(opus-4-6|opus-4-5|opus-4-1|opus-4-0|sonnet-4-6|sonnet-4-5|sonnet-4-0|haiku-4-5|3-)/;

/** Families with an `effort` control. Sending it elsewhere errors. */
const ACCEPTS_EFFORT =
  /^claude-(fable-5|mythos-5|opus-5|opus-4-8|opus-4-7|opus-4-6|opus-4-5|sonnet-5|sonnet-4-6)/;

/** Families whose safety classifiers can decline a request outright. */
const CAN_REFUSE = /^claude-(fable-5|mythos-5|opus-5|sonnet-5)/;

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const clients = new Map(); // apiKey (or '') -> Anthropic
/** Set once we learn this account cannot use the server-side fallback beta. */
let fallbackBetaUnavailable = false;

/**
 * The SDK's own "could not resolve authentication method" is accurate and
 * completely unhelpful on a 576x288 display, so it is translated here into the
 * one sentence that says what to actually do.
 */
export function authHint(provider) {
  const envName = provider.apiKeyEnv || 'ANTHROPIC_API_KEY';
  return `No Claude credentials. Put ${envName}=sk-ant-… in the .env file next to config.json, then restart Carvis.`;
}

function isAuthProblem(err) {
  return err?.status === 401 || /could not resolve authentication|authentication_error|x-api-key/i.test(String(err?.message || ''));
}

function rethrow(provider, err) {
  if (isAuthProblem(err)) {
    const wrapped = new Error(authHint(provider));
    wrapped.cause = err;
    throw wrapped;
  }
  throw err;
}

function clientFor(provider) {
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] || '' : '';
  const cacheKey = `${key}|${provider.baseUrl || ''}`;
  if (clients.has(cacheKey)) return clients.get(cacheKey);

  // A bare constructor is not a fallback — it resolves ANTHROPIC_API_KEY,
  // ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile on its own, so an
  // unset env var does not mean there are no credentials.
  const client = new Anthropic({
    ...(key ? { apiKey: key } : {}),
    ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    maxRetries: 2,
  });
  clients.set(cacheKey, client);
  return client;
}

function buildParams({ model, system, messages, schema, maxTokens, temperature, effort }) {
  const params = {
    model,
    max_tokens: maxTokens ?? 4096,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };

  if (system) {
    // The system prompt is the stable prefix and the live world is not, so the
    // breakpoint goes here — everything after it changes every turn.
    params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  const outputConfig = {};
  if (effort && ACCEPTS_EFFORT.test(model)) outputConfig.effort = effort;
  if (schema) outputConfig.format = { type: 'json_schema', schema };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;

  if (Number.isFinite(temperature) && ACCEPTS_SAMPLING.test(model)) {
    params.temperature = temperature;
  }
  return params;
}

/** Text of every text block, joined. Refusals are surfaced, never returned as ''. */
function readText(message, model) {
  if (message.stop_reason === 'refusal') {
    const why = message.stop_details?.category || 'unspecified';
    throw new Error(`${model} declined this request (${why})`);
  }
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * One call. With `schema` the reply is constrained to it and returned parsed.
 * Retries once without the fallback beta if this account cannot use it, so a
 * missing beta degrades to "no automatic fallback" rather than to "broken".
 */
export async function complete(provider, opts) {
  const started = Date.now();
  const params = buildParams(opts);
  const client = clientFor(provider);
  const timeout = (opts.timeoutSec ?? 120) * 1000;
  const wantFallback = opts.fallbacks !== false && CAN_REFUSE.test(opts.model) && !fallbackBetaUnavailable;

  let message;
  try {
    if (wantFallback) {
      try {
        message = await client.beta.messages.create(
          { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' },
          { timeout },
        );
      } catch (err) {
        if (!isBetaRejection(err)) throw err;
        fallbackBetaUnavailable = true;
        message = await client.messages.create(params, { timeout });
      }
    } else {
      message = await client.messages.create(params, { timeout });
    }
  } catch (err) {
    rethrow(provider, err);
  }

  const text = readText(message, opts.model);
  return {
    text,
    json: opts.schema ? parseJson(text, opts.model) : null,
    ms: Date.now() - started,
    model: message.model || opts.model,
    stopReason: message.stop_reason,
    usage: message.usage,
  };
}

/**
 * One round of the agent loop.
 *
 * Returns the normalized shape every provider here speaks, so `carvis.js` runs
 * the same loop whether the reasoning is happening at Anthropic, at OpenAI, or
 * on this Mac:
 *
 *   { text, toolCalls: [{id, name, arguments}], stopReason, usage }
 */
export async function invokeWithTools(provider, opts) {
  const started = Date.now();
  const client = clientFor(provider);
  const params = buildParams({ ...opts, maxTokens: opts.maxTokens ?? 4096 });

  params.messages = opts.messages.map(toAnthropicMessage);

  const { wire, fromWire } = prepareTools(opts.tools);
  if (wire.length) {
    params.tools = wire.map((tool) => ({
      name: tool.wireName,
      description: tool.description,
      input_schema: tool.schema,
    }));
  }
  // Structured output and tools are mutually exclusive here; the loop uses tools.
  if (params.output_config?.format) delete params.output_config.format;

  let message;
  try {
    message = await client.messages.create(params, { timeout: (opts.timeoutSec ?? 120) * 1000 });
  } catch (err) {
    rethrow(provider, err);
  }

  if (message.stop_reason === 'refusal') {
    throw new Error(`${opts.model} declined this request (${message.stop_details?.category || 'unspecified'})`);
  }

  const text = (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const toolCalls = (message.content || [])
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: fromWire.get(b.name) || fromWireName(b.name), arguments: b.input || {} }));

  return {
    text,
    toolCalls,
    stopReason: message.stop_reason,
    // Kept so the assistant turn can be replayed verbatim next round, which
    // preserves the cached prefix and any thinking blocks.
    raw: message.content,
    usage: {
      input: message.usage?.input_tokens ?? 0,
      cachedInput: message.usage?.cache_read_input_tokens ?? 0,
      output: message.usage?.output_tokens ?? 0,
    },
    ms: Date.now() - started,
    model: message.model || opts.model,
  };
}

function toAnthropicMessage(message) {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          ...(message.isError ? { is_error: true } : {}),
        },
      ],
    };
  }
  // Replay the original blocks when we have them; rebuilding from text alone
  // would drop the tool_use blocks the next turn has to match against.
  if (message.role === 'assistant' && message.raw) {
    return { role: 'assistant', content: message.raw };
  }
  return { role: message.role, content: message.content };
}

/** Streamed text chunks. Used by chat, where an 8s wait reads as broken. */
export async function* stream(provider, opts) {
  const params = buildParams({ ...opts, maxTokens: opts.maxTokens ?? 8192 });
  const client = clientFor(provider);

  let running;
  try {
    running = client.messages.stream(params, { timeout: (opts.timeoutSec ?? 180) * 1000 });
    for await (const event of running) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  } catch (err) {
    rethrow(provider, err);
  }

  // Surfaces a refusal that arrived with no text at all, which would otherwise
  // look to the caller like a successful empty answer.
  const final = await running.finalMessage();
  opts.onUsage?.({
    input: final.usage?.input_tokens ?? 0,
    cachedInput: final.usage?.cache_read_input_tokens ?? 0,
    output: final.usage?.output_tokens ?? 0,
  }, final.model || opts.model);
  if (final.stop_reason === 'refusal') {
    throw new Error(`${opts.model} declined this request (${final.stop_details?.category || 'unspecified'})`);
  }
}

function isBetaRejection(err) {
  const msg = String(err?.message || '');
  return err?.status === 400 && /beta|fallback/i.test(msg);
}

function parseJson(text, model) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${model} returned non-JSON: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

/** What the Models tab offers in the dropdown. */
export async function listModels(provider) {
  const client = clientFor(provider);
  const out = [];
  try {
    for await (const m of client.models.list()) {
      out.push({ name: m.id, label: m.display_name || m.id, context: m.max_input_tokens });
    }
  } catch (err) {
    rethrow(provider, err);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
