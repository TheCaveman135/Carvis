// A bounded grammar for explicit TV requests. Addressing and guards run elsewhere.
export function normalizeCommand(text) {
  return String(text || '').toLowerCase().trim().replace(/^[\s.,!?]+|[\s.,!?]+$/g, '')
    .replace(/^(?:(?:alright|all right|okay|ok)[.,!]?\s+)+/, '')
    .replace(/^(?:now |just |please )+/, '').replace(/,?\s+please$/, '').trim();
}

export function tvCommand(text, cfg, states, recent = [], inventory = []) {
  const said = normalizeCommand(text);
  const applePlayer=cfg.appleTv?.mediaPlayer;
  const controlled = new Set(cfg.entities?.controlled || []);
  const players = [...controlled].filter(id => id.startsWith('media_player.') && states.has(id) && (id===applePlayer || /(?:^|_)tv(?:_|$)/.test(id.slice(13))));
  const prior = recent.slice(-2).map(m => m.content).join(' ');
  const contextual = players.filter(id => {
    const name = id.slice(13).replaceAll('_', ' ');
    return prior.toLowerCase().includes(name) || (id===applePlayer && /apple tv/i.test(prior));
  });
  const resolve = (name) => {
    if (!name) return contextual.length === 1 ? contextual[0] : null;
    const label = name.replace(/^the /, '').trim();
    const matches = players.filter(id => {
      const entity = inventory.find(e => e.entity_id === id);
      return (id === applePlayer && label === 'apple tv')
        || label === id.slice(13).replaceAll('_', ' ')
        || label === String(entity?.name || '').toLowerCase()
        || (entity?.area && label === `${entity.area.toLowerCase()} tv`)
        || (label === 'tv' && players.length === 1);
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const suffix = /\s+on\s+(?:the\s+)?([a-z ]+tv)$/.exec(said);
  const navText = suffix ? said.slice(0, suffix.index) : said;
  const navTarget = resolve(suffix?.[1]);
  if (navTarget === applePlayer && controlled.has(applePlayer) && states.has(applePlayer)) {
    const steps = navText.split(/\s+(?:and\s+then|and|then)\s+/);
    const commands = [];
    for (const step of steps) {
      const match = /^(?:(?:go|move) (?:to )?(?:the )?|(?:press|tap) (?:the )?)?(left|right|up|down|back|select|enter|home|menu)(?: button| screen)?(?: (again|once|one more time|twice|two times|three times|four times|five times|[1-5] times))?$/.exec(step);
      if (!match) { commands.length = 0; break; }
      const count = {twice:2,'two times':2,'three times':3,'four times':4,'five times':5}[match[2]] || Number(match[2]?.[0]) || 1;
      const button = {back:'menu',enter:'select',home:'top_menu'}[match[1]] || match[1];
      for (let i=0;i<count;i++) commands.push({name:'ha.media.navigate',arguments:{entity_id:applePlayer,button}});
    }
    if (commands.length && commands.length <= 6) return {...commands[0],commands,tv:true,quiet:cfg.appleTv?.silentNavigation!==false,reply:`Apple TV: ${commands.length} button ${commands.length === 1 ? 'press' : 'presses'} accepted.`};
  }
  const first = /^(?:turn|switch) (on|off) (.+)$/.exec(said);
  const last = /^(?:turn|switch) (.+) (on|off)$/.exec(said);
  const playback = /^(pause|resume|play|stop)(?: (.+))?$/.exec(said);
  const action = first?.[1] || last?.[2] || playback?.[1];
  const target = resolve(first?.[2] || last?.[1] || playback?.[2]);
  if (!action || !target || cfg.appleTv?.shortReplies===false) return null;
  const power = Boolean(first || last);
  const label = target.slice(13).replaceAll('_',' ').replace(/\btv\b/, 'TV');
  const mapped = action === 'resume' ? 'play' : action;
  return {name:power?'ha.media.power':'ha.media.control',arguments:{entity_id:target,...(power?{state:mapped}:{action:mapped})},tv:true,
    reply:`${label[0].toUpperCase()+label.slice(1)} ${power?mapped:mapped==='pause'?'paused':mapped==='stop'?'stopped':'playback requested'}.`};
}
