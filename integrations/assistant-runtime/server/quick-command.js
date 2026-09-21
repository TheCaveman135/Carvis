/** Exact single requests only. Classification, authentication and execution stay elsewhere. */
import { tvCommand, normalizeCommand } from './tv-command.js';
export function quickCommand(text, cfg, states = new Map(), recent = [], inventory = []) {
  let said = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  const first = said.match(/^([a-z]+)[,\s]+/);
  if (first && (cfg.voice?.wakeWords || []).includes(first[1])) said = said.slice(first[0].length);
  said = normalizeCommand(said);
  const controlled = cfg.entities?.controlled || [];
  const tv = tvCommand(said,cfg,states,recent,inventory);
  if (tv) return tv;
  if (/^clear (?:my |the )?(?:hud|screen|display)$/.test(said)) {
    return { name: 'hud.clear_all', arguments: {}, reply: 'Screen cleared, sir.' };
  }
  const match = /^(pause|resume|play|stop|skip|next|previous)(?: (spotify|the music|music|this song|the song|track|song))?$/.exec(said);
  if (!match) return null;
  const players = controlled.filter(id => id.startsWith('media_player.') && /(?:^|_)spotify(?:_|$)/.test(id.slice(13)) && states.has(id));
  if (players.length !== 1) return null;
  const id = players[0];
  // "Pause" must not pick Spotify when another player could be intended.
  if (match[2] !== 'spotify') {
    const active = controlled.filter(id => id.startsWith('media_player.') && ['playing', 'paused'].includes(states.get(id)?.state));
    if (active.length !== 1 || active[0] !== id) return null;
  }
  const action = { pause: 'pause', resume: 'play', play: 'play', stop: 'stop', skip: 'next', next: 'next', previous: 'previous' }[match[1]];
  const reply = { pause: 'Spotify paused, sir.', play: 'Spotify playback requested, sir.', stop: 'Spotify stopped, sir.', next: 'Next track requested, sir.', previous: 'Previous track requested, sir.' }[action];
  return { name: 'ha.media.control', arguments: { entity_id: id, action }, reply };
}

export function quickReply(command, result) {
  if (result.success !== true) return `I couldn't complete that, sir. ${result.error || result.message || 'The command was not confirmed.'}`;
  if (result.dry_run || result.changed?.some(item => item.dry_run)) return 'Dry run only, sir. Nothing was changed.';
  return command.reply;
}
