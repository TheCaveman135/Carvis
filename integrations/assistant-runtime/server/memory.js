/**
 * What Carvis knows about the owner.
 *
 * Three kinds, split by what a memory does rather than what it is about:
 *
 *   fact        answers questions. Retrieved against what was said, because
 *               most facts are irrelevant to most turns.
 *   preference  changes behaviour — when to interrupt, what to confirm, how to
 *               phrase things. Always injected, because a preference that only
 *               applies when its words happen to match is worse than useless:
 *               it works in the rehearsal and fails in the moment that matters.
 *               "Goes to bed around midnight" has to be present when the owner
 *               says "turn on all the lights", and shares not one word with it.
 *   rule        a standing instruction that constrains what Carvis may do
 *               ("never turn a bedroom light on after 22:00"). These used to
 *               live outside memory entirely, as one opaque `agent.houseRules`
 *               string edited in a separate box. They are the same thing as a
 *               preference mechanically — always injected, never evicted — and
 *               differ only in force: a preference colours a choice, a rule
 *               forbids one. They are rendered to the model under their own
 *               heading so that difference survives into the prompt.
 *
 * A RAM mirror is authoritative for reads. Every write goes through here, never
 * through db.js directly, or the mirror is what the model sees while the truth
 * sits on disk.
 */
import { randomUUID } from 'node:crypto';

import { deleteMemory, insertMemory, loadMemories, touchMemories, updateMemory } from './db.js';
import { log } from './log.js';

export const KINDS = new Set(['fact', 'preference', 'rule']);
export const SOURCES = new Set(['carvis', 'owner']);

/**
 * Words that carry no claim, so that rewording the same fact produces the same
 * fingerprint. "The printer lives in the garage" and "the garage is where the
 * printer lives" have to collapse, or the store fills with the same fact typed
 * five ways.
 *
 * Spatial and state words are deliberately absent — up, down, on, off, in, out,
 * over, under. Those look like function words and are not: "likes the blinds
 * down" and "likes the blinds up" are opposite preferences, and collapsing them
 * would let one silently overwrite the other. Same reasoning as keeping
 * negations in fingerprint().
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'him', 'his', 'i', 'is', 'it', 'its', 'me', 'my', 'of', 'or', 'she',
  'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was', 'were', 'with', 'you', 'your',
  // Function words and approximators: none of these change what is being claimed.
  'about', 'again', 'all', 'already', 'also', 'always', 'am', 'among', 'any', 'around',
  'because', 'been', 'before', 'being', 'both', 'can', 'could', 'did', 'do', 'does', 'doing',
  'during', 'each', 'few', 'get', 'got', 'here', 'how', 'into', 'just', 'more', 'most',
  'near', 'now', 'once', 'only', 'other', 'own', 'same', 'should', 'some', 'still', 'such',
  'than', 'then', 'there', 'these', 'those', 'through', 'too', 'until', 'very',
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'would',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * A dedupe key that survives rewording but not reversal.
 *
 * Negations are kept deliberately. "likes the heater on" and "does not like the
 * heater on" share every other token, and collapsing them would let Carvis
 * overwrite a preference with its opposite and report success.
 */
export function fingerprint(text) {
  const negated = /\b(not|never|no|don't|dont|doesn't|doesnt|won't|wont|can't|cant|hates?|dislikes?)\b/i.test(
    String(text || ''),
  );
  const tokens = [...new Set(tokenize(text))].sort();
  return `${negated ? 'neg' : 'pos'}:${tokens.join(' ')}`;
}

