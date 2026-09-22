# Contributing to Carvis

Carvis is a smart home AI controller. Home Assistant connection, home setup,
entity access, guards, and conversations belong to the core. Voice, TV control,
memory, glasses, and other extra abilities belong in Integrations. Please open
an issue before starting a large change so its scope can be discussed.

## Set up a development checkout

Use Node.js 22.18 or later, then run:

```sh
npm ci
npm test
npm run check
```

Run Carvis with a separate `CARVIS_DATA_DIR` for development. Use fake homes
and mocked service boundaries in tests. Never point automated tests at your
real Home Assistant installation or copy a configured installation into the
repository.

## Make a change

1. Follow the [integration contract](docs/integration-development.md) for new
   abilities. Give each integration its own setup fields and permissions.
2. Preserve entity selection, device guards, dry run, confirmation, and
   immediate revocation. A model suggestion or external response is data, not
   authorization.
3. Add focused tests for meaningful behavior, especially permission changes,
   failures, and disabled integrations.
4. Run `npm test` and `npm run check`. If the Even Realities companion changes,
   run `npm ci` and `npm run build` in `integrations/even-realities`.
5. In your pull request, explain the problem, the resulting behavior, and how
   you verified it.

Contributions to Carvis are submitted under its
[AGPL-3.0-only license](LICENSE). Please do not include accounts, tokens,
transcripts, memories, private home addresses, entity lists, or configured
companion packages in issues, screenshots, logs, commits, or pull requests.

For help, see [Support](SUPPORT.md). Report security concerns privately as
described in [Security](SECURITY.md). Community participation follows the
[Code of Conduct](CODE_OF_CONDUCT.md).
