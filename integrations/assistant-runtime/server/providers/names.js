/**
 * Tool-name translation.
 *
 * Carvis names tools by namespace — `atlas.task.create`, `ha.light.set` —
 * because that reads better to the model and makes the audit log legible at a
 * glance. Every provider so far rejects the dot:
 *
 *   Anthropic  ^[a-zA-Z0-9_-]{1,128}$
 *   OpenAI     ^[a-zA-Z0-9_-]+$
 *
 * So the dots are swapped for a double underscore on the wire and mapped back
 * on the way in. Double, not single, so it cannot collide with the single
 * underscores that already appear in names like `get_area_state`.
 */
export function toWireName(name) {
  return name.replace(/\./g, '__');
}

export function fromWireName(name) {
  return String(name || '').replace(/__/g, '.');
}

/**
 * Wire-safe definitions plus the map back. Built together so the two can never
 * disagree about what a name was.
 */
export function prepareTools(tools = []) {
  const fromWire = new Map();
  const wire = tools.map((tool) => {
    const name = toWireName(tool.name);
    fromWire.set(name, tool.name);
    return { ...tool, wireName: name };
  });
  return { wire, fromWire };
}
