import { extractEntities, normalize, tokenize, uniqueTokens } from './lexical.js';

const DAY = 86_400_000;

function scoreDateRecency(timestamp, now, { halfLifeDays = 120, durable = false } = {}) {
  if (durable) return 0.52;
  const ageDays = Math.max(0, now - Number(timestamp || now)) / DAY;
  return Math.exp(-ageDays / halfLifeDays);
}

/** Score eligible records without querying or mutating the store. */
export function scoreCandidates(rows, { text, entitiesByNode, asOfTime, now, wantsCurrent, wantsHistory }) {
  const terms = uniqueTokens(text);
  const queryEntities = new Set(extractEntities(text));
  const documents = rows.map((node) => new Set(tokenize(
    `${node.text} ${node.subject} ${node.predicate} ${node.object} ${node.contextText} ${node.keywords.join(' ')} ${node.tags.join(' ')}`,
  )));
  const df = new Map();
  for (const document of documents) for (const term of document) df.set(term, (df.get(term) || 0) + 1);
  const weights = new Map(terms.map((term) => [term, Math.log(1 + rows.length / (df.get(term) || 1))]));
  const totalIdf = terms.reduce((sum, term) => sum + weights.get(term), 0) || 1;
  const normalizedQuery = normalize(text);
  const candidates = new Map();

  rows.forEach((node, index) => {
    const tokens = documents[index];
    let lexicalRaw = 0;
    const matched = [];
    for (const term of terms) {
      if (tokens.has(term)) {
        lexicalRaw += weights.get(term);
        matched.push(term);
      }
    }
    const lexical = lexicalRaw / totalIdf;
    const entities = entitiesByNode.get(node.id) || new Set();
    const entityHits = [...queryEntities].filter((entity) => entities.has(entity));
    const normalizedText = normalize(node.text);
    const phrase = normalizedText.includes(normalizedQuery) || (text.length > 8 && normalizedQuery.includes(normalizedText));
    const fallbackEligible = !terms.length;
    if (!lexical && !entityHits.length && !fallbackEligible) return;

    let score = lexical * 5;
    const reasons = [];
    if (matched.length) reasons.push(`matched ${matched.join(', ')}`);
    if (phrase) { score += 0.8; reasons.push('phrase match'); }
    if (entityHits.length) { score += entityHits.length * 0.9; reasons.push(`shared entity ${entityHits.join(', ')}`); }
    const recency = scoreDateRecency(node.updatedAt, asOfTime ?? now, { durable: node.durable || node.kind !== 'observation' });
    score += recency * 0.7;
    score += node.authority * 0.36 + node.confidence * 0.42 + node.salience * 0.35;
    score += Math.min(0.36, Math.log1p(node.useCount) * 0.11);
    if (node.pinned) { score += 1; reasons.push('pinned'); }
    if (node.state === 'contested') { score += 0.25; reasons.push('contested: surface uncertainty'); }
    if (asOfTime != null) { score += 0.55; reasons.push(`true at ${new Date(asOfTime).toISOString()}`); }
    if (wantsCurrent && node.state === 'active') { score += 0.55; reasons.push('current truth'); }
    if (wantsHistory && node.state === 'superseded') { score += 0.8; reasons.push('historical truth'); }
    candidates.set(node.id, { node, score, lexical, terms: matched, reasons, entities });
  });
  return candidates;
}

function tokenOverlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * MMR-style diversity keeps several useful facts instead of repeated claims.
 * Tokenize each candidate once and update its maximum overlap only against the
 * latest selection, avoiding repeated comparisons against every prior choice.
 */
export function diversifyCandidates(candidates, limit) {
  const remaining = [...candidates].sort((a, b) => b.score - a.score).map((candidate) => ({
    candidate,
    tokens: new Set(tokenize(candidate.node.text)),
    overlap: 0,
  }));
  const selected = [];
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const { candidate, overlap } = remaining[index];
      const diversified = candidate.score - overlap * 1.18;
      if (diversified > bestScore) { bestScore = diversified; bestIndex = index; }
    }
    const [{ candidate: choice, tokens }] = remaining.splice(bestIndex, 1);
    selected.push({ ...choice, score: Number(choice.score.toFixed(3)), diversifiedScore: Number(bestScore.toFixed(3)) });
    for (const item of remaining) {
      item.overlap = Math.max(
        item.overlap,
        tokenOverlap(item.tokens, tokens),
        item.candidate.node.slotKey === choice.node.slotKey ? 0.88 : 0,
      );
    }
  }
  return selected;
}
