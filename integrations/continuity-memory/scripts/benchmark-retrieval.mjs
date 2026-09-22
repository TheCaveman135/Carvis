#!/usr/bin/env node
/** Compare synthetic recall against a Git revision without touching installation data. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DMRStore } from '../src/dmr-store.js';

const baselineRef = process.argv[2] || 'HEAD';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const baselineModules = new Map();

// Resolve the baseline's own relative modules as well, so this benchmark still
// compares the intended implementations after either version is reorganized.
function baselineModule(file) {
  if (baselineModules.has(file)) return baselineModules.get(file);
  let source = execFileSync('git', ['show', `${baselineRef}:${file}`], {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  source = source.replace(/from\s+(['"])(\.[^'"]+)\1/g, (match, quote, relative) => {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), relative));
    return `from ${JSON.stringify(baselineModule(dependency))}`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  baselineModules.set(file, url);
  return url;
}

const { DMRStore: BaselineStore } = await import(baselineModule('integrations/continuity-memory/src/dmr-store.js'));
const now = Date.UTC(2026, 0, 20);
const options = { dbPath: ':memory:', now: () => now };
const baseline = new BaselineStore(options);
const current = new DMRStore(options);
const queries = ['', 'workshop equipment', 'maintenance zone', 'what is the equipment now?', 'where was maintenance before?'];
const retrieveOptions = { query: 'workshop equipment', limit: 50, audit: false };
const runs = 5;

try {
  for (const store of [baseline, current]) {
    for (let index = 0; index < 200; index++) {
      store.capture({
        id: `fixture-${index}`,
        text: `The workshop equipment ${index} needs maintenance in zone ${index % 12}.`,
        source: 'owner',
        occurredAt: now - index * 1000,
      });
    }
  }
  // All results, scores, ordering, reasons, metadata, timestamps and use counts
  // must match, not just the returned IDs. Retrieval auditing is disabled so
  // repeated measurements do not add writes to either database.
  for (const query of queries) {
    const request = { ...retrieveOptions, query };
    assert.deepEqual(current.retrieve(request), baseline.retrieve(request));
  }
  const elapsed = { baseline: 0, current: 0 };
  for (let run = 0; run < runs; run++) {
    for (const [label, store] of [['baseline', baseline], ['current', current]]) {
      const started = performance.now();
      store.retrieve(retrieveOptions);
      elapsed[label] += performance.now() - started;
    }
  }
  console.log(JSON.stringify({
    baselineRef,
    syntheticMemories: 200,
    selected: retrieveOptions.limit,
    equalQueries: queries.length,
    measuredRuns: runs,
    baselineMeanMs: +(elapsed.baseline / runs).toFixed(2),
    currentMeanMs: +(elapsed.current / runs).toFixed(2),
    speedup: +(elapsed.baseline / elapsed.current).toFixed(1),
  }, null, 2));
} finally {
  baseline.close();
  current.close();
}
