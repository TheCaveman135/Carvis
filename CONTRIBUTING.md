# Contributing

Please discuss substantial changes before implementing them. New features and
service connections should be integrations; keep the chatbot core small.

1. Use a clean local checkout and a separate `CARVIS_DATA_DIR` for development.
2. Follow the [integration contract](docs/integration-development.md) for new
   capabilities. Include user-facing setup fields instead of embedded settings.
3. Mock external services in tests. Cover permissions, disabled integrations,
   confirmation replay, cancellation, and clear failure reporting.
4. Run `npm test` and `npm run check`. Build the glasses companion when it changes.
5. Explain the behavior change and validation in your pull request.

Do not commit accounts, tokens, transcripts, memories, device lists, packaged
configured companions, or private installation data. Report security concerns
privately as described in [SECURITY.md](SECURITY.md).
