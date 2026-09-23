import { randomBytes } from "node:crypto";
import { body, fail, json } from "../responses.js";

export async function integrationRoutes({
  req,
  res,
  path,
  parsed,
  device,
  registry,
}) {
  const integrationMatch =
    /^\/api\/integrations\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(path);
  if (integrationMatch) {
    const [, id, suffix = ""] = integrationMatch;
    if (!registry.modules.has(id)) throw fail("Integration not found.", 404);
    if (device && ["", "/generate-secret", "/test"].includes(suffix))
      throw fail("Sign in to configure integrations.", 403);
    if (!suffix && req.method === "PUT")
      return json(res, 200, await registry.configure(id, await body(req)));
    if (suffix === "/test" && req.method === "POST")
      return json(res, 200, await registry.test(id));
    if (suffix === "/generate-secret" && req.method === "POST") {
      const b = await body(req);
      if (id !== "even-realities" || b.key !== "pairingToken")
        throw fail("Cannot generate this setting.");
      const value = randomBytes(32).toString("base64url");
      await registry.configure(id, { config: { pairingToken: value } });
      return json(res, 200, { value });
    }
    const request = {
      method: req.method,
      path: suffix,
      url: parsed,
      body: ["POST", "PUT", "PATCH"].includes(req.method)
        ? await body(
            req,
            id === "even-realities" && suffix === "/audio" ? 1_600_000 : 128000,
          )
        : {},
      authenticatedAs: device ? "device" : "owner",
    };
    // Entity picker is owner-only and available before enabling HA.
    const result =
      !device &&
      ((id === "home-assistant" && suffix === "/entities") ||
        (["voice", "speech"].includes(id) && suffix === "/audio-devices") ||
        (id === "speech" && suffix === "/voice-options"))
        ? await registry.modules
            .get(id)
            .route(request, registry.contextForTest(id))
        : await registry.route(id, request);
    if (result !== null && result !== undefined) return json(res, 200, result);
  }
  return false;
}
