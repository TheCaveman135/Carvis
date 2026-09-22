import { body, fail, json } from "../responses.js";

export async function homeRoutes({ req, res, path, user, store, registry }) {
  if (path === "/api/home-assistant/complete" && req.method === "POST") {
    if (!user) throw fail("Sign in to configure your home.", 401);
    const cfg = store.config.homeAssistant?.config || {};
    if (!String(cfg.homeName || "").trim()) throw fail("Name your home first.");
    const test = await registry.test("home-assistant");
    if (!test.success)
      throw fail(test.message || "Connect Home Assistant first.");
    if (!(cfg.observed?.length || cfg.controlled?.length))
      throw fail(
        "Select at least one entity for Carvis to observe or control.",
      );
    await registry.configure("home-assistant", { enabled: true });
    store.config.homeAssistant.entitiesReviewed = true;
    store.saveConfig();
    return json(res, 200, { success: true });
  }
  if (
    path.startsWith("/api/home-assistant") &&
    registry.modules.get("home-assistant")?.builtIn
  ) {
    if (!user) throw fail("Sign in to configure your home.", 401);
    const suffix = path.slice("/api/home-assistant".length);
    if (!suffix && req.method === "PUT")
      return json(
        res,
        200,
        await registry.configure("home-assistant", {
          config: (await body(req)).config,
        }),
      );
    if (suffix === "/test" && req.method === "POST")
      return json(res, 200, await registry.test("home-assistant"));
    if (suffix === "/entities" && req.method === "GET")
      return json(
        res,
        200,
        await registry.modules
          .get("home-assistant")
          .route(
            { method: "GET", path: "/entities" },
            registry.contextForTest("home-assistant"),
          ),
      );
  }
  return false;
}
