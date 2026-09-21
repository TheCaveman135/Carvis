// Context only admits a fragment to triage. It never authorizes an action.
const NAV = /^(?:(?:go|move)\s+(?:to\s+)?(?:the\s+)?)?(?:left|right|up|down|back|select|enter|home|menu)(?:\s+(?:once|again))?[.!?]*$/i;
const TV_TOPIC = /\b(?:apple tv|television|tv|remote|menu|navigate|navigation|netflix|hulu|disney|streaming)\b/i;
const WATCH = /^(?:(?:hey|yo)[,.!]?\s*)?(?:let['’]s\s+(?:watch|play|put on)|(?:watch|play|put on|find|search for))\s+\S/i;
const TV_STEP = /^(?:go|move|scroll)\s+(?:up|down|left|right)(?:\s+(?:a little bit|a bit|a little|once|again))?[.!?]*$/i;
const MEDIA = /^(?:next|previous|skip)(?:\s+(?:one|track|song))?[.!?]*$/i;
const FRAGMENT = /^(?:yes|no|again|the other one|that one|this one|same again|a little (?:more|less)|(?:red|green|blue|warm(?:er)?|cool(?:er)?)|(?:louder|quieter|brighter|dimmer)|\d{1,3}(?:\s*percent)?)[.!?]*$/i;
const CHAT = /^(?:why|how so|really|fair enough|makes sense|tell me more|go on|what about (?:that|it)|what do you think|that's (?:funny|interesting)|i (?:agree|disagree)|thanks|thank you)[.!?]*$/i;

export function followupContext(text, recent = []) {
  const current = String(text || '').trim();
  const pairs = [];
  for (let i = 0; i + 1 < recent.length; i += 2) {
    if (recent[i]?.role === 'user' && recent[i + 1]?.role === 'assistant') {
      pairs.push(recent.slice(i, i + 2));
    }
  }
  for (let i = pairs.length - 1; i >= 0; i--) {
    const [user, assistant] = pairs[i];
    if (i === pairs.length-1 && CHAT.test(current)) return {eligible:true,navigation:false};
    const prior = `${user.content} ${assistant.content}`;
    if (WATCH.test(current) && TV_TOPIC.test(prior)) return {eligible:true,navigation:false};
    if ((NAV.test(current) || TV_STEP.test(current)) && TV_TOPIC.test(prior)) {
      return { eligible: true, navigation: true };
    }
    if (MEDIA.test(current) && /\b(?:music|spotify|track|song|playlist|album)\b/i.test(prior)) {
      return { eligible: true, navigation: true };
    }
    if (FRAGMENT.test(current) && (/\?\s*$/.test(assistant.content) || /\b(?:lights?|lamps?|music|speaker|volume|brightness|color|colour|playlist|tv|television|menu)\b/i.test(prior))) {
      return { eligible: true, navigation: false };
    }
    // Keep earlier context through short steps, but stop at a new topic.
    if (!NAV.test(user.content) && !TV_STEP.test(user.content) && !MEDIA.test(user.content) && !FRAGMENT.test(user.content)) break;
  }
  return { eligible: false, navigation: false };
}
