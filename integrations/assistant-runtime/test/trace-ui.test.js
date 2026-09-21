import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const context = vm.createContext({
  escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  ago: () => 'just now',
});
vm.runInContext(source.slice(source.indexOf('function traceJson('), source.indexOf('function renderTrace(')), context);

test('a finished model turn with a failed tool is visibly failed, never all actions completed', () => {
  const html = context.traceInvocationCard({ outcome: 'ok', startedAt: 100, summary: { failed: 1, read: 1 }, toolCalls: [], steps: [] });
  assert.match(html, /trace-invocation failed/);
  assert.match(html, /1 read · 1 failure/);
  assert.doesNotMatch(html, /actions completed|No tools needed/);
});

test('tool facts are visible inside the collapsed summary and escaped as text', () => {
  const html = context.traceActionCard({ tool: 'ha.get_state', risk: 0, ok: true, outcome: 'read', facts: [{ label: 'Returned state', value: '<script>bad</script>' }] });
  assert.match(html.slice(0, html.indexOf('</summary>')), /Returned state/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('missing model steps are identified as audit records rather than invented model decisions', () => {
  const html = context.traceModelPass({ kind: 'gateway', toolCount: 1 }, []).join('');
  assert.match(html, /model step not recorded/);
  assert.doesNotMatch(html, /Model pass 1|0ms|Round <code>/);
  assert.match(context.traceResultLabel({ outcome: 'queued' }), /execution unconfirmed/);
  assert.match(context.traceResultLabel({ outcome: 'accepted', tool: 'speech.say' }), /playback unconfirmed/);
});
