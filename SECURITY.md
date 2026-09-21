# Security and privacy

Carvis is a single-owner application. Keep it on localhost or a trusted network; use TLS for remote access. The first account can be created only from a local connection. Do not publish the private data directory, environment files, provider keys, service tokens, or an owner-configured glasses package.

Integration code is trusted server code, not sandboxed code. Enabling an integration exposes only its tools, and each integration must independently validate selected resources and action permissions. The built-in HA integration applies explicit selection and configurable device guards; protected actions require a server-issued confirmation. Tokens for companion devices are scoped to their integration endpoints.

Before reporting a vulnerability, remove credentials, transcripts, URLs that identify a private home, and other personal information. Use GitHub's private vulnerability reporting for the repository when available. Do not post working secrets in public issues.

The release hygiene checker catches known unsafe file types and common credential patterns. It is a defense in depth check, not a guarantee that arbitrary third-party code is safe.