export function jaccard(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

export class MemoryStore {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.items = [];
    this.loaded = false;
    this.error = '';
  }

  start({ rulesOnly = false } = {}) {
    try {
      this.items = loadMemories().filter(item => !rulesOnly || item.kind === 'rule');
      this.loaded = true;
      this.error = '';
      if (this.items.length) log('info', `Loaded ${this.items.length} memories`);
    } catch (err) {
      // Down is not the same as empty. Reporting "nothing remembered" when the
      // table cannot be read would have Carvis confidently deny knowing things.
      this.error = err.message;
      this.loaded = false;
      log('error', `Could not load memories: ${err.message}`);
    }
  }

  #limits() {
    const cfg = this.getConfig().memory || {};
    return {
      maxItems: cfg.maxItems ?? 500,
      maxFactsPerTurn: cfg.maxFactsPerTurn ?? 8,
      maxChars: cfg.maxChars ?? 240,
      nearDuplicate: cfg.nearDuplicate ?? 0.8,
    };
  }

  /**
   * Record something. Returns {memory, status} where status is 'created',
   * 'updated' (a near-duplicate was refined) or 'unchanged'.
   */
  remember({ text, kind = 'fact', source = 'carvis', pinned = false }) {
    if (this.error) throw new Error(`memory is unavailable: ${this.error}`);

    const clean = String(text || '').trim().replace(/\s+/g, ' ').slice(0, this.#limits().maxChars);
    if (!clean) throw new Error('a memory needs some text');
    if (!KINDS.has(kind)) throw new Error(`kind must be one of: ${[...KINDS].join(', ')}`);
    if (!SOURCES.has(source)) throw new Error(`source must be one of: ${[...SOURCES].join(', ')}`);

    const print = fingerprint(clean);
    const now = Date.now();

    // Exact fingerprint: same claim, possibly reworded. Keep the newer wording.
    const exact = this.items.find((item) => item.fingerprint === print);
    if (exact) {
      if (exact.text === clean && exact.kind === kind) return { memory: exact, status: 'unchanged' };
      // Carvis may refine its own note; it may not quietly rewrite the owner's.
      if (exact.source === 'owner' && source === 'carvis') return { memory: exact, status: 'unchanged' };
      Object.assign(exact, { text: clean, kind, fingerprint: print, updated_at: now });
      updateMemory(exact.id, exact);
      return { memory: exact, status: 'updated' };
    }

    // Near-duplicate: overlapping wording of the same idea. Same rule.
    const { nearDuplicate } = this.#limits();
    const close = this.items.find(
      (item) => item.kind === kind && jaccard(item.text, clean) >= nearDuplicate,
    );
    if (close) {
      if (close.source === 'owner' && source === 'carvis') return { memory: close, status: 'unchanged' };
      Object.assign(close, { text: clean, fingerprint: print, updated_at: now });
      updateMemory(close.id, close);
      return { memory: close, status: 'updated' };
    }

    const memory = {
      id: `mem_${randomUUID().slice(0, 12)}`,
      ts: now,
      updated_at: now,
      kind,
      text: clean,
      source,
      fingerprint: print,
      pinned: Boolean(pinned),
      used_at: null,
      use_count: 0,
    };
    insertMemory(memory);
    this.items.unshift(memory);
    this.#evict();
    return { memory, status: 'created' };
  }

  /**
   * Drop the oldest unpinned facts once the store is over its cap. Preferences
   * and rules are never evicted: there are few of them and each one changes
   * behaviour, so losing one silently changes how Carvis acts — and silently
   * dropping a rule would quietly restore a behaviour the owner forbade.
   */
  #evict() {
    const { maxItems } = this.#limits();
    if (this.items.length <= maxItems) return;
    const evictable = this.items
      .filter((item) => item.kind === 'fact' && !item.pinned)
      .sort((a, b) => a.updated_at - b.updated_at);
    for (const victim of evictable.slice(0, this.items.length - maxItems)) {
      this.forget(victim.id, { by: 'carvis', reason: 'over capacity' });
    }
  }

  forget(id, { by = 'owner' } = {}) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return { ok: false, error: `no memory ${id}` };
    const memory = this.items[index];
    // Carvis may forget what Carvis inferred. What the owner typed is theirs.
    if (by === 'carvis' && memory.source === 'owner') {
      return { ok: false, error: 'that memory was written by the owner; only they can remove it' };
    }
    deleteMemory(id);
    this.items.splice(index, 1);
    return { ok: true, memory };
  }

  update(id, fields) {
    const memory = this.items.find((item) => item.id === id);
    if (!memory) return { ok: false, error: `no memory ${id}` };
    const text = fields.text === undefined ? memory.text : String(fields.text).trim().slice(0, this.#limits().maxChars);
    if (!text) return { ok: false, error: 'a memory needs some text' };
    const kind = fields.kind === undefined ? memory.kind : fields.kind;
    if (!KINDS.has(kind)) return { ok: false, error: `kind must be one of: ${[...KINDS].join(', ')}` };

    Object.assign(memory, {
      text,
      kind,
      fingerprint: fingerprint(text),
      pinned: fields.pinned === undefined ? memory.pinned : Boolean(fields.pinned),
      updated_at: Date.now(),
    });
    updateMemory(id, memory);
    return { ok: true, memory };
  }

  /** Facts scored against what was said. Preferences are not searched here. */
  search(query, limit = 10, kinds = ['fact']) {
    const wanted = new Set(tokenize(query));
    if (!wanted.size) return [];
    return this.items
      .filter((item) => kinds.includes(item.kind))
      .map((item) => {
        const tokens = new Set(tokenize(item.text));
        let shared = 0;
        for (const token of tokens) if (wanted.has(token)) shared++;
        return { item, score: shared / Math.sqrt(tokens.size || 1) };
      })
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((scored) => scored.item);
  }

  /**
   * The block that goes into a system prompt.
   *
   * Rules and preferences unconditionally, facts by relevance. Returns the ids
   * that were actually included so the caller can record that they were used.
   */
  promptSections(probe = '') {
    if (this.error || !this.items.length) return { rules: '', preferences: '', facts: '', usedIds: [] };

    const { maxFactsPerTurn } = this.#limits();
    const rules = this.items.filter((item) => item.kind === 'rule');
    const preferences = this.items.filter((item) => item.kind === 'preference');
    const pinnedFacts = this.items.filter((item) => item.kind === 'fact' && item.pinned);
    const matched = probe ? this.search(probe, maxFactsPerTurn) : [];

    const facts = [];
    for (const item of [...pinnedFacts, ...matched]) {
      if (facts.length >= maxFactsPerTurn) break;
      if (!facts.some((existing) => existing.id === item.id)) facts.push(item);
    }

    const line = (item) => `- ${item.text}`;
    return {
      rules: rules.map(line).join('\n'),
      preferences: preferences.map(line).join('\n'),
      facts: facts.map(line).join('\n'),
      usedIds: [...rules, ...preferences, ...facts].map((item) => item.id),
    };
  }

  /** Standing instructions, newest last — the Chat tab and rule extraction. */
  rules() {
    return this.items.filter((item) => item.kind === 'rule').map((item) => ({ ...item }));
  }

  /** Accounting only — a failure here must never break a turn. */
  markUsed(ids) {
    if (!ids?.length) return;
    const at = Date.now();
    for (const id of ids) {
      const item = this.items.find((candidate) => candidate.id === id);
      if (item) {
        item.used_at = at;
        item.use_count += 1;
      }
    }
    try {
      touchMemories(ids, at);
    } catch (err) {
      log('warn', `Could not record memory usage: ${err.message}`);
    }
  }

  all() {
    return this.items.map((item) => ({ ...item }));
  }

  state() {
    return {
      available: !this.error,
      error: this.error,
      total: this.items.length,
      facts: this.items.filter((item) => item.kind === 'fact').length,
      preferences: this.items.filter((item) => item.kind === 'preference').length,
      rules: this.items.filter((item) => item.kind === 'rule').length,
      byCarvis: this.items.filter((item) => item.source === 'carvis').length,
    };
  }
}
