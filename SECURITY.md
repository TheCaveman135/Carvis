# Security policy

Carvis is a single-owner smart home controller. The current `main` branch is
the version maintained in this repository; older releases may not receive
security fixes.

## Report a vulnerability privately

Use [GitHub's private vulnerability report](https://github.com/TheCaveman135/Carvis/security/advisories/new).
Do not file a public issue for a vulnerability. Include the affected version,
steps to reproduce with a test home, the possible impact, and any suggested
fix. Remove real credentials, transcripts, private addresses, device lists,
and other personal information before submitting.

Carvis stores private installation data outside source control. Keep the
server on localhost or a trusted network and use HTTPS for remote access.
Integrations run as trusted server code. The core Home Assistant connection
applies explicit entity selection and configurable guards; companion tokens
are scoped to their own routes.

Security reports are reviewed privately. The maintainer may coordinate a fix
and disclosure through GitHub Security Advisories.
