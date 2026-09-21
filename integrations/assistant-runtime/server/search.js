/**
 * Web search, via Gemini's Google Search grounding.
 *
 * Every model role in this app is a fixed-knowledge LLM with no live access
 * to the web, so "what's the weather" or "who won the game last night" has
 * nowhere to go without this. Deliberately not a MODEL_ROLES role: grounding
 * is Google's own infrastructure, not a capability any provider can be
 * swapped in for, so there is nothing to route between. Same relationship to
 * config as server/stt.js has to Deepgram/AssemblyAI — its own block, its
 * own API key, called directly rather than through the role registry.
 */
import { log } from './log.js';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Gemini models available to this API key, for the Web search model picker.
 * Filtered to the generateContent-capable `gemini*` family — the same
 * models the Models tab's own "pick from what the provider actually has"
 * pattern uses for every other role, instead of a name typed from memory
 * that silently drifts once Google renames or retires a tier.
 */
export async function listModels(cfg) {
  const key = (cfg.search?.geminiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('no Gemini API key set — add one in the Voice & glasses card');

  let res;
  try {
    res = await fetch(MODELS_URL, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`could not reach Gemini (${err.message})`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const data = await res.json();
  const models = Array.isArray(data.models) ? data.models : [];
  return models
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || '' }))
    .filter((m) => m.id.startsWith('gemini'))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One grounded search. Resolves `{text, sources}` — `text` is Gemini's own
 * synthesized answer, `sources` the URLs it grounded that answer in, not a
 * raw list of search hits for Carvis to summarize itself.
 */
export async function search(cfg, query) {
  const key = (cfg.search?.geminiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('no Gemini API key set — add one in the Voice & glasses card');

  const model = cfg.search?.model || 'gemini-3.6-flash';
  let res;
  try {
    res = await fetch(INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: query, tools: [{ type: 'google_search' }] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`could not reach Gemini (${err.message})`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message = `Gemini ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
    log('error', `search: ${message}`);
    throw new Error(message);
  }

  const data = await res.json();
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const answer = steps.find((s) => s.type === 'model_output');
  const block = answer?.content?.[0];
  const text = String(block?.text || '').trim();
  const sources = (block?.annotations || [])
    .filter((a) => a?.url)
    .map((a) => ({ url: a.url, title: a.title || a.url }));

  return { text, sources };
}
