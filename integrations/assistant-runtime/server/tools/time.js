import { RISK } from './gateway.js';
import { str } from './schema.js';
import { nextAlarmOccurrence, parseDuration, parseTimeInput, timeSnapshot } from '../automation-utils.js';

export function buildTimeTools({ automations }) {
  return [
    /* ── Time, timers, alarms ────────────────────────────────── */
    {
      name: 'time.get',
      description: 'Get the exact local date, clock, weekday, timezone and UTC offset. For the owner’s current time, call with {}: the server supplies the correct local timezone. Only specify a timezone when the owner explicitly asks about another location.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: { time_zone: str('Optional IANA timezone for an explicitly requested other location. Omit for local time; never pass the word local.', 80) }, required: [] },
      execute: ({ time_zone }) => {
        try { return { success: true, ...timeSnapshot({ timeZone: time_zone || undefined }) }; }
        catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'time.parse',
      description: 'Turn a time of day, local date/time, or ISO timestamp into one exact future instant.',
      risk: RISK.READ,
      schema: {
        type: 'object', additionalProperties: false,
        properties: { value: str('e.g. 8:30 PM, 2026-08-15 20:30, or ISO time', 120), time_zone: str('IANA timezone', 80) },
        required: ['value'],
      },
      execute: ({ value, time_zone }) => {
        try { return { success: true, ...parseTimeInput(value, { timeZone: time_zone || undefined }) }; }
        catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'timer.start',
      description: 'Start a persistent timer. It survives a restart, posts to the HUD/feed, and can optionally speak or wake Carvis when finished.',
      risk: RISK.LOW,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: str('Short timer name', 120),
          duration: str('Duration such as 90 seconds, 20m, 1:30:00', 100),
          duration_seconds: { type: 'integer', minimum: 1, maximum: 31536000 },
          message: str('What to show when it ends', 500),
          speak: { type: 'boolean' },
          wake_carvis: { type: 'boolean' },
          media_player: str('Optional selected media_player entity', 160),
          tts_entity: str('Optional tts provider entity', 160),
        },
        required: ['name'],
      },
      execute: ({ name, duration, duration_seconds, message, speak, wake_carvis, media_player, tts_entity }) => {
        try {
          const durationMs = duration ? parseDuration(duration, { minimumMs: 1000 }) : Number(duration_seconds) * 1000;
          if (!Number.isFinite(durationMs)) throw new Error('duration or duration_seconds is required');
          const actions = wake_carvis ? [{ type: 'carvis.wake', prompt: message || `${name} finished` }] : [];
          const timer = automations.startTimer({ name, durationMs, payload: { message, speak, media_player, tts_entity, actions } });
          return { success: true, timer };
        } catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'timer.list',
      description: 'List Carvis-native timers and their remaining time.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: { active_only: { type: 'boolean' } }, required: [] },
      execute: ({ active_only = false }) => ({ success: true, timers: automations?.listTimers({ kind: 'timer', activeOnly: active_only }) || [] }),
    },
    {
      name: 'timer.get',
      description: 'Read one timer by id or name.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: { id: str('Timer id or exact name', 160) }, required: ['id'] },
      execute: ({ id }) => {
        const timer = automations?.getTimer(id);
        return timer?.kind === 'timer' ? { success: true, timer } : { success: false, error: `no timer ${id}` };
      },
    },
    ...['pause', 'resume', 'cancel'].map((operation) => ({
      name: `timer.${operation}`,
      description: `${operation[0].toUpperCase()}${operation.slice(1)} a persistent timer by id or name.`,
      risk: RISK.LOW,
      schema: { type: 'object', additionalProperties: false, properties: { id: str('Timer id or exact name', 160) }, required: ['id'] },
      execute: ({ id }) => {
        const existing = automations?.getTimer(id);
        if (!existing || existing.kind !== 'timer') return { success: false, error: `no timer ${id}` };
        const result = operation === 'pause'
          ? automations?.pauseTimer(id)
          : operation === 'resume'
            ? automations?.resumeTimer(id)
            : automations?.cancelTimerKind(id, 'timer');
        return result ? { success: true, [operation === 'cancel' ? 'cancelled' : 'timer']: result } : { success: false, error: `could not ${operation} timer ${id}` };
      },
    })),
    {
      name: 'alarm.create',
      description: 'Create a persistent alarm clock/reminder. This is not a Home Assistant security alarm.',
      risk: RISK.LOW,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: str('Alarm name', 120), at: str('Time of day, local date/time, or ISO timestamp', 120),
          time_zone: str('IANA timezone', 80), repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly'] },
          days: {
            type: 'array', maxItems: 7, uniqueItems: true,
            items: { type: 'string', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
          },
          message: str('What to announce', 500), speak: { type: 'boolean' },
          media_player: str('Optional selected media player', 160), tts_entity: str('Optional TTS provider', 160),
        },
        required: ['name', 'at'],
      },
      execute: ({ name, at, time_zone, repeat = 'none', days = [], message, speak = true, media_player, tts_entity }) => {
        try {
          const parsed = parseTimeInput(at, { timeZone: time_zone || undefined });
          if (days.length && repeat !== 'weekly') throw new Error('days can only be used with repeat=weekly');
          const snapshot = timeSnapshot({ now: parsed.epoch_ms, timeZone: parsed.time_zone });
          const schedule = {
            repeat,
            timeZone: parsed.time_zone,
            wallTime: snapshot.time,
            weekday: snapshot.weekday,
            ...(days.length ? { days } : {}),
          };
          const dueAt = repeat === 'none'
            ? parsed.epoch_ms
            : nextAlarmOccurrence({
              after: parsed.kind === 'time_of_day' ? Date.now() : parsed.epoch_ms - 1,
              wallTime: snapshot.time,
              timeZone: parsed.time_zone,
              repeat,
              days,
              weekday: snapshot.weekday,
            });
          const timer = automations.startTimer({
            name, dueAt, repeatMs: null, kind: 'alarm',
            payload: { message: message || name, speak, media_player, tts_entity, schedule },
          });
          return { success: true, alarm: timer };
        } catch (err) { return { success: false, error: err.message }; }
      },
    },
    {
      name: 'alarm.list',
      description: 'List Carvis alarm-clock/reminders. Security panels are separate Home Assistant entities.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: { active_only: { type: 'boolean' } }, required: [] },
      execute: ({ active_only = false }) => ({ success: true, alarms: automations?.listTimers({ kind: 'alarm', activeOnly: active_only }) || [] }),
    },
    {
      name: 'alarm.get',
      description: 'Read one Carvis alarm clock/reminder by id or exact name.',
      risk: RISK.READ,
      schema: { type: 'object', additionalProperties: false, properties: { id: str('Alarm id or exact name', 160) }, required: ['id'] },
      execute: ({ id }) => {
        const alarm = automations?.getTimer(id);
        return alarm?.kind === 'alarm' ? { success: true, alarm } : { success: false, error: `no alarm ${id}` };
      },
    },
    {
      name: 'alarm.cancel',
      description: 'Cancel a Carvis alarm clock/reminder.',
      risk: RISK.LOW,
      schema: { type: 'object', additionalProperties: false, properties: { id: str('Alarm id or exact name', 160) }, required: ['id'] },
      execute: ({ id }) => automations?.cancelTimerKind(id, 'alarm')
        ? { success: true, cancelled: id }
        : { success: false, error: `no active alarm ${id}` },
    },
    {
      name: 'alarm.snooze',
      description: 'Snooze a Carvis alarm clock/reminder.',
      risk: RISK.LOW,
      schema: {
        type: 'object', additionalProperties: false,
        properties: { id: str('Alarm id or exact name', 160), seconds: { type: 'integer', minimum: 10, maximum: 86400 } },
        required: ['id', 'seconds'],
      },
      execute: ({ id, seconds }) => {
        const alarm = automations?.snoozeAlarm(id, seconds * 1000);
        return alarm ? { success: true, alarm } : { success: false, error: `no alarm ${id}` };
      },
    },
  ];
}
