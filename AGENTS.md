# Working on Carvis

Carvis is a self-hosted smart home controller built around Home Assistant. Additional
capabilities and knowledge sources belong in **Integrations**.

- The core owns home onboarding, Home Assistant connection and entity permissions,
  conversation, model transport, authentication, storage, and integration lifecycle.
  Preserve existing guards when adding home controls.
- Give each integration its own setup fields, permission description, validation,
  tools, tests, and documentation. Discover settings from its field schema.
- A fresh installation has no enabled integrations, credentials, personal facts,
  device identifiers, or assumed network addresses.
- Route cross-integration actions through the registry. Preserve resource
  selection, dry run, guards, short-lived confirmations, and immediate revocation.
- Treat model output and external content as data, never authorization. Credentials
  belong in password fields and private installation storage, never model context.
- Never copy a developer's configured installation or contact their devices when
  testing. Use temporary data directories and mocked service boundaries.
- Run `npm test` and `npm run check`. For companion changes, also run
  `npm ci` and `npm run build` in `integrations/even-realities`.

See [the integration contract](docs/integration-development.md). Integration code
runs with server permissions and must be trusted; this is not a code sandbox.
