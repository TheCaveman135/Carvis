const MAX = 500;

const entries = [];
const subscribers = new Set();
let seq = 0;

/**
 * Append a log entry and push it to every live SSE subscriber.
 * level: 'info' | 'action' | 'think' | 'warn' | 'error'
 */
export function log(level, message, extra = {}) {
  const entry = { id: ++seq, ts: Date.now(), level, message, ...extra };
  entries.push(entry);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  const prefix = { error: '[!]', warn: '[~]', action: '[>]', think: '[*]' }[level] || '[ ]';
  console.log(`${prefix} ${message}`);
  broadcast({ type: 'log', entry });
  return entry;
}

export function recentLogs(limit = 200) {
  return entries.slice(-limit);
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function broadcast(msg) {
  for (const fn of subscribers) {
    try {
      fn(msg);
    } catch {
      subscribers.delete(fn);
    }
  }
}
