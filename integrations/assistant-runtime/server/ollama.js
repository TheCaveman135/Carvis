/**
 * Ollama's HTTP API.
 *
 * The decision schema and `decide()` that used to live here belonged to the
 * autonomous heartbeat: one structured call per tick that returned a list of
 * home actions. Protocols replaced that with saved programs evaluated in
 * ordinary JavaScript, so nothing asks a model to plan the whole house
 * anymore. What is left is the transport `server/providers/ollama.js` uses.
 */
const capsCache = new Map();

/**
 * Reasoning models (qwen3.x, gpt-oss, …) will happily spend minutes thinking
 * before emitting the schema, which is useless for a triage decision the voice
 * pipeline is waiting on. We only send `think` to models that actually support
 * it — passing it to a plain model is an API error.
 */
async function capabilities(baseUrl, model) {
  if (capsCache.has(model)) return capsCache.get(model);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    const caps = res.ok ? (await res.json()).capabilities || [] : [];
    capsCache.set(model, caps);
    return caps;
  } catch {
    return [];
  }
}

export async function listModels(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  const models = data.models || [];
  const caps = await Promise.all(models.map((m) => capabilities(baseUrl, m.name)));
  return models
    .map((m, i) => ({
      name: m.name,
      size: m.size,
      family: m.details?.family || '',
      parameters: m.details?.parameter_size || '',
      quantization: m.details?.quantization_level || '',
      modified_at: m.modified_at,
      thinking: caps[i].includes('thinking'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Stream a plain conversational reply, yielding text chunks as they arrive.
 * Used by the chat view, where waiting 8s for a complete answer feels broken.
 */
export async function* chatStream({ baseUrl, model, messages, temperature, numCtx, timeoutSec, keepAlive, think, onUsage }) {
  const caps = await capabilities(baseUrl, model);
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: keepAlive || '30m',
      ...(caps.includes('thinking') ? { think: Boolean(think) } : {}),
      options: { temperature: temperature ?? 0.4, num_ctx: numCtx ?? 8192 },
    }),
    signal: AbortSignal.timeout((timeoutSec ?? 180) * 1000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Ollama streams newline-delimited JSON, one object per chunk.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.error) throw new Error(obj.error);
      const chunk = obj.message?.content;
      if (chunk) yield chunk;
      if (obj.done) {
        onUsage?.({ input: obj.prompt_eval_count ?? 0, cachedInput: 0, output: obj.eval_count ?? 0 }, obj.model || model);
        return;
      }
    }
  }
}

/** One-shot structured call against an arbitrary schema. */
export async function askJson({ baseUrl, model, messages, schema, temperature, numCtx, maxTokens, timeoutSec, keepAlive }) {
  const caps = await capabilities(baseUrl, model);
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: schema,
      keep_alive: keepAlive || '30m',
      ...(caps.includes('thinking') ? { think: false } : {}),
      // Structured classifiers do not need a 2k-token runway. Respect the
      // role cap so a local triage result returns as soon as its tiny JSON
      // decision is complete.
      options: {
        temperature: temperature ?? 0.1,
        num_ctx: numCtx ?? 8192,
        ...(Number.isFinite(maxTokens) ? { num_predict: Math.max(1, Math.floor(maxTokens)) } : {}),
      },
    }),
    signal: AbortSignal.timeout((timeoutSec ?? 120) * 1000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const content = (await res.json()).message?.content ?? '';
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('model returned non-JSON');
    return JSON.parse(match[0]);
  }
}
