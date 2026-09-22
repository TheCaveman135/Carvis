import { RISK } from './gateway.js';
import { str } from './schema.js';

export function buildMacTools({ mac }) {
  return [
    /* ── The Mac ────────────────────────────────────────────── */
    {
      name: 'mac.command',
      description:
        'Send one plain-language command to the agent running on the owner\'s Mac, e.g. "open Fusion 360". You do not operate the Mac yourself and cannot see the result unless that agent reports back.',
      risk: RISK.MEDIUM,
      idempotent: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: str('One imperative instruction', 500),
          detail: str('Any context the Mac agent might need', 1000),
        },
        required: ['command'],
      },
      execute: async ({ command, detail }, ctx) => {
        const unsafe = macBoundaryError(command, detail, ctx);
        if (unsafe) return { success: false, error: unsafe };
        const intent = await mac.dispatch({ command, detail: detail || '', source: 'carvis' });
        return {
          success: true,
          intent_id: intent.id,
          command: intent.command,
          status: intent.status,
          note: mac.lastPollAt ? 'queued for the Mac agent' : 'queued, but the Mac agent has never collected work',
        };
      },
    },

    {
      name: 'mac.get_state',
      description: 'What the Mac agent is doing: whether it is collecting work, and recent commands with their outcome.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: () => ({ success: true, ...mac.state() }),
    },
  ];
}

/** The Mac bridge is not an alternate path around home or Carvis safeguards. */
export function macBoundaryError(command, detail, ctx = {}) {
  const text = `${command || ''} ${detail || ''}`.toLowerCase();
  const home = /\b(home assistant|hass|lock|unlock|deadbolt|door|alarm|garage|thermostat|climate|heater|siren|valve|light|switch|fan|camera|scene|routine)\b/;
  const wellbeing = /\b(cpap|oxygen|ventilator|medical|medicine|medication|health|wellbeing|life support|humidifier|air purifier)\b/;
  const self = /\b(carvis|guard(?:s)?\.js|safety layer|config\.json)\b/;
  const indirect = /\b(shortcut|shortcuts|automation|script|shell|terminal|osascript|run|execute|trigger|schedule)\b/;
  const safeDesktopAction = /^\s*(?:open|launch|focus|show|switch to|bring up|search(?: (?:the )?(?:web|browser))?(?: for)?|look up|read)\b/;

  // A background event or a gesture that only confirmed "you meant Carvis"
  // must not be able to make arbitrary Mac work happen. The Mac agent is a
  // useful desktop helper, not a capability escape hatch for protocols.
  if (!['user_text', 'user_voice'].includes(ctx.triggerType || '')) {
    return 'Mac delegation is limited to a live owner request; protocols and background events cannot dispatch Mac work';
  }
  if (ctx.triggerType === 'user_voice' && !ctx.wakeWord) {
    return 'Mac delegation from speech requires a leading Carvis wake word; a swipe only confirms addressedness';
  }
  if (home.test(text)) return 'Mac delegation cannot control Home Assistant or security/environment devices; use the typed HA tools';
  if (wellbeing.test(text)) return 'Mac delegation cannot control health or wellbeing equipment';
  if (self.test(text)) return 'Mac delegation cannot edit, stop, or reconfigure Carvis or its safety boundary';
  if (indirect.test(text) || !safeDesktopAction.test(String(command || ''))) {
    return 'Mac delegation is limited to direct, read-only desktop navigation (open, show, focus, or search); it cannot run shortcuts, scripts, automations, or opaque commands';
  }
  return null;
}
