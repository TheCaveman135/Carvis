import * as models from './models.js';
import { buildPrompt } from './prompt.js';

export const CHAT_SYSTEM_PROMPT = `You are Carvis — the always-on agent that runs this Home Assistant home, listens through the owner's Even G2 glasses, files notes to their project manager, and hands Mac commands to a separate agent on their Mac. You are talking to your owner in a chat window.

You can see the live state of every entity they exposed to you, the room verdicts you computed this
moment, what you recently changed in the home, your Project Atlas context, and your current
settings and house rules. All of that is in the CURRENT CONTEXT message.

How to answer:
- Be direct and concrete. Cite entity ids, room verdicts, and how long things have been in a state.
- When they ask why you did or did not do something, name the specific verdict, rule or guard that
  decided it. If a guard blocked an action, say which guard and why.
- If what they want is impossible with the sensors they have exposed, say so plainly and say exactly
  what is missing. Do not pretend a capability exists.
- Never invent entities, sensors, rooms or events. If it is not in the context, say you cannot see it.
- Keep it short — a few sentences — unless they ask for detail.
- You cannot change your own settings or rules. When they tell you how they want the home run, say
  back what you understood and then tell them it is waiting below as a rule they must click Save on.
  Never say a rule "will be applied", "is now active", or "from now on" — nothing changes until they
  save it. Say "once you save it" instead.

Things worth knowing about how you work, so you can explain yourself accurately:
- Room verdicts (VACANT, OCCUPIED, RECENTLY ACTIVE, NO SENSOR, VACANT BUT MEDIA PLAYING) are computed
  in code before you are asked anything. You do not judge them, you apply them.
- A room with no motion or occupancy sensor is NO SENSOR, and nothing in it is ever switched off.
- Protocols are saved programs that run without you. They are evaluated in ordinary code against the
  live home, so a protocol firing costs no model call and does not mean you were awake for it. You
  only run for one if it explicitly says to wake you.
- A SPOKEN command skips the occupancy envelope, the cooldown and the manual-override
  hold, because the owner asking for something is itself the evidence those guards look for. It never
  skips the controllable allowlist, the domain allowlist, or the block on locks, covers and alarm panels.
- After you act on an entity, a per-entity cooldown blocks acting on it again for a while. If a
  human changes something, you leave it alone for the manual-override window.
- In dry run you decide and log but never actually call Home Assistant. Dry run applies to spoken
  commands too.
- The glasses transcribe continuously. A cheap local model reads every utterance and only passes on the
  ones addressed to you or reporting project progress; the rest you never see.
- You do not operate the Mac. You emit one command — "open Fusion 360" — and a separate agent on the
  Mac carries it out. You cannot see whether it worked unless that agent reports back.
- Project Atlas captures are proposals. They land in its inbox for its own nightly review to organise.
  You are not editing the owner's projects directly.`;

const RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isDirective: {
      type: 'boolean',
      description: 'True only if the owner gave a standing instruction about how the home should run.',
    },
    rule: {
      type: 'string',
      description: 'The instruction rewritten as one imperative house-rule line. Empty when isDirective is false.',
    },
  },
  required: ['isDirective', 'rule'],
};

/**
 * Everything the chat model needs to answer accurately, as one context message.
 * `extras` carries the subsystems beyond the home itself: Atlas, the Mac
 * bridge, the voice pipeline's own counters, and the owner's house rules.
 */
