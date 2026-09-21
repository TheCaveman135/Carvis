# Carvis rule core

`server/rules/index.js` is the pure, synchronous core of the Carvis automation
language. It validates and evaluates rules, but it never persists rules, polls
systems, calls tools, or executes actions.

## Canonical AST

```js
{
  version: 1,
  id: 'evening-home',
  name: 'Evening arrival',
  description: 'Optional description',
  enabled: true,

  when: {
    all: [
      { op: 'changed_to', left: { ref: 'location.person' }, right: { literal: 'home' } },
      { op: 'equals', left: { ref: 'time.hour' }, right: { literal: 20 } }
    ]
  },
  if: { op: 'equals', left: { ref: 'ha.light.porch.state' }, right: { literal: 'off' } },
  while: { not: { op: 'equals', left: { ref: 'carvis.mode' }, right: { literal: 'quiet' } } },

  then: [
    {
      type: 'tool.call',
      tool: 'ha.light.turn_on',
      arguments: { entity_id: 'light.porch' }
    },
    { type: 'speech.say', text: { literal: 'Welcome home' } }
  ],
  else: [{ type: 'hud.show', payload: { text: { literal: 'Porch light already on' } } }],
  metadata: { createdBy: 'carvis' }
}
```

Conditions are exactly one of:

- `{ all: [condition, ...] }`
- `{ any: [condition, ...] }`
- `{ not: condition }`
- `{ op, left, right?, durationMs?, withinMs? }`

Values are always explicit: `{ ref: 'namespace.path' }` or
`{ literal: <JSON value> }`. Built-in namespaces are `time`, `ha`, `atlas`,
`timer`, `location`, `carvis`, `memory`, and `variable`.

Temporal conditions require a reference on the left. `for_duration` and
`has_been` require `durationMs`. `within` and `hasnt_happened` require
`withinMs`. `within` and `hasnt_happened` may omit the right value; other
built-in comparisons require it.

## Public API

- `validateRule(rule, options?)` returns `{ ok, errors, stats }`.
- `assertValidRule(rule, options?)` returns the same rule or throws
  `RuleValidationError`.
- `evaluateValue(value, context)` resolves one value node.
- `evaluateCondition(condition, context)` evaluates a validated condition.
- `evaluateRule(rule, context, options?)` validates, evaluates, and returns an
  action plan. It does not execute that plan.
- `materializeAction(action, context, options?)` and `materializeActions(...)`
  replace references inside action values and payload templates.
- `summarizeRule`, `summarizeCondition`, `summarizeAction`, and
  `summarizeValue` render readable block text.
- Vocabulary and limits are exported as frozen constants.

Validation errors have `{ path, code, message }`. Evaluation failures are
returned fail-closed by `evaluateRule`: `ok: false`, no actions, and an `error`
object. A malformed AST returns `valid: false` plus `validationErrors`.

## Evaluation context

```js
const context = {
  // An explicit deterministic clock, required for temporal operators.
  now: 1_700_000_000_000,

  // Either an exact-key map/object ...
  values: {
    'time.hour': 20,
    'location.person': 'home'
  },

  // ... or a resolver. Return undefined for an unavailable reference.
  resolve(ref) {},

  // Namespace resolvers are also supported.
  resolvers: {
    ha(path, fullRef) {}
  },

  // Temporal history interface. `test` receives the query below and must
  // synchronously return a boolean.
  history: {
    test({ operator, ref, expected, expectedProvided, durationMs, withinMs, now }) {}
  },

  // Explicit evaluators for custom operators.
  operators: {
    approximately({ left, right, node, now }) {}
  }
};
```

Instead of `history.test`, history may expose the corresponding method:
`changedTo`, `changedFrom`, `forDuration`, `within`, `hasBeen`, or
`hasntHappened`. Each receives the same frozen query object.

No resolver, history method, or custom operator may return a Promise. The
engine deliberately has no implicit `Date.now()`, network access, `eval`, or
action execution.

## Branch semantics

1. A disabled rule reads nothing and produces no actions.
2. `WHEN` is evaluated first. If it is false, no branch runs.
3. `IF` is evaluated only after `WHEN` matches.
4. `WHILE` is evaluated only after `WHEN` and `IF` match. It is a snapshot
   gate; the future runtime is responsible for re-evaluating it when relevant
   values change.
5. `THEN` is selected when all supplied gates are true.
6. `ELSE` is selected only when `WHEN` matched and `IF` or `WHILE` failed.

The result distinguishes `matched` (the `WHEN` block matched) from `triggered`
(all gates matched and `THEN` was selected).

## Extensions

Validation remains opt-in and strict. Supply `valueNamespaces`, `operators`,
`actionTypes`, or `actionPrefixes` in validation/evaluation options. Custom
operator implementations live in `context.operators`. Optional
`operatorValidators` and `actionValidators` can return an error string or an
array of error strings. Custom and `hud.*` actions use the canonical
`{ type, label?, payload? }` shape.

Default safety bounds limit recursive depth, conditions, actions, arrays,
objects, strings, data nodes, cycles, and reported errors. Override individual
limits with `options.limits` when importing trusted rules.

## Production runtime constraints

This module intentionally knows only the language. `server/automations.js`
adds source-aware validation and execution policy. In the production engine:

- `changed_to`/`changed_from` is allowed only in `WHEN`, never under `NOT`, and
  cannot be combined with a `WHILE` stage.
- Temporal operators are admitted only for references with a real durable
  transition source; timer/alarm rules use canonical `.status`, not the
  readable `.state` alias.
- Timer completion payloads must be static so every delayed action can be
  safety-audited before save.
- Every external action crosses the Tool Gateway under the `automation`
  trigger and its unattended-risk policy.

See `CARVIS_AUTOMATIONS.md` at the repository root for the complete runtime,
persistence, safety, WebUI, API, and operations reference.
