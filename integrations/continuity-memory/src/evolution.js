/**
 * Deterministic note construction and reflection for DMR.
 *
 * A-MEM-inspired note metadata lives beside the immutable claim. It may evolve
 * as links appear, while the original text and evidence remain untouched.
 */
import { cleanText, jaccard, normalize, uniqueTokens } from './lexical.js';

const BORING_KEYWORDS = new Set([
  'fact', 'preference', 'rule', 'observation', 'owner', 'carvis', 'memory', 'statement',
]);

export function normalizeNamespace(value = 'owner') {
  const parts = String(value || 'owner')
    .toLowerCase()
    .split(/[/.\\:]+/)
    .map((part) => part.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .slice(0, 8);
  return (parts.length ? parts.join('/') : 'owner').slice(0, 240);
}

function normalizedList(values, limit = 16) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalize(value).replace(/\s+/g, '_').slice(0, 120))
    .filter(Boolean))].slice(0, limit);
}

export function buildNote({
  text,
  kind,
  source,
  subject,
  predicate,
  object,
  namespace = 'owner',
  entities = [],
  keywords = [],
  tags = [],
  contextText = '',
} = {}) {
  const scope = normalizeNamespace(namespace);
  const contentKeywords = uniqueTokens(`${text} ${subject} ${predicate} ${object}`)
    .filter((token) => !BORING_KEYWORDS.has(token));
  const noteKeywords = [...new Set([
    ...normalizedList(keywords, 20),
    ...contentKeywords,
  ])].slice(0, 16);
  const noteTags = [...new Set([
    ...normalizedList(tags, 20),
    `kind:${kind}`,
    `source:${source}`,
    `namespace:${scope}`,
    subject && subject !== 'memory' ? `subject:${subject}` : '',
    predicate && !String(predicate).startsWith('statement:') ? `predicate:${predicate}` : '',
    ...entities.map((entity) => `entity:${normalize(entity).replace(/\s+/g, '_')}`),
  ].filter(Boolean))].slice(0, 24);
  const description = cleanText(contextText, 1_200) || cleanText(
    `${kind} in ${scope}, learned from ${source}; about ${subject}${predicate ? ` / ${predicate}` : ''}. ${text}`,
    1_200,
  );
  return { namespace: scope, keywords: noteKeywords, tags: noteTags, contextText: description };
}

/** Score whether two atomic notes deserve a Zettelkasten-style link. */
export function noteAffinity(left, right) {
  if (!left || !right || left.namespace !== right.namespace) return { score: 0, shared: [] };
  const leftKeywords = new Set(left.keywords || []);
  const rightKeywords = new Set(right.keywords || []);
  const shared = [...leftKeywords].filter((item) => rightKeywords.has(item));
  const keywordScore = jaccard((left.keywords || []).join(' '), (right.keywords || []).join(' '));
  const structural = left.subject === right.subject && left.subject !== 'memory' ? 0.25 : 0;
  const relational = left.predicate === right.predicate && !String(left.predicate).startsWith('statement:') ? 0.15 : 0;
  const score = Math.min(1, keywordScore * 0.72 + structural + relational);
  return { score, shared: shared.slice(0, 10) };
}

export function evolveNote(note, { sharedKeywords = [], relatedText = '' } = {}) {
  const keywords = [...new Set([...(note.keywords || []), ...sharedKeywords])].slice(0, 20);
  const tags = [...new Set([...(note.tags || []), ...sharedKeywords.map((term) => `link:${term}`)])].slice(0, 28);
  const theme = sharedKeywords.length ? `Linked themes: ${sharedKeywords.join(', ')}.` : '';
  const relation = relatedText ? ` Related memory: ${cleanText(relatedText, 180)}` : '';
  const suffix = `${theme}${relation}`.trim();
  const base = String(note.contextText || '').replace(/\s+Linked themes:.*$/i, '').trim();
  return {
    keywords,
    tags,
    contextText: cleanText(`${base}${suffix ? ` ${suffix}` : ''}`, 1_400),
  };
}

export function buildReflection({ facetType, facetKey, namespace, members }) {
  const ordered = [...members].sort((a, b) => a.validFrom - b.validFrom);
  const active = ordered.filter((memory) => memory.state === 'active');
  const contested = ordered.filter((memory) => memory.state === 'contested');
  const historical = ordered.filter((memory) => memory.state === 'superseded');
  const currentLines = [...active, ...contested].slice(-5).map((memory) => memory.text);
  const historicalLines = historical.slice(-3).map((memory) => memory.text);
  const clauses = [];
  if (currentLines.length) clauses.push(`Current: ${currentLines.join(' | ')}`);
  if (historicalLines.length) clauses.push(`Earlier: ${historicalLines.join(' | ')}`);
  if (contested.length) clauses.push('Some linked claims conflict and require verification.');
  const title = `${facetType === 'entity' ? 'Continuity for' : 'Thread about'} ${facetKey}`;
  const keywords = [...new Set(ordered.flatMap((memory) => memory.keywords || []))].slice(0, 20);
  return {
    title,
    summary: cleanText(clauses.join(' '), 1_600),
    keywords,
    memberIds: ordered.map((memory) => memory.id),
    confidence: ordered.length
      ? ordered.reduce((sum, memory) => sum + Number(memory.confidence || 0), 0) / ordered.length
      : 0,
    namespace,
    facetType,
    facetKey,
  };
}