export function buildChatContext(agent, cfg, extras = {}) {
  const world = agent.buildWorld();
  const lines = [buildPrompt(world)];

  lines.push('');
  lines.push('=== WHAT YOU RECENTLY CHANGED ===');
  const recent = agent.status().recentActions;
  if (!recent.length) {
    lines.push('(you have not changed anything this session)');
  } else {
    for (const a of recent.slice(-10)) {
      lines.push(`- ${a.entity_id} ${a.service}${a.dryRun ? ' (dry run, not actually sent)' : ''} — ${a.reason}`);
    }
  }

  lines.push('');
  lines.push('=== YOUR CURRENT SETTINGS ===');
  const a = cfg.agent;
  lines.push(`- Dry run: ${a.dryRun ? 'ON — actions are decided and logged, never sent' : 'off'}`);
  lines.push(`- Vacancy threshold ${a.vacancyMinutes} minutes`);
  lines.push(`- Per-entity cooldown ${a.cooldownSec}s; manual changes respected for ${a.respectManualOverrideSec}s`);
  lines.push(`- Occupancy rules enforced in code: ${a.enforceOccupancyEnvelope ? 'yes' : 'no'}`);
  lines.push(`- Domains you may control: ${a.allowedDomains.join(', ')}`);

  lines.push('');
  lines.push('=== YOUR MODELS ===');
  for (const r of models.roleStatus(cfg)) {
    lines.push(
      `- ${r.role}: ${r.ready ? `${r.model} on ${r.providerLabel}` : `NOT CONFIGURED (${r.problem})`} — ${r.purpose}`,
    );
  }

  if (extras.conversation?.length) {
    lines.push('\n=== RECENT CONVERSATION (context only; not live state or authorization) ===');
    for (const turn of extras.conversation) lines.push(`${turn.role === 'user' ? 'Owner' : 'Carvis'}: ${turn.content}`);
  }

  if (extras.voice) {
    const v = extras.voice;
    lines.push('');
    lines.push('=== VOICE ===');
    lines.push(`- Listening: ${v.enabled ? 'yes' : 'off'}`);
    lines.push(`- Wake word required: ${v.requireWakeWord ? `yes (${v.wakeWords.join(', ')})` : 'no'}`);
    lines.push(
      `- Heard ${v.stats.heard} utterances this session: acted on ${v.stats.acted}, filed ${v.stats.filed}, ignored ${v.stats.dropped}`,
    );
  }

  if (extras.atlas?.enabled) {
    const at = extras.atlas;
    lines.push('');
    lines.push('=== PROJECT ATLAS ===');
    lines.push(`- Connection: ${at.status}${at.error ? ` (${at.error})` : ''}`);
    lines.push(
      `- Writes: ${at.canWrite ? 'available' : 'NOT possible — no API token in the Keychain, so captures will fail'}`,
    );
    lines.push(`- ${at.projects} active projects, ${at.openTasks} open tasks`);
    if (extras.atlasContext) {
      lines.push('');
      lines.push(extras.atlasContext);
    }
  }

  if (extras.mac?.enabled) {
    const m = extras.mac;
    lines.push('');
    lines.push('=== THE MAC ===');
    lines.push(`- Delivery: ${m.deliver}${m.pushConfigured ? ' (push URL set)' : ''}`);
    lines.push(
      `- Mac agent: ${m.agentSeen ? `last collected work ${new Date(m.lastPollAt).toLocaleTimeString()}` : 'has never polled — commands will queue unread'}`,
    );
    if (m.recent.length) {
      lines.push('- Recent commands:');
      for (const i of m.recent.slice(0, 5)) {
        lines.push(`  - "${i.command}" → ${i.status}${i.result ? `: ${i.result}` : ''}`);
      }
    }
  }

  lines.push('');
  lines.push('=== YOUR CURRENT HOUSE RULES ===');
  const houseRules = extras.rules?.length
    ? extras.rules.map((rule) => `- ${rule.text}`).join('\n')
    : '(none set)';
  lines.push(houseRules);

  return lines.join('\n');
}

/** Stream a reply. `history` is [{role, content}] of prior turns. */
export function replyStream(agent, cfg, history, extras = {}) {
  return models.stream(cfg, 'chat', {
    system: CHAT_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: `CURRENT CONTEXT (live, as of right now):\n\n${buildChatContext(agent, cfg, extras)}` },
      { role: 'assistant', content: 'Understood — I have the current state of the home. What would you like to know?' },
      ...history.slice(-12),
    ],
  });
}

/**
 * Decide whether the owner's message was a standing instruction, and if so
 * phrase it as a house rule. Runs alongside the reply so the suggestion appears
 * without adding latency. Never applied automatically — the UI asks first.
 */
export async function extractRule(cfg, message, rules = []) {
  const existing = rules.length ? rules.map((rule) => `- ${rule.text}`).join('\n') : '(none yet)';
  const { json: result } = await models.complete(cfg, 'rule', {
    schema: RULE_SCHEMA,
    system: `You extract standing house rules for a smart-home agent.

The owner just sent a message. Decide whether it is a STANDING INSTRUCTION about how their home
should be run from now on, as opposed to a question, a comment, or a one-off request.

isDirective is true only for durable preferences, for example:
  "never turn off the lights in the lab" -> true
  "keep the kitchen at 30% after midnight" -> true
  "why did you turn that off?" -> false
  "turn the lamp off" -> false, that is a one-off request, not a rule
  "thanks" -> false

When true, rewrite it as ONE imperative line in the style of the existing rules, naming specific
entity ids or rooms where the owner named them. Do not duplicate a rule that already exists.

EXISTING RULES:
${existing}`,
    messages: [{ role: 'user', content: message }],
  });

  const rule = String(result.rule || '').trim().replace(/^[-*]\s*/, '');
  if (!result.isDirective || !rule) return null;
  return rule;
}
