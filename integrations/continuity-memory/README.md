# Continuity Memory

Carvis's long-term memory. This integration uses a temporal claim ledger, evidence graph, atomic notes, local reflection, contradiction handling,
and tentative pattern learner. It runs locally with Node's built-in SQLite support.

Existing Carvis memories are imported once with their original source and dates.
Old versions remain available as history. Owner deletions remain deletions after a
restart. Disabled memory keeps existing owner rules active, while stopping learning.
Detected patterns never authorize actions or bypass Home Assistant device guards.

## Code layout

- `src/dmr-store.js` owns transactions, temporal claims, evidence, and the public store API.
- `src/schema.js` owns SQLite initialization and legacy upgrades.
- `src/records.js` translates database rows into public and compatibility records.
- `src/retrieval.js` scores and diversifies eligible records without database access.
- `src/evolution.js` and `src/lexical.js` derive note metadata and lexical features.

Run the isolated memory checks from the repository root with
`node --test integrations/continuity-memory/test/*.test.js`. These use in-memory
or temporary databases, including an older-schema migration fixture.

## Synthetic retrieval benchmark

From the repository root, run:

```sh
node integrations/continuity-memory/scripts/benchmark-retrieval.mjs HEAD
```

The optional argument is the Git revision to compare against; after committing a
refactor, use its parent or another earlier revision. The script loads that
revision's memory modules and creates two independent in-memory databases with
200 identical synthetic equipment facts, fixed IDs and timestamps, and untouched
use counts. It requires complete retrieval outputs to match for five queries,
including empty, current, and historical recall. Then it alternates five timed
runs per implementation, each selecting 50 results with audit writes disabled.

One local run of the cleanup measured 275.32 ms before and 3.77 ms after. This is a
synthetic recall workload, not an estimate of whole-app or device performance.
Neither the benchmark nor the tests open an installation database or contact devices.
