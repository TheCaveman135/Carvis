import { RISK } from './gateway.js';
import { str } from './schema.js';
import { search as googleSearch } from '../search.js';

export function buildKnowledgeTools({ agent, atlas }) {
  return [
    /* ── Project Atlas ──────────────────────────────────────── */
    {
      name: 'atlas.context.get',
      description:
        "The owner's current project context: active projects and open tasks. Call this before assuming which project 'this' or 'that' refers to.",
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: async () => {
        await atlas.refresh();
        const down = atlasUnavailable(atlas);
        if (down) return down;
        return {
          success: true,
          projects: atlas.snapshot.projects.map((p) => ({ id: p.id, title: p.title, summary: p.summary_md })),
          open_tasks: atlas.snapshot.tasks.map((t) => ({ id: t.id, title: t.title, project: t.project_title })),
          briefing: atlas.snapshot.briefing?.content?.summary || null,
        };
      },
    },

    {
      name: 'atlas.search',
      description:
        'Search projects and tasks in Project Atlas by keyword. Use this to resolve what the owner is referring to.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { query: str('What to look for') },
        required: ['query'],
      },
      execute: async ({ query }) => {
        await atlas.refresh();
        const down = atlasUnavailable(atlas);
        if (down) return down;
        const needle = query.toLowerCase();
        const hit = (text) => String(text || '').toLowerCase().includes(needle);
        const projects = atlas.snapshot.projects
          .filter((p) => hit(p.title) || hit(p.summary_md) || hit(p.body_md))
          .map((p) => ({ id: p.id, title: p.title, summary: p.summary_md }));
        const tasks = atlas.snapshot.tasks
          .filter((t) => hit(t.title) || hit(t.body_md))
          .map((t) => ({ id: t.id, title: t.title, project: t.project_title }));
        return { success: true, query, projects, tasks, total: projects.length + tasks.length };
      },
    },

    {
      name: 'web.search',
      description:
        'Search the live web for anything time-sensitive or outside training data -- news, prices, sports scores, current facts. Returns a synthesized answer with source links, not a raw list of hits.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { query: str('What to search for') },
        required: ['query'],
      },
      execute: async ({ query }) => {
        try {
          const result = await googleSearch(agent.getConfig(), query);
          if (!result.text) return { success: false, error: 'no answer found' };
          return { success: true, answer: result.text, sources: result.sources };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
    },

    {
      name: 'atlas.task.create',
      description:
        'Create a task in Project Atlas. Use for something the owner needs to do later. Attach it to a project when you are confident which one.',
      risk: RISK.MEDIUM,
      idempotent: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: str('Short imperative title', 200),
          body: str('Optional detail, in the owner\'s own words', 2000),
          project_id: str('Project id, copied verbatim from atlas.context.get'),
        },
        required: ['title'],
      },
      execute: async ({ title, body, project_id }) => {
        const created = await atlas.createTask({ title, body, projectId: project_id });
        return { success: true, task: { id: created?.id, title: created?.title || title }, project_id: project_id || null };
      },
    },

    {
      name: 'atlas.task.complete',
      description: 'Mark an Atlas task done. Only when the owner clearly finished that exact task.',
      risk: RISK.MEDIUM,
      idempotent: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { task_id: str('Task id, copied verbatim') },
        required: ['task_id'],
      },
      execute: async ({ task_id }) => {
        if (agent.getConfig().atlas?.completeTasks === false) {
          return { success: false, error: 'Task completion is disabled in Settings.' };
        }
        const task = atlas.snapshot.tasks.find((t) => t.id === task_id);
        await atlas.completeTask(task_id);
        return { success: true, task: { id: task_id, title: task?.title || '(unknown)', status: 'completed' } };
      },
    },

    {
      name: 'atlas.capture',
      description:
        "File a note to Atlas's inbox — an observation, a decision, or progress on a project. This proposes; Atlas's own review organises it. Use this rather than task.create for things that are not actions.",
      risk: RISK.MEDIUM,
      idempotent: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: str("The note, in the owner's own words", 4000),
          title: str('Short summary line', 200),
          project_id: str('Project id, copied verbatim, when you are confident'),
        },
        required: ['text'],
      },
      execute: async ({ text, title, project_id }) => {
        const capture = await atlas.capture({ text, title: title || text, projectId: project_id });
        return { success: true, capture: { id: capture?.id, title: capture?.title }, filed_to: project_id || 'inbox' };
      },
    },
  ];
}

/**
 * "Atlas is down" and "Atlas has nothing" are different answers, and a tool
 * that returns an empty list for both will get the second one repeated to the
 * owner as fact. This makes the difference explicit so Carvis says "I can't
 * reach Atlas" rather than "you have nothing open".
 */
function atlasUnavailable(atlas) {
  if (!atlas.enabled) {
    return { success: false, error: 'Project Atlas is switched off in settings. Say so; do not guess at its contents.' };
  }
  if (atlas.status === 'ok') return null;
  return {
    success: false,
    error:
      atlas.status === 'unreachable'
        ? `Cannot reach Project Atlas — no configured Tailscale, SSH-tunnel, or LAN route worked (${atlas.error || 'tried all known addresses'}). Tell the owner you could not check rather than saying there is nothing there.`
        : `Project Atlas returned an error: ${atlas.error}. Do not treat this as "nothing found".`,
    atlas_status: atlas.status,
  };
}
