/** Human-readable HA state values; only ISO dates and timestamps are reformatted. */
export function entityStateDisplay({ state, unit } = {}, now = new Date()) {
  const raw = state == null ? "" : String(state);
  const fallback = { text: `${raw || "Unknown"}${unit ? " " + unit : ""}` };
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(raw)) return fallback;

  const day = raw.slice(0, 10);
  const calendar = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return fallback;
  const dateOnly = raw.length === 10;
  // Date-only states are calendar dates, not midnight UTC instants.
  const date = new Date(dateOnly ? `${day}T00:00:00` : raw.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return fallback;

  const yesterday = new Date(now), tomorrow = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  tomorrow.setDate(now.getDate() + 1);
  const localDay = date.toDateString();
  const label = localDay === now.toDateString() ? "Today"
    : localDay === yesterday.toDateString() ? "Yesterday"
    : localDay === tomorrow.toDateString() ? "Tomorrow"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return {
    text: dateOnly ? label : `${label} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
    title: dateOnly ? date.toLocaleDateString(undefined, { dateStyle: "full" })
      : date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
  };
}
