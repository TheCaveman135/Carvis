# Working on Carvis

Carvis is a generic, self-hosted chatbot. All new capabilities and external
knowledge sources belong in **Integrations**.

- Keep the core limited to conversation, model transport, owner-managed memory,
  authentication, storage, and the integration lifecycle. Core bug fixes and
  accessibility improvements are welcome; do not add service-specific tools or
  background agents to the chat loop.
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
