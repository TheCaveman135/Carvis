/** The HA inventory belongs to the owner picker; Carvis receives only this subset. */
export function visibleEntityIds(getConfig) {
  const entities = getConfig?.()?.entities || {};
  return new Set([...(entities.observed || []), ...(entities.controlled || [])]);
}

export function isVisibleEntity(getConfig, entityId) {
  const entities = getConfig?.()?.entities || {};
  return (Array.isArray(entities.observed) && entities.observed.includes(entityId)) ||
    (Array.isArray(entities.controlled) && entities.controlled.includes(entityId));
}

export function visibleEntities(ha, getConfig) {
  const visible = visibleEntityIds(getConfig);
  return ha.listEntities().filter((entity) => visible.has(entity.entity_id));
}

export function unavailableEntity() {
  // Do not distinguish an unselected entity from a missing entity. Otherwise
  // an attempted lookup becomes an inventory oracle for the model.
  return { success: false, error: 'that entity is not available to Carvis' };
}

function entityIdFromHaRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('ha.')) return null;
  const body = ref.slice(3);
  const marker = ['.attribute.', '.last_changed', '.age_seconds', '.state']
    .map((value) => body.indexOf(value))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  return marker == null ? body : body.slice(0, marker);
}

export function ruleUsesOnlyVisibleEntities(value, getConfig, allowed = visibleEntityIds(getConfig)) {
  let visible = true;
  const walk = (node) => {
    if (!visible || node == null || typeof node !== 'object') return;
    if (typeof node.ref === 'string') {
      const id = entityIdFromHaRef(node.ref);
      if (id && !allowed.has(id)) visible = false;
    }
    for (const key of ['entity_id', 'media_player']) {
      // Rule actions may use a literal template so the runtime can materialize
      // them through the same path as references. Treat that as the entity it
      // names here too; otherwise a hidden entity could bypass the authoring
      // boundary merely by being wrapped in { literal: ... }.
      const raw = node[key];
      const id = typeof raw === 'string'
        ? raw
        : (raw && typeof raw === 'object' && Object.keys(raw).length === 1 && typeof raw.literal === 'string' ? raw.literal : null);
      if (id?.includes('.') && !allowed.has(id)) visible = false;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child);
  };
  walk(value);
  return visible;
}
