import { RISK } from './gateway.js';
import { str } from './schema.js';

export function buildMemoryTools({ memory, patterns }) {
  return [
    { name: 'memory.patterns', description: 'List tentative repeated request patterns with evidence counts. These are suggestions, never authorization to execute a routine.', risk: RISK.READ,
      schema: {type:'object',additionalProperties:false,properties:{},required:[]}, execute:()=>({success:true,patterns:patterns?.list() || []}) },
    { name: 'memory.dismiss_pattern', description: 'Dismiss a tentative pattern the owner says is wrong or unwanted; stop suggesting it.', risk: RISK.LOW,
      schema: {type:'object',additionalProperties:false,properties:{id:str('Pattern id from memory.patterns')},required:['id']}, execute:({id})=>patterns?.dismiss(id) || {success:false,error:'Patterns unavailable'} },

    /* ── Memory ─────────────────────────────────────────────── */
    {
      name: 'memory.remember',
      description:
        "Record something durable about the owner. Use `fact` for what is true (where things live, what they own, who people are) and `preference` for anything that should change how you behave — sleep hours, how they like to be spoken to, what they never want done without asking. Preferences are in front of you on every turn; facts are looked up when relevant. Write these when you learn something in passing, not only when asked to. One clear sentence, in your own words.",
      risk: RISK.MEDIUM,
      idempotent: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: str('One sentence, self-contained. It will be read without this conversation.', 240),
          kind: { type: 'string', enum: ['fact', 'preference'], description: 'Default fact.' },
        },
        required: ['text'],
      },
      execute: ({ text, kind = 'fact' }) => {
        const down = memoryUnavailable(memory);
        if (down) return down;
        try {
          const { memory: saved, status } = memory.remember({ text, kind, source: 'carvis' });
          return { success: true, status, id: saved.id, kind: saved.kind, remembered: saved.text };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
    },

    {
      name: 'memory.recall',
      description:
        'Search long-term facts, preferences and rules about the owner.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: str('Words to match against, e.g. printer filament', 200),
          limit: { type: 'integer', minimum: 1, maximum: 25 },
        },
        required: ['query'],
      },
      execute: ({ query, limit = 10 }) => {
        const down = memoryUnavailable(memory);
        if (down) return down;
        const found = memory.search(query, limit, ['fact', 'preference', 'rule']);
        memory.markUsed(found.map((item) => item.id));
        return {
          success: true,
          memories: found.map((item) => ({ id: item.id, kind: item.kind, text: item.text, source: item.source })),
          total: found.length,
        };
      },
    },

    {
      name: 'memory.forget',
      description:
        'Remove something you recorded, when it has turned out to be wrong or has stopped being true. You cannot remove a memory the owner wrote themselves — say so and let them do it.',
      risk: RISK.MEDIUM,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: str('The memory id, from memory.recall') },
        required: ['id'],
      },
      execute: ({ id }) => {
        const down = memoryUnavailable(memory);
        if (down) return down;
        const result = memory.forget(id, { by: 'carvis' });
        return result.ok ? { success: true, forgot: result.memory.text } : { success: false, error: result.error };
      },
    },
  ];
}

/**
 * Same doctrine as atlasUnavailable: a store that cannot be read must never be
 * reported as a store with nothing in it. "I don't remember that" and "I can't
 * check what I remember" are different sentences, and only one of them is true.
 */
function memoryUnavailable(memory) {
  if (!memory) {
    return { success: false, error: 'Memory is not wired up in this build. Say so; do not claim to have recorded anything.' };
  }
  const state = memory.state();
  if (!state.available) {
    return {
      success: false,
      error: `Memory is unavailable (${state.error}). Tell the owner you could not reach it rather than saying you remember nothing.`,
    };
  }
  return null;
}
