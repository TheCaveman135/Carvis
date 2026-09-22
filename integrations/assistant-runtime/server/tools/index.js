/**
 * The tools Carvis can actually reach.
 *
 * These are semantic, not a passthrough. The model asks for "the workshop
 * lights at 80%", not `light.turn_on` with a service payload — partly because
 * typed intent is easier to validate, and partly because a raw service-call
 * tool is indistinguishable from giving the model your Home Assistant.
 *
 * There is still no `ha.call_service` escape hatch. The spec offers one; it
 *     would re-open everything the typed tools close, including the locks.
 * Security and environmental controls exist as typed commands now, but their
 * direct-owner and wellbeing invariants live in guards.js, beneath the model
 * and beneath config.
 *
 * Home Assistant writes still go through `guards.js` after passing here. The
 * gateway decides whether Carvis is *allowed* to act; the guards decide
 * whether the action is *sane*. Both have to agree.
 */
import { RISK } from './gateway.js';
import { str } from './schema.js';
import { buildVisionTools } from './vision.js';
import { buildHomeAssistantTools } from './home-assistant.js';
import { buildKnowledgeTools } from './knowledge.js';
import { buildMemoryTools } from './memory.js';
import { buildMacTools } from './mac.js';
import { buildDisplayTools } from './display.js';
import { buildAutomationTools } from './automation-rules.js';
import { buildCalculationTools } from './calculations.js';
import { buildTimeTools } from './time.js';
import { buildWeatherSpeechTools } from './weather-speech.js';

export { macBoundaryError } from './mac.js';

/** Compose the tool registry in its stable model-facing order. */
export function buildTools(dependencies) {
  return [
    ...buildVisionTools(dependencies),
    ...buildHomeAssistantTools(dependencies),
    ...buildKnowledgeTools(dependencies),
    ...buildMemoryTools(dependencies),
    ...buildMacTools(dependencies),
    ...buildDisplayTools(dependencies),
    ...buildAutomationTools(dependencies),
    ...buildCalculationTools(dependencies),
    ...buildTimeTools(dependencies),
    ...buildWeatherSpeechTools(dependencies),
    {
      name: 'carvis.escalate',
      description:
        'Ask for a stronger model to take over this turn. Use when the task needs deeper reasoning than you can give it — a large multi-system problem, a difficult judgement, heavy analysis. Keep working after calling this; the handoff happens at the end of the turn and everything you have found so far is carried over.',
      risk: RISK.READ,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: str('What makes this hard', 300) },
        required: ['reason'],
      },
      // Intercepted by the agent loop, which owns the handoff. Registered so
      // the schema reaches the model and the call is audited like any other.
      execute: ({ reason }) => ({ success: true, noted: reason }),
    },
  ];
}
