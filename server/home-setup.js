/** Keep the adapter alias derived from core home settings after reloads or edits. */
export function bindHomeIntegration(config) {
  if (!config.homeAssistant) return config;
  config.integrations ||= {};
  Object.defineProperty(config.integrations, "home-assistant", {
    configurable: true,
    enumerable: false,
    get: () => config.homeAssistant,
    set: (entry) => {
      config.homeAssistant = { ...config.homeAssistant, ...entry };
    },
  });
  return config;
}

/** Move legacy HA settings into core storage without altering device permissions. */
export function initializeHome(store) {
  const legacy = store.config.integrations["home-assistant"];
  if (!store.config.homeAssistant) {
    const configured = Boolean(
      legacy?.enabled && legacy.config?.baseUrl && legacy.config?.token,
    );
    store.config.homeAssistant = {
      enabled: configured,
      config: {
        ...legacy?.config,
        homeName: legacy?.config?.homeName || (configured ? "My Home" : ""),
      },
      entitiesReviewed: configured,
    };
  }
  delete store.config.integrations["home-assistant"];
  // Adapter compatibility is never serialized as an optional integration.
  bindHomeIntegration(store.config);
  store.saveConfig();
}
export const homeReady = (store) => Boolean(
  store.config.homeAssistant?.enabled && store.config.homeAssistant?.entitiesReviewed,
);
