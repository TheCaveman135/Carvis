/**
 * Adapter putting the existing Ollama client behind the registry's interface.
 * The transport lives in ../ollama.js and is shared with scripts/eval.mjs, so
 * the eval keeps scoring the same code path production runs.
 */
import { askJson, chatStream, listModels as listOllamaModels } from '../ollama.js';
import { prepareTools, fromWireName } from './names.js';

function toMessages(system, messages) {
  return system ? [{ role: 'system', content: system }, ...messages] : messages;
}

export async function complete(provider, opts) {
  const started = Date.now();
  const base = {
    baseUrl: provider.baseUrl,
    model: opts.model,
    messages: toMessages(opts.system, opts.messages),
    temperature: opts.temperature,
      numCtx: opts.numCtx,
      maxTokens: opts.maxTokens,
      timeoutSec: opts.timeoutSec,
    keepAlive: opts.keepAlive,
  };

  if (opts.schema) {
    const json = await askJson({ ...base, schema: opts.schema });
    return { text: JSON.stringify(json), json, ms: Date.now() - started, model: opts.model };
  }

  let text = '';
  for await (const chunk of chatStream({ ...base, think: false })) text += chunk;
  return { text: text.trim(), json: null, ms: Date.now() - started, model: opts.model };
}

export async function* stream(provider, opts) {
  yield* chatStream({
    baseUrl: provider.baseUrl,
    model: opts.model,
    messages: toMessages(opts.system, opts.messages),
    temperature: opts.temperature,
    numCtx: opts.numCtx,
    timeoutSec: opts.timeoutSec,
    keepAlive: opts.keepAlive,
    think: false,
    onUsage: opts.onUsage,
  });
}

/**
 * One round of the agent loop against a local model.
 *
 * Ollama speaks a near-OpenAI tool shape with two differences worth knowing:
 * `arguments` arrives already parsed rather than as a JSON string, and tool
 * calls carry no id — so one is synthesised, because the loop needs to pair
 * results back to calls.
 *
 * Whether this works at all depends entirely on the model. Tool calling is a
 * capability, not a given: a 3B model will happily ignore the tools and answer
 * in prose. That is a reason to keep the local models on triage and the
 * triage, and put the agent loop somewhere it will actually work.
 */
export async function invokeWithTools(provider, opts) {
  const started = Date.now();
  const body = {
    model: opts.model,
    messages: toMessages(opts.system, opts.messages.map(toOllamaMessage)),
    stream: false,
    keep_alive: opts.keepAlive || '30m',
    options: { temperature: opts.temperature ?? 0.2, num_ctx: opts.numCtx ?? 8192 },
  };
  const { wire, fromWire } = prepareTools(opts.tools);
  if (wire.length) {
    body.tools = wire.map((tool) => ({
      type: 'function',
      function: { name: tool.wireName, description: tool.description, parameters: tool.schema },
    }));
  }

  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((opts.timeoutSec ?? 120) * 1000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const message = data.message || {};
  const toolCalls = (message.tool_calls || []).map((call, i) => ({
    id: `call_${started}_${i}`,
    name: fromWire.get(call.function?.name) || fromWireName(call.function?.name),
    arguments: call.function?.arguments || {},
  }));

  return {
    text: String(message.content || '').trim(),
    toolCalls,
    stopReason: toolCalls.length ? 'tool_use' : data.done_reason || 'stop',
    raw: message,
    usage: { input: data.prompt_eval_count ?? 0, cachedInput: 0, output: data.eval_count ?? 0 },
    ms: Date.now() - started,
    model: opts.model,
  };
}

function toOllamaMessage(message) {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    };
  }
  if (message.role === 'assistant' && message.raw) return message.raw;
  return { role: message.role, content: message.content };
}

export async function listModels(provider) {
  const models = await listOllamaModels(provider.baseUrl);
  return models.map((m) => ({ name: m.name, label: m.name, parameters: m.parameters }));
}
