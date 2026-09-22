/**
 * Deterministic language primitives for DMR.
 *
 * DMR deliberately starts with inspectable lexical signals instead of a hidden
 * embedding service.  A later embedding adapter can add a score, but every
 * context item must remain explainable when that adapter is unavailable.
 */
import { createHash } from 'node:crypto';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so',
  'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
  // These are safe to discard for retrieval.  Negation and directional/state
  // words are intentionally absent: they can reverse a memory's meaning.
  'about', 'again', 'also', 'am', 'any', 'around', 'because', 'before', 'both', 'during',
  'each', 'few', 'here', 'how', 'just', 'more', 'most', 'near', 'now', 'once', 'only',
  'other', 'same', 'some', 'still', 'such', 'than', 'then', 'these', 'those', 'through',
  'too', 'until', 'very', 'while', 'why',
]);

const NEGATION = /\b(?:not|never|no|don't|dont|doesn't|doesnt|won't|wont|can't|cant|hates?|dislikes?)\b/i;

export function cleanText(value, maxChars = 4_000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export function normalize(value) {
  return cleanText(value).toLowerCase();
}

export function tokenize(value) {
  return normalize(value)
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

export function uniqueTokens(value) {
  return [...new Set(tokenize(value))];
}

export function hasNegation(value) {
  return NEGATION.test(String(value ?? ''));
}

export function fingerprint(value) {
  const tokens = uniqueTokens(value).sort();
  return `${hasNegation(value) ? 'neg' : 'pos'}:${tokens.join(' ')}`;
}

export function jaccard(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function hash(value, length = 16) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

export function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function canonicalPhrase(value, fallback = 'unknown') {
  const tokens = uniqueTokens(value);
  return tokens.length ? tokens.slice(0, 6).join('_') : fallback;
}

/**
 * Pull a modest, local entity set from text. This intentionally favours known
 * machine identifiers and meaningful proper names over aggressively guessing
 * every noun; false relationships are worse than missing edges.
 */
export function extractEntities(value) {
  const text = cleanText(value);
  const entities = new Set();

  for (const match of text.matchAll(/\b(?:[a-z][a-z0-9_]{1,48})\.(?:[a-z0-9_]{1,96})\b/gi)) {
    entities.add(match[0].toLowerCase());
  }

  for (const match of text.matchAll(/\b(?:Carvis|Atlas|Home Assistant)\b/gi)) {
    entities.add(match[0].toLowerCase().replace(/\s+/g, '_'));
  }

  // A proper-name phrase is useful for people, project names and named devices.
  for (const match of text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g)) {
    const candidate = normalize(match[0]).replace(/\s+/g, '_');
    if (!['i', 'the', 'this', 'that'].includes(candidate)) entities.add(candidate);
  }

  return [...entities].slice(0, 16);
}

/**
 * Derive a conservative claim slot.  `slotKey` tells DMR when two statements
 * may be competing versions of the same changing truth.  Generic sentences
 * intentionally use their full fingerprint as a slot, which prevents DMR from
 * inventing a contradiction between unrelated facts.
 */
export function inferClaim(text, kind = 'fact') {
  const original = cleanText(text);
  const lower = normalize(original);
  const fallback = {
    subject: 'memory',
    predicate: `statement:${fingerprint(original)}`,
    object: lower,
    slotKey: `${kind}|statement|${fingerprint(original)}`,
    identityKey: `${kind}|statement|${fingerprint(original)}`,
    slotSpecific: false,
    negated: hasNegation(original),
  };

  // "The P2S printer lives in the garage" and "the printer is in the office"
  // share a stable location slot while preserving the old location as history.
  let match = lower.match(/^(.{2,80}?)\s+(?:lives|is located|sits|stays)\s+(?:in|at|on)\s+(.{2,120})[.!?]?$/);
  if (!match) match = lower.match(/^(.{2,80}?)\s+is\s+(?:in|at|on)\s+(.{2,120})[.!?]?$/);
  if (!match) {
    const reverse = lower.match(/^(.{2,120}?)\s+is\s+where\s+(.{2,80}?)\s+(?:lives|is located|sits|stays)[.!?]?$/);
    if (reverse) match = [reverse[0], reverse[2], reverse[1]];
  }
  if (match) {
    const subject = canonicalPhrase(match[1]);
    const object = canonicalPhrase(match[2]);
    return {
      subject,
      predicate: 'location',
      object,
      slotKey: `${kind}|${subject}|location`,
      identityKey: `${kind}|${subject}|location|${object}`,
      slotSpecific: true,
      negated: false,
    };
  }

  // A device/status form.  Only clearly bounded states are treated as a
  // changing slot; ordinary "X is great" stays a generic statement.
  match = lower.match(/^(.{2,80}?)\s+(?:is|are)\s+(on|off|open|closed|locked|unlocked|available|unavailable)[.!?]?$/);
  if (match) {
    const subject = canonicalPhrase(match[1]);
    const object = match[2];
    return {
      subject,
      predicate: 'state',
      object,
      slotKey: `${kind}|${subject}|state`,
      identityKey: `${kind}|${subject}|state|${object}`,
      slotSpecific: true,
      negated: false,
    };
  }

  match = lower.match(/^(?:my\s+)?favou?rite\s+(.{2,50}?)\s+is\s+(.{2,120})[.!?]?$/);
  if (match) {
    const category = canonicalPhrase(match[1]);
    const object = canonicalPhrase(match[2]);
    return {
      subject: 'owner',
      predicate: `favorite:${category}`,
      object,
      slotKey: `${kind}|owner|favorite:${category}`,
      identityKey: `${kind}|owner|favorite:${category}|${object}`,
      slotSpecific: true,
      negated: false,
    };
  }

  match = lower.match(/^i\s+(?:really\s+)?(like|love|prefer|hate|dislike)\s+(.{2,160})[.!?]?$/);
  if (match) {
    const phrase = cleanText(match[2]).replace(/[.!?]+$/, '');
    // The leading content phrase makes preferences about lighting and music
    // different slots, without pretending we parsed their whole semantics.
    const subjectMatter = canonicalPhrase(phrase);
    const sentiment = ['hate', 'dislike'].includes(match[1]) ? 'avoid' : 'prefer';
    return {
      subject: 'owner',
      predicate: `preference:${subjectMatter}`,
      object: `${sentiment}:${canonicalPhrase(phrase)}`,
      slotKey: `${kind}|owner|preference:${subjectMatter}`,
      identityKey: `${kind}|owner|preference:${subjectMatter}|${sentiment}:${canonicalPhrase(phrase)}`,
      slotSpecific: true,
      negated: sentiment === 'avoid',
    };
  }

  return fallback;
}

export function historicalIntent(query) {
  const text = String(query ?? '');
  // "before using it" is a procedural instruction, not a request for old
  // truth. Require a clear historical construction before admitting retired
  // facts into the otherwise current-focused packet.
  return /\b(?:used to|previous|formerly|history|historical|last week|yesterday|earlier)\b/i.test(text)
    || /\b(?:where|what|who|when)\s+(?:was|were)\b/i.test(text)
    || /\bbefore\s*(?:[?!.]|$)/i.test(text)
    || /\bbefore\s+(?:it|this|that|the\s+\w+)\s+(?:moved|changed|was\s+updated)/i.test(text);
}

export function currentIntent(query) {
  return /\b(?:current|currently|now|latest|today|still|where is|what is)\b/i.test(String(query ?? ''));
}

export function dayKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function timeBucket(timestamp, hours = 3) {
  const d = new Date(timestamp);
  return Math.floor(d.getHours() / hours);
}

export function dayClass(timestamp) {
  const day = new Date(timestamp).getDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}
