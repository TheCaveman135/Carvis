/**
 * Any OpenAI-compatible /v1/chat/completions endpoint — LM Studio, llama.cpp,
 * vLLM, a router. Raw fetch, because this is deliberately the generic slot and
 * carrying a second vendor SDK to talk to a local server buys nothing.
 */
import { prepareTools, fromWireName } from './names.js';

function headers(provider) {
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '';
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

function toMessages(system, messages) {
  return system ? [{ role: 'system', content: system }, ...messages] : messages;
}

function url(provider, path) {
  return `${(provider.baseUrl || '').replace(/\/+$/, '')}${path}`;
}

/**
 * The GPT-5.x tiers do not take `temperature`, the same way the current Claude
 * models do not. Omitting it is always valid, so it is omitted for anything
 * that looks like one rather than discovered as a 400 at 2am.
 */
const REJECTS_SAMPLING = /^gpt-5/;

function sampling(model, temperature) {
  if (!Number.isFinite(temperature) || REJECTS_SAMPLING.test(model)) return {};
  return { temperature };
}

export async function complete(provider, opts) {
  const started = Date.now();
  const body = {
    model: opts.model,
    messages: toMessages(opts.system, opts.messages),
    stream: false,
    max_completion_tokens: opts.maxTokens ?? 2048,
    // Classification still uses the same reasoning model and strict schema;
    // `low` just prevents a four-field routing decision from spending seconds
    // on deep internal work. Restrict this Chat Completions field to GPT-5
    // models so a local OpenAI-compatible provider never receives a knob it
    // does not implement.
    ...(opts.effort && /^gpt-5/.test(opts.model) ? { reasoning_effort: opts.effort } : {}),
    ...sampling(opts.model, opts.temperature),
  };
  if (opts.schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema: opts.schema },
    };
  }

  const res = await fetch(url(provider, '/chat/completions'), {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((opts.timeoutSec ?? 120) * 1000),
  });
  if (!res.ok) throw new Error(`${provider.label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const text = String(data.choices?.[0]?.message?.content ?? '').trim();
  return {
    text,
    json: opts.schema ? parseJson(text, provider.label) : null,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      cachedInput: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
    ms: Date.now() - started,
    model: data.model || opts.model,
  };
}

/**
 * The GPT-5.x models refuse function tools on `/v1/chat/completions` unless
 * reasoning is switched off entirely:
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-luna
 *    in /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 *
 * Turning reasoning off to keep the simpler endpoint would trade away the
 * thing that makes the agent loop work, so tool calls go to `/v1/responses`
 * instead. Everything else — LM Studio, llama.cpp, a router — stays on chat
 * completions, which is all those speak.
 */
function usesResponsesApi(provider, model) {
  if (provider.api === 'chat') return false;
  if (provider.api === 'responses') return true;
  return /^gpt-5/.test(model) && /(^|\.)openai\.com/.test(provider.baseUrl || '');
}

/** One round of the agent loop, in the shape `carvis.js` expects. */
export async function invokeWithTools(provider, opts) {
  return usesResponsesApi(provider, opts.model)
    ? viaResponses(provider, opts)
    : viaChatCompletions(provider, opts);
}

async function post(provider, path, body, timeoutSec) {
  const res = await fetch(url(provider, path), {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((timeoutSec ?? 120) * 1000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    if (res.status === 401) {
      throw new Error(
        `No OpenAI credentials. Put ${provider.apiKeyEnv || 'OPENAI_API_KEY'}=sk-… in the .env file next to config.json, then restart Carvis.`,
      );
    }
    throw new Error(`${provider.label} HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

/** `/v1/responses` — reasoning models with tools. */
async function viaResponses(provider, opts) {
  const started = Date.now();
  const { wire, fromWire } = prepareTools(opts.tools);

  const body = {
    model: opts.model,
    input: opts.messages.flatMap(toResponsesItem),
    max_output_tokens: opts.maxTokens ?? 4096,
    ...(opts.system ? { instructions: opts.system } : {}),
    // The tier is chosen by role; `effort` is the knob the spec asks for.
    ...(opts.effort ? { reasoning: { effort: opts.effort } } : {}),
  };
  if (wire.length) {
    // Flat here, unlike chat completions where it nests under `function`.
    body.tools = wire.map((tool) => ({
      type: 'function',
      name: tool.wireName,
      description: tool.description,
      parameters: tool.schema,
      strict: false, // Preserve optional fields; Responses otherwise normalizes them into required inputs.
    }));
  }

  const data = await post(provider, '/responses', body, opts.timeoutSec);
  const output = data.output || [];

  const toolCalls = output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      id: item.call_id,
      name: fromWire.get(item.name) || fromWireName(item.name),
      arguments: safeParse(item.arguments),
    }));

  const text = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((block) => block.type === 'output_text')
    .map((block) => block.text)
    .join('')
    .trim();

  return {
    text,
    toolCalls,
    stopReason: toolCalls.length ? 'tool_use' : data.status || 'completed',
    // The whole output array is replayed next round. Reasoning items have to
    // travel with their function calls or the model loses its own train of
    // thought between rounds.
    raw: output,
    usage: {
      input: data.usage?.input_tokens ?? 0,
      cachedInput: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    },
    ms: Date.now() - started,
    model: data.model || opts.model,
  };
}

