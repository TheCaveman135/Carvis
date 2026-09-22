import { fingerprint } from './lexical.js';

export function json(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Turn a row into DMR's public, provenance-bearing shape. */
export function nodeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    normalized: row.normalized,
    source: row.source,
    authority: Number(row.authority),
    confidence: Number(row.confidence),
    state: row.state,
    pinned: Boolean(row.pinned),
    durable: Boolean(row.durable),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    validFrom: Number(row.valid_from),
    validTo: row.valid_to == null ? null : Number(row.valid_to),
    usedAt: row.used_at == null ? null : Number(row.used_at),
    useCount: Number(row.use_count),
    salience: Number(row.salience),
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    slotKey: row.slot_key,
    identityKey: row.identity_key,
    namespace: row.namespace || 'owner',
    keywords: json(row.keywords, []),
    tags: json(row.tags, []),
    contextText: row.context_text || '',
    revision: Number(row.revision || 1),
    supersededBy: row.superseded_by,
    legacyId: row.legacy_id,
    metadata: json(row.metadata, {}),
  };
}

/** Shape expected by the current Carvis MemoryStore and dashboard. */
export function legacyShape(node) {
  return {
    id: node.id,
    ts: node.createdAt,
    updated_at: node.updatedAt,
    kind: node.kind,
    text: node.text,
    source: node.source === 'import' ? 'owner' : node.source,
    fingerprint: fingerprint(node.text),
    pinned: node.pinned,
    used_at: node.usedAt,
    use_count: node.useCount,
    // Extra fields are non-breaking to existing consumers and make the DMR
    // data auditable in a richer future view.
    dmr: {
      state: node.state,
      confidence: node.confidence,
      validFrom: node.validFrom,
      validTo: node.validTo,
      legacyId: node.legacyId,
      namespace: node.namespace,
      keywords: node.keywords,
      tags: node.tags,
      contextText: node.contextText,
      revision: node.revision,
    },
  };
}
