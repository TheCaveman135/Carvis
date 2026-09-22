/**
 * Compatibility layer for Carvis's current `MemoryStore` contract.
 *
 * It supports a safe rollout path:
 *   - `shadow` (default): existing Carvis memory remains live if DMR is down;
 *     every successful write is mirrored to DMR.
 *   - `dmr`: DMR is the sole memory implementation.
 *
 * No action/tool authority passes through this adapter. It only preserves and
 * retrieves context.
 */
export class CarvisDmrAdapter {
  constructor({ dmr, legacy = null, mode = 'shadow', logger = () => {} } = {}) {
    if (!dmr) throw new Error('CarvisDmrAdapter needs a DMRStore');
    if (!['shadow', 'dmr'].includes(mode)) throw new Error('mode must be shadow or dmr');
    this.dmr = dmr;
    this.legacy = legacy;
    this.mode = mode;
    this.logger = logger;
    this.error = '';
  }

  /** Import the existing store once, read-only, so old context is not lost. */
  adoptLegacy() {
    if (!this.legacy?.all) return [];
    try {
      const imported = this.dmr.importLegacy(this.legacy.all());
      this.error = '';
      return imported;
    } catch (error) {
      this.error = `Could not import legacy memories: ${error.message}`;
      this.logger('warn', this.error);
      if (this.mode === 'dmr') throw error;
      return [];
    }
  }

  remember(input = {}) {
    let legacyResult = null;
    if (this.mode === 'shadow' && this.legacy?.remember) {
      legacyResult = this.legacy.remember(input);
    }
    try {
      const dmrResult = this.dmr.remember({
        ...input,
        legacyId: legacyResult?.memory?.id || input.legacyId || null,
      });
      this.error = '';
      // Keeping legacy's exact return shape during a shadow rollout means the
      // current Carvis UI/tool behavior remains stable while DMR learns.
      return legacyResult || {
        memory: dmrResult.memory,
        status: this.#compatStatus(dmrResult.status),
      };
    } catch (error) {
      this.error = error.message;
      this.logger('warn', `DMR capture unavailable: ${error.message}`);
      if (legacyResult) return legacyResult;
      throw error;
    }
  }

  search(query, limit = 10, kinds = ['fact']) {
    try {
      const primary = this.dmr.search(query, limit, kinds);
      if (primary.length >= limit || !this.legacy?.search) return primary;
      const seen = new Set(primary.map((memory) => memory.text.toLowerCase()));
      const fallback = this.legacy.search(query, limit, kinds)
        .filter((memory) => !seen.has(String(memory.text || '').toLowerCase()));
      return [...primary, ...fallback].slice(0, limit);
    } catch (error) {
      this.error = error.message;
      if (this.legacy?.search) return this.legacy.search(query, limit, kinds);
      return [];
    }
  }

  promptSections(probe = '') {
    try {
      const sections = this.dmr.promptSections(probe);
      const populated = sections.rules || sections.preferences || sections.facts;
      if (populated || !this.legacy?.promptSections) return sections;
      return this.legacy.promptSections(probe);
    } catch (error) {
      this.error = error.message;
      if (this.legacy?.promptSections) return this.legacy.promptSections(probe);
      return { rules: '', preferences: '', facts: '', usedIds: [] };
    }
  }

  markUsed(ids) {
    try { this.dmr.markUsed(ids); } catch (error) { this.error = error.message; }
    // Legacy ids may appear only in a temporary fallback result. Its own use
    // accounting is harmless and preserves the existing dashboard audit.
    try { this.legacy?.markUsed?.(ids); } catch { /* accounting must never break a turn */ }
  }

  rules() {
    try {
      const rules = this.dmr.rules();
      return rules.length || !this.legacy?.rules ? rules : this.legacy.rules();
    } catch {
      return this.legacy?.rules?.() || [];
    }
  }

  all() {
    try {
      const all = this.dmr.all();
      return all.length || !this.legacy?.all ? all : this.legacy.all();
    } catch {
      return this.legacy?.all?.() || [];
    }
  }

  forget(id, options = {}) {
    try {
      const dmrMemory = this.#resolveDmrMemory(id);
      if (!dmrMemory) return this.legacy?.forget?.(id, options) || { ok: false, error: `No memory ${id}` };
      // DMR first guarantees the enhanced prompt cannot continue exposing a
      // deleted personal detail. Then remove its matching legacy record when
      // running in shadow mode; an error is reported rather than hidden.
      const result = this.dmr.forget(dmrMemory.id, options);
      if (!result.ok || this.mode !== 'shadow' || !this.legacy?.forget) return result;
      const legacyId = dmrMemory.dmr?.legacyId;
      if (!legacyId) return result;
      const legacyResult = this.legacy.forget(legacyId, options);
      if (!legacyResult?.ok) {
        return { ok: false, error: `DMR deleted the memory but legacy deletion failed: ${legacyResult?.error || 'unknown error'}` };
      }
      return result;
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  update(id, fields = {}) {
    try {
      const dmrMemory = this.#resolveDmrMemory(id);
      if (!dmrMemory) return this.legacy?.update?.(id, fields) || { ok: false, error: `No memory ${id}` };
      let legacyResult = null;
      const legacyId = dmrMemory.dmr?.legacyId;
      if (this.mode === 'shadow' && legacyId && this.legacy?.update) {
        legacyResult = this.legacy.update(legacyId, fields);
        if (!legacyResult?.ok) return legacyResult;
      }
      const result = this.dmr.update(dmrMemory.id, fields);
      return result.ok ? result : (legacyResult || result);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  state() {
    const state = this.dmr.state();
    return {
      ...state,
      available: !this.error,
      error: this.error,
      rollout: this.mode,
      legacyAvailable: Boolean(this.legacy),
    };
  }

  #compatStatus(status) {
    if (status === 'reinforced') return 'unchanged';
    if (status === 'superseded_previous') return 'updated';
    if (status === 'created' || status === 'contested') return 'created';
    return status || 'created';
  }

  #resolveDmrMemory(id) {
    return this.dmr.get(id) || this.dmr.getByLegacyId?.(id) || null;
  }
}