function toResponsesItem(message) {
  if (message.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      },
    ];
  }
  // Replay the previous turn's output items verbatim, reasoning included.
  if (message.role === 'assistant' && Array.isArray(message.raw)) return message.raw;
  return [{ role: message.role, content: message.content }];
}

/** `/v1/chat/completions` — everything that is not a GPT-5.x reasoning model. */
async function viaChatCompletions(provider, opts) {
  const started = Date.now();
  const { wire, fromWire } = prepareTools(opts.tools);

  const body = {
    model: opts.model,
    messages: toMessages(opts.system, opts.messages.map(toOpenAiMessage)),
    stream: false,
    max_completion_tokens: opts.maxTokens ?? 4096,
    ...sampling(opts.model, opts.temperature),
  };
  if (wire.length) {
    body.tools = wire.map((tool) => ({
      type: 'function',
      function: { name: tool.wireName, description: tool.description, parameters: tool.schema },
    }));
  }

  const data = await post(provider, '/chat/completions', body, opts.timeoutSec);
  const choice = data.choices?.[0]?.message || {};
  const toolCalls = (choice.tool_calls || []).map((call) => ({
    id: call.id,
    name: fromWire.get(call.function?.name) || fromWireName(call.function?.name),
    // Arguments arrive as a JSON string; a malformed one is the model's mistake
    // to hear about, not an exception that ends the turn.
    arguments: safeParse(call.function?.arguments),
  }));

  return {
    text: String(choice.content || '').trim(),
    toolCalls,
    stopReason: data.choices?.[0]?.finish_reason,
    raw: choice,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      cachedInput: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
    ms: Date.now() - started,
    model: data.model || opts.model,
  };
}

function toOpenAiMessage(message) {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    };
  }
  if (message.role === 'assistant' && message.raw) return message.raw;
  return { role: message.role, content: message.content };
}

function safeParse(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

export async function* stream(provider, opts) {
  const res = await fetch(url(provider, '/chat/completions'), {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify({
      model: opts.model,
      messages: toMessages(opts.system, opts.messages),
      stream: true,
      ...(!provider.local ? { stream_options: { include_usage: true } } : {}),
      max_completion_tokens: opts.maxTokens ?? 4096,
      ...sampling(opts.model, opts.temperature),
    }),
    signal: AbortSignal.timeout((opts.timeoutSec ?? 180) * 1000),
  });
  if (!res.ok) throw new Error(`${provider.label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj.usage) {
        opts.onUsage?.({
          input: obj.usage.prompt_tokens ?? 0,
          cachedInput: obj.usage.prompt_tokens_details?.cached_tokens ?? 0,
          output: obj.usage.completion_tokens ?? 0,
        }, obj.model || opts.model);
      }
      const chunk = obj.choices?.[0]?.delta?.content;
      if (chunk) yield chunk;
    }
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${label} returned non-JSON: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

export async function listModels(provider) {
  const res = await fetch(url(provider, '/models'), {
    headers: headers(provider),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${provider.label} HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || [])
    .map((m) => ({ name: m.id, label: m.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
