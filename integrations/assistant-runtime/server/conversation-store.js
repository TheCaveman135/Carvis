import fs from 'node:fs';
const MAX_AGE = 24 * 60 * 60 * 1000;
export function cleanConversation(value, now = Date.now()) {
  if (!value || !Number.isFinite(value.updatedAt) || now - value.updatedAt > MAX_AGE || value.updatedAt > now + 60000) return {history:[],summary:''};
  const history = [];
  const raw = Array.isArray(value.history) ? value.history.slice(-32) : [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [user, assistant] = raw.slice(i, i + 2);
    if (user?.role !== 'user' || assistant?.role !== 'assistant' || typeof user.content !== 'string' || typeof assistant.content !== 'string') continue;
    if (!Number.isFinite(user.at) || now - user.at > MAX_AGE || user.at > now + 60000) continue;
    history.push(...[user, assistant].map(m => ({role:m.role,content:m.content.slice(0,8000),at:user.at})));
  }
  return {history,summary:typeof value.summary === 'string' ? value.summary.slice(0,1200) : ''};
}
export function conversationStore(path) {
  return {
    load() { try { return cleanConversation(JSON.parse(fs.readFileSync(path,'utf8'))); } catch { return {history:[],summary:''}; } },
    save(value) {
      const data = {...cleanConversation({...value,updatedAt:Date.now()}),updatedAt:Date.now()};
      const temp = path + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(data), {mode:0o600});
      fs.renameSync(temp,path);
    },
  };
}
