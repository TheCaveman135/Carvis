import { RISK } from './gateway.js';
import { str } from './schema.js';
import { MATH_OPERATIONS, calculateMath, collectionSize, countMatching, countOccurrences, evaluateMath } from '../automation-utils.js';

export function buildCalculationTools({ automations }) {
  return [
    /* ── Variables / count / math ────────────────────────────── */
    {
      name: 'variable.get',
      description: 'Read one persistent Carvis variable.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: { name: str('Variable name', 128) }, required: ['name'] },
      execute: ({ name }) => {
        const variable = automations?.variable(name);
        return variable ? { success: true, variable } : { success: false, error: `no variable ${name}` };
      },
    },
    {
      name: 'variable.list',
      description: 'List persistent Carvis variables.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: () => ({ success: true, variables: automations?.variables() || [] }),
    },
    {
      name: 'variable.set',
      description: 'Set a persistent named value for automations to share.',
      risk: RISK.LOW,
      schema: {
        type: 'object', additionalProperties: false,
        properties: { name: str('Variable name', 128), value: {} }, required: ['name', 'value'],
      },
      execute: ({ name, value }) => {
        try { return { success: true, variable: automations.setVariable(name, value, 'carvis') }; }
        catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'variable.increment',
      description: 'Atomically add to a numeric persistent variable. Safe when multiple events happen close together.',
      risk: RISK.LOW,
      schema: {
        type: 'object', additionalProperties: false,
        properties: { name: str('Variable name', 128), amount: { type: 'number' } }, required: ['name'],
      },
      execute: ({ name, amount = 1 }) => {
        try { return { success: true, variable: automations.incrementVariable(name, amount, 'carvis') }; }
        catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'variable.unset',
      description: 'Remove one persistent variable.',
      risk: RISK.LOW,
      schema: { type: 'object', additionalProperties: false, properties: { name: str('Variable name', 128) }, required: ['name'] },
      execute: ({ name }) => automations?.unsetVariable(name)
        ? { success: true, removed: name }
        : { success: false, error: `no variable ${name}` },
    },
    {
      name: 'math.calculate',
      description: 'Do bounded deterministic arithmetic. Use operation+operands for ordinary math, or expression for parentheses/functions. Never executes code.',
      risk: RISK.READ,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: MATH_OPERATIONS },
          operands: { type: 'array', items: { type: 'number' }, maxItems: 64 },
          expression: str('Optional safe arithmetic expression', 512),
          variables: { type: 'object', additionalProperties: true },
          precision: { type: 'integer', minimum: 0, maximum: 12 },
        },
        required: [],
      },
      execute: ({ operation, operands, expression, variables = {}, precision }) => {
        try {
          const result = expression
            ? evaluateMath(expression, variables)
            : calculateMath(operation, operands || [], { precision });
          return { success: true, result };
        } catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'count.items',
      description: 'Count items, occurrences, or items matching a small predicate. Does not use a model.',
      risk: RISK.READ,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          items: { type: 'array', items: {}, maxItems: 256 },
          mode: { type: 'string', enum: ['size', 'occurrences', 'matching'] },
          value: {},
          operator: { type: 'string', enum: ['truthy', 'falsy', 'equals', 'not_equals', 'contains', 'greater_than', 'less_than'] },
          path: str('Optional own-property path', 200),
          case_sensitive: { type: 'boolean' },
        },
        required: ['items'],
      },
      execute: ({ items, mode = 'size', value, operator, path, case_sensitive }) => {
        try {
          const count = mode === 'occurrences'
            ? countOccurrences(items, value, { caseSensitive: case_sensitive })
            : mode === 'matching'
              ? countMatching(items, { operator, value, path, caseSensitive: case_sensitive })
              : collectionSize(items);
          return { success: true, count };
        } catch (err) { return { success: false, error: err.message }; }
      },
    },
  ];
}
