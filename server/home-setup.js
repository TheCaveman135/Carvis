/** Move legacy HA settings into core storage without altering device permissions. */
export function initializeHome(store){
 const legacy=store.config.integrations['home-assistant'];
 if(!store.config.homeAssistant){
  const configured=Boolean(legacy?.enabled && legacy.config?.baseUrl && legacy.config?.token);
  store.config.homeAssistant={enabled:configured,config:{...legacy?.config,homeName:legacy?.config?.homeName || (configured?'My Home':'')},entitiesReviewed:configured};
 }
 delete store.config.integrations['home-assistant'];
 // Internal compatibility for adapters; never serialized as an optional integration.
 Object.defineProperty(store.config.integrations,'home-assistant',{configurable:true,enumerable:false,
  get:()=>store.config.homeAssistant,
  set:entry=>{store.config.homeAssistant={...store.config.homeAssistant,...entry};}
 });
 store.saveConfig();
}
export const homeReady=store=>Boolean(store.config.homeAssistant?.enabled && store.config.homeAssistant?.entitiesReviewed);
