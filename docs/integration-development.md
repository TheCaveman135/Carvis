# Building a Carvis integration

Integrations are the extension point for capabilities and external knowledge. Keep domain logic out of the chatbot core.

Create a directory under `CARVIS_INTEGRATIONS_DIR` with `server.js` exporting the module below. Restart Carvis to discover it. It appears in Integrations, disabled until the owner configures and enables it. Files must be ESM (`server.js` can be accompanied by `package.json` with `"type":"module"`).

```js
export default {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  description: 'Read notes you explicitly share with your assistant.',
  permissions: ['Read the notes configured in this integration'],
  fields: [{key:'notes',label:'Shared notes',type:'textarea',required:true}],
  validateConfig(config) {
    if (typeof config.notes !== 'string' || !config.notes.trim()) {
      throw new Error('Enter the notes to share.');
    }
    return {notes:config.notes.slice(0,10000)};
  },
  async test() { return {success:true,message:'Notes are ready.'}; },
  async tools(ctx) {
    return [{
      name:'notes_read', description:'Read the owner-provided notes.', readOnly:true,
      parameters:{type:'object',properties:{},additionalProperties:false},
      async execute() { return {success:true,text:ctx.config.notes}; }
    }];
  }
};
```

## Contract

`ctx` contains the current integration configuration, `fetch`, `registry`, an isolated persistent `store` (`get(key,fallback)`, `set(key,value)`), and `chat({text,conversationId})` for authenticated device inputs. Both store methods are synchronous and may also be awaited. It also carries `enabled` and an optional `signal` (`AbortSignal`). Honor the signal in network requests and check cancellation before starting an action. Optional `context(ctx)` returns a short data-only context string. Optional `sanitize(value,ctx)` removes inaccessible identifiers from content before it reaches a model. Optional `route({method,path,body,url,authenticatedAs},ctx)` handles an owner-authenticated route under `/api/integrations/<id>/`; return `null` for unknown routes.

Sanitizers run even when an integration has never been configured or has been disabled. In that case they receive `enabled:false` and `config:{}` with no credentials. They must tolerate this and remove any formerly accessible resource identifiers from recalled history. Sanitizers must not make network requests or activate capabilities. Before every model round, Carvis refreshes enabled tools and integration context and sanitizes the full history again.

Optional metadata includes `category`, `dependsOn` (Integration IDs), and
`workspaceUrl` for a management page. `workspaceDependsOn` controls availability
of that page without disabling the Integration's independent tools. Required
dependencies must be enabled explicitly. The registry removes unavailable tools
and context when an Integration or its dependency is disabled.

Lifecycle hooks are `start(ctx)`, `stop()`, and `configurationChanged()`. The last
runs after configuration changes, including disable; stop background jobs and
discard stale connections or permissions there. One enabled conversation engine
may implement `respond(request,ctx)` to provide the conversation pipeline. Its
request includes cancellation, conversation context, and an event emitter. The
bundled Assistant engine runs its services in a private worker and forwards other
Integrations' tools through the same registry, including confirmations and
cancellation. Installing an extension therefore adds its abilities to both base
chat and the optional Assistant engine.

Only enabled integrations expose tools and device routes. `GET /api/integrations/home-assistant/entities` is a deliberately owner-only exception for configuring the device picker before activation. The Even Realities module has a scoped pairing token for its companion; that token cannot configure Carvis or read the owner settings API.

Tool names must be unique, up to 64 letters/digits/underscores/hyphens, starting with a letter. Every tool declares a JSON Schema `parameters` object, using `additionalProperties:false` where appropriate. Validate service-specific rules again in `execute(args,options)`; do not treat model output as authorization.

## Actions and confirmations

A protected tool can supply `confirmation(args,options)` returning a user-readable description, or return `{requiresConfirmation:true,summary}` from `execute`. The registry issues a short-lived, single-use confirmation. A model-supplied `confirmed` argument is never authorization. The HTTP API exposes only acceptance of a server-issued confirmation ID. When it is accepted, the registry obtains the tool again and revalidates current configuration before executing with `options.confirmed:true`. Device callers cannot approve confirmations issued in the owner chat. For confirmations linked to a conversation, Carvis persists approval, decline, cancellation, or execution error as a server-generated event, separate from assistant claims. The next model turn receives that event as execution evidence. Approval alone does not prove success; return `accepted`, `verified`, `dryRun`, or errors accurately.

Call `registry.invoke(name,args,{source:'device'})` when one integration needs another. Do not bypass that path with direct adapter writes. `registry.describe(name)` returns metadata for an enabled tool; polling may invoke a tool only when it explicitly declares `readOnly:true`. This is a convention for trusted integration developers, not a sandbox for untrusted code.

Use authenticated foreground actions. The generic registry rejects background
actuation. The optional Protocols and Proactivity Integrations use their existing
guarded automation gateway for explicitly configured behavior; this does not give
new extension tools permission to act unattended. Honor dry-run settings,
per-device selection, revocation, and guards. Never retry an uncertain action
automatically.

## Setup fields and secrets

Supported field types: `text`, `url`, `password`, `textarea`, `boolean`, `number`,
`json`, `select`, `entities`. Set `group`, `description`, and `default` to make
settings understandable and organized. Select options are `{value,label}`
objects. Password values remain encrypted on the server, and the UI gets
`has<FieldName>` only. Leaving a password input blank retains its existing value.
Configuration must contain no developer-specific defaults or hidden endpoints.

## Testing

Use `ctx.fetch` and an injectable service boundary to mock external systems. Test disabled behavior, invalid arguments, selected-resource boundaries, confirmation replay, uncertain requests, and configuration changes. Never run tests against a developer's home or cloud account. Include a setup guide and explain external dependencies and data flows.
