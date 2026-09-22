export const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;

function entityList(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\s,]+/)
        .filter(Boolean);
  if (list.some((id) => typeof id !== "string" || !ENTITY.test(id)))
    throw Error("Use Home Assistant entity IDs, such as light.living_room.");
  return [...new Set(list)];
}
export function validateConfig(config = {}) {
  const baseUrl = String(config.baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Error("Enter the Home Assistant URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw Error(
      "Use an HTTP or HTTPS Home Assistant URL without credentials or query parameters.",
    );
  const token = String(config.token || "").trim();
  if (!token || /[\r\n]/.test(token))
    throw Error("Enter a Home Assistant long-lived access token.");
  const controlled = entityList(config.controlled),
    observed = [...new Set([...entityList(config.observed), ...controlled])];
  let guards = config.guards || {};
  if (typeof guards === "string") {
    try {
      guards = JSON.parse(guards || "{}");
    } catch {
      throw Error(
        "Guards must be a JSON object of entity IDs and standard or protected.",
      );
    }
  }
  if (
    !guards ||
    typeof guards !== "object" ||
    Array.isArray(guards) ||
    Object.entries(guards).some(
      ([id, level]) =>
        !controlled.includes(id) || !["standard", "protected"].includes(level),
    )
  )
    throw Error(
      "Guards may configure controlled entities as standard or protected.",
    );
  return {
    homeName: String(config.homeName || "")
      .trim()
      .slice(0, 80),
    baseUrl,
    token,
    observed,
    controlled,
    guards: { ...guards },
    dryRun: config.dryRun !== false,
  };
}
