/**
 * Project Atlas — reached through its Tailscale address, the local SSH tunnel,
 * or its LAN address, whichever answers first.
 *
 * Every route receives the bearer token when available (the tailnet requires
 * it for reads too). Writes require it. The token lives in
 * the macOS Keychain under the same service the `atlas` CLI uses — never in
 * config.json. Carvis *proposes*: overheard project talk becomes a capture for
 * Atlas's own nightly review to organise, not a direct edit to your projects.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { log } from './log.js';

const run = promisify(execFile);

export class AtlasClient {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.status = 'unknown'; // unknown | ok | unreachable | error
    this.error = '';
    this.version = '';
    this.tokenState = 'unknown'; // unknown | present | missing
    this.snapshot = { projects: [], tasks: [], briefing: null, fetchedAt: 0 };
    this.token = null;
    this.tokenCheckedAt = 0;
    this.activeEndpoint = null; // the one that answered last
    this.triedEndpoints = [];
  }

  /**
   * Every way we know of to reach Atlas, best first.
   *
   * Atlas has several usable routes: its Tailscale address from anywhere, the
   * SSH tunnel when it is up, and the raw LAN address at home. Rather
   * than making that a setting you have to change as you walk out of the house,
   * all of them are tried and whichever answers is used.
   */
  get endpoints() {
    const cfg = this.getConfig().atlas;
    const list = [...new Set(
      [...(cfg.endpoints || []), cfg.baseUrl].filter(Boolean).map((u) => u.replace(/\/+$/, '')),
    )];
    // Whatever worked last time goes first — reprobing the whole list on every
    // call would add a timeout to each request when the first option is down.
    if (this.activeEndpoint) {
      return [this.activeEndpoint, ...list.filter((u) => u !== this.activeEndpoint)];
    }
    return [...new Set(list)];
  }

  get base() {
    return this.activeEndpoint || this.endpoints[0] || '';
  }

  get enabled() {
    return Boolean(this.getConfig().atlas?.enabled);
  }

  /**
   * The write token, from the Keychain (preferred) or ATLAS_TOKEN. Cached for
   * a minute so a captured utterance does not shell out every time, but not
   * forever, so `atlas token set` takes effect without a restart.
   */
  async getToken() {
    if (!this.enabled) return null;
    const configured=this.getConfig().atlas?.token;
    if (configured) return configured;
    if (this.token && Date.now() - this.tokenCheckedAt < 60_000) return this.token;
    const cfg = this.getConfig();

    if (process.env.ATLAS_TOKEN) {
      this.token = process.env.ATLAS_TOKEN.trim();
      this.tokenState = 'present';
      this.tokenCheckedAt = Date.now();
      return this.token;
    }

    if (!cfg.atlas.keychainService || process.platform !== 'darwin') { this.tokenState='missing'; return null; }
    try {
      const { stdout } = await run('/usr/bin/security', [
        'find-generic-password',
        '-a', process.env.USER || '',
        '-s', cfg.atlas.keychainService,
        '-w',
      ]);
      const token = stdout.replace(/\n$/, '');
      // The Keychain will hand back anything that was stored; a value with
      // control bytes or spaces cannot go in an HTTP header.
      if (!token || token.length > 4096 || /[^\x21-\x7e]/.test(token)) {
        throw new Error('stored token is empty or contains bytes unsafe in a header');
      }
      this.token = token;
      this.tokenState = 'present';
    } catch {
      this.token = null;
      this.tokenState = 'missing';
    }
    this.tokenCheckedAt = Date.now();
    return this.token;
  }

  /**
   * `auth: true` means the call *requires* a token and fails without one —
   * that's writes. Reads pass no flag but still attach the token whenever one
   * is available: Atlas trusts localhost and the LAN implicitly, so reads were
   * unauthenticated over the SSH tunnel (which terminates at 127.0.0.1) and
   * over the raw LAN address — but that trust rightly doesn't extend to the
   * Tailscale interface, which now requires a token for reads too. Sending it
   * opportunistically means the same code path works over every endpoint
   * without needing to know which one answered.
   */
  async request(path, { method = 'GET', body, auth = false } = {}) {
    if (!this.enabled) throw new Error('Atlas integration is disabled.');
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';

    const token = await this.getToken();
    if (auth && !token) {
      throw new Error('Atlas write needs an API token. Store one with: atlas token set');
    }
    if (token) headers.Authorization = `Bearer ${token}`;

    const candidates = this.endpoints;
    if (!candidates.length) throw new Error('no Atlas address configured');

    let res = null;
    let lastError = null;
    this.triedEndpoints = [];

    for (const endpoint of candidates) {
      this.triedEndpoints.push(endpoint);
      try {
        res = await fetch(`${endpoint}/api/v1${path}`, {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
          // Short, because this loop may have several addresses to get through
          // and a wearable is waiting on the far end of it.
          signal: AbortSignal.timeout(this.activeEndpoint === endpoint ? 12_000 : 4_000),
        });
        this.activeEndpoint = endpoint;
        break;
      } catch (err) {
        lastError = err;
        // Only a transport failure is worth trying the next address for. An
        // HTTP error means Atlas answered, and the next address would answer
        // exactly the same way.
        if (this.activeEndpoint === endpoint) this.activeEndpoint = null;
      }
    }

    if (!res) {
      const err = new Error(
        `Cannot reach Atlas at any known address (${candidates.join(', ')}): ${lastError?.message || 'no route'}`,
      );
      err.unreachable = true;
      throw err;
    }

    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const detail = payload?.detail || text.slice(0, 200) || `HTTP ${res.status}`;
      const err = new Error(`Atlas ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  async health() {
    if (!this.enabled) {
      this.status = 'unknown';
      return null;
    }
    try {
      const info = await this.request('/healthz');
      this.status = info?.status === 'ok' ? 'ok' : 'error';
      this.version = info?.version || '';
      this.error = '';
      await this.getToken();
      return info;
    } catch (err) {
      this.status = err.unreachable || /fetch failed|ECONNREFUSED|timed out/i.test(err.message) ? 'unreachable' : 'error';
      this.error =
        this.status === 'unreachable'
          ? `No route to Atlas answered — tried ${this.triedEndpoints.join(', ') || '(nothing configured)'}. Check the Atlas host, Tailscale, SSH tunnel, LAN route, and API token.`
          : err.message;
      return null;
    }
  }

  /** Projects, open tasks and the latest briefing, cached per contextRefreshSec. */
  async refresh(force = false) {
    const cfg = this.getConfig();
    if (!this.enabled) return this.snapshot;
    const age = Date.now() - this.snapshot.fetchedAt;
    if (!force && age < cfg.atlas.contextRefreshSec * 1000) return this.snapshot;

    try {
      const [projects, tasks, briefing] = await Promise.all([
        this.request('/projects'),
        this.request('/tasks'),
        this.request('/briefings/latest').catch(() => null),
      ]);
      this.snapshot = {
        projects: (projects || []).filter((p) => p.state === 'active'),
        tasks: (tasks || []).filter((t) => t.state !== 'done'),
        briefing: briefing || null,
        fetchedAt: Date.now(),
      };
      this.status = 'ok';
      this.error = '';
    } catch (err) {
      this.status = err.unreachable || /fetch failed|ECONNREFUSED|timed out/i.test(err.message) ? 'unreachable' : 'error';
      this.error = err.message;
    }
    return this.snapshot;
  }

  /**
   * Scored retrieval.
   *
   * Pasting every project and task into every prompt costs tokens on every
   * call and buries whatever is actually relevant. This scores candidates
   * against what was said and hands back a short list.
   *
   * Scoring is deliberately plain — term overlap weighted by rarity, plus
   * boosts for recency and for whatever the owner is nearest to. No embeddings
   * and no extra service: over a few dozen projects, term overlap is most of
   * the benefit, and every point of the score can be explained.
   */
  retrieve({ query, limit = 12 } = {}) {
    const terms = tokenize(query);
    if (!terms.length) return [];

    const candidates = [
      ...this.snapshot.projects.map((p) => ({
        type: 'project',
        id: p.id,
        title: p.title,
        text: `${p.title} ${p.summary_md || ''} ${(p.body_md || '').slice(0, 600)}`,
        updatedAt: Date.parse(p.updated_at || p.created_at || 0) || 0,
      })),
      ...this.snapshot.tasks.map((t) => ({
        type: 'task',
        id: t.id,
        title: t.title,
        project: t.project_title,
        text: `${t.title} ${t.body_md || ''} ${t.project_title || ''}`,
        updatedAt: Date.parse(t.updated_at || t.created_at || 0) || 0,
      })),
    ];

    // Rarity: a word appearing in every project tells you nothing about which
    // one is meant, so it should not be what decides the ranking.
    const frequency = new Map();
    for (const candidate of candidates) {
      for (const token of new Set(tokenize(candidate.text))) {
        frequency.set(token, (frequency.get(token) || 0) + 1);
      }
    }

    const now = Date.now();
    // Deliberately not computed from `scored` — this needs to be visible
    // inside the map below too, so an exact title match can guarantee it
    // clears the same floor everything else is judged against.
    const ABSOLUTE_FLOOR = 3;
    const scored = candidates
      .map((candidate) => {
        const haystack = new Set(tokenize(candidate.text));
        const titleTerms = new Set(tokenize(candidate.title));
        let score = 0;
        for (const term of terms) {
          if (!haystack.has(term)) continue;
          const rarity = Math.log(1 + candidates.length / (frequency.get(term) || 1));
          score += rarity;
          // A hit in the title is a much stronger signal than one in the body.
          if (titleTerms.has(term)) score += rarity * 0.8;
        }
        if (!score) return null;

        // Every query term named in the title, not just the body: the owner
        // said exactly what this is called. Rarity math alone can still miss
        // the floor here purely because the corpus is small or the words are
        // common — guarantee it clears anyway, rather than lowering the floor
        // globally and reintroducing the false positives it exists to catch.
        if (terms.every((term) => titleTerms.has(term))) score = Math.max(score, ABSOLUTE_FLOOR);

        const ageDays = (now - candidate.updatedAt) / 86_400_000;
        if (Number.isFinite(ageDays)) score *= 1 + Math.max(0, 0.4 - ageDays * 0.02);
        return { ...candidate, score: Number(score.toFixed(3)) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return [];

    /**
     * Two floors, because a single weak match is worse than none: it puts a
     * project in front of the model that has nothing to do with what was said,
     * and the model will try to use it. "Turn off the kitchen lights" should
     * retrieve nothing, even though some project mentions Home Assistant.
     */
    const relative = scored[0].score * 0.35;
    return scored.filter((hit) => hit.score >= Math.max(ABSOLUTE_FLOOR, relative)).slice(0, limit);
  }

  /** Retrieval rendered for the prompt, or '' when nothing matched. */
  retrievalLines(query) {
    const hits = this.retrieve({ query });
    if (!hits.length) return '';
    const lines = ['=== RELEVANT IN PROJECT ATLAS ==='];
    for (const hit of hits) {
      lines.push(
        `- [${hit.type} ${hit.id}] "${hit.title}"${hit.project ? ` (${hit.project})` : ''} — relevance ${hit.score}`,
      );
    }
    lines.push('Use these ids verbatim. Call atlas.search or atlas.context.get if none of them fit.');
    return lines.join('\n');
  }

  /**
   * The block Carvis is shown so it can tell project talk from small talk.
   * Deliberately just titles and open tasks — the full project bodies are long
   * and the model only needs enough to decide "this is about the sample project".
   */
  contextLines() {
    const { projects, tasks, briefing } = this.snapshot;
    if (!projects.length && !tasks.length) return '';
    const lines = ['=== PROJECT ATLAS ==='];

    if (projects.length) {
      lines.push('Active projects (use these ids verbatim):');
      for (const p of projects) {
        lines.push(`- ${p.id} "${p.title}"${p.summary_md ? ` — ${p.summary_md.slice(0, 140)}` : ''}`);
      }
    }
    if (tasks.length) {
      lines.push('', 'Open tasks:');
      for (const t of tasks.slice(0, 40)) {
        lines.push(`- ${t.id} "${t.title}"${t.project_title ? ` [${t.project_title}]` : ''}`);
      }
    }
    if (briefing?.content?.next_actions?.length) {
      lines.push('', "Today's next actions:");
      for (const a of briefing.content.next_actions.slice(0, 5)) lines.push(`- ${a}`);
    }
    return lines.join('\n');
  }

  /**
   * File something you said as an Atlas capture. This is the propose step: the
   * capture lands in Atlas's inbox and its nightly review decides what it means,
   * exactly as a capture typed at the CLI would.
   */
  async capture({ text, title, projectId, channel = 'carvis' }) {
    const body = {
      text: String(text).slice(0, 8000),
      title: String(title || text).slice(0, 200),
      input_type: 'text',
      channel,
      idempotency_key: randomUUID(),
      ...(projectId ? { project_id: projectId } : {}),
    };

    try {
      return await this.request('/captures', { method: 'POST', body, auth: true });
    } catch (err) {
      // `channel` looks like a closed set server-side. If ours is rejected,
      // retry under the channel the shipped CLI uses rather than lose the note.
      if (err.status === 422 && channel !== 'macos-cli') {
        return this.request('/captures', {
          method: 'POST',
          body: { ...body, channel: 'macos-cli' },
          auth: true,
        });
      }
      throw err;
    }
  }

  /**
   * Create a task. Atlas's own field is `body_md`; the older `body` name is
   * sent as a fallback if the first shape is rejected, so a schema difference
   * between Atlas versions costs a retry rather than the task.
   */
  async createTask({ title, body, projectId }) {
    const base = { title: String(title).slice(0, 200) };
    if (projectId) base.project_id = projectId;

    try {
      const created = await this.request('/tasks', {
        method: 'POST',
        body: { ...base, body_md: String(body || '') },
        auth: true,
      });
      await this.refresh(true);
      return created;
    } catch (err) {
      if (err.status !== 422) throw err;
      const created = await this.request('/tasks', { method: 'POST', body: base, auth: true });
      await this.refresh(true);
      return created;
    }
  }

  /** Mark a task done. Atlas versions its rows, so a stale write is retried once. */
  async completeTask(taskId) {
    const task = this.snapshot.tasks.find((t) => t.id === taskId);
    const attempt = (version) =>
      this.request(`/tasks/${taskId}`, {
        method: 'PATCH',
        body: { state: 'done', ...(version != null ? { version } : {}) },
        auth: true,
      });

    try {
      const done = await attempt(task?.version);
      await this.refresh(true);
      return done;
    } catch (err) {
      if (err.status !== 409 && err.status !== 422) throw err;
      await this.refresh(true);
      const fresh = this.snapshot.tasks.find((t) => t.id === taskId);
      const done = await attempt(fresh?.version);
      await this.refresh(true);
      return done;
    }
  }

  /** Loose title match, for when speech names a task instead of its id. */
  findTask(phrase) {
    const needle = String(phrase || '').toLowerCase().trim();
    if (needle.length < 3) return null;
    const scored = this.snapshot.tasks
      .map((t) => {
        const title = t.title.toLowerCase();
        if (title === needle) return { t, score: 3 };
        if (title.includes(needle) || needle.includes(title)) return { t, score: 2 };
        const words = needle.split(/\s+/).filter((w) => w.length > 3);
        const hits = words.filter((w) => title.includes(w)).length;
        return { t, score: words.length && hits / words.length > 0.6 ? 1 : 0 };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.t || null;
  }

  state() {
    return {
      enabled: this.enabled,
      status: this.status,
      error: this.error,
      version: this.version,
      endpoint: this.activeEndpoint,
      endpoints: this.endpoints,
      tokenState: this.tokenState,
      canWrite: this.tokenState === 'present',
      projects: this.snapshot.projects.length,
      openTasks: this.snapshot.tasks.length,
      briefingDate: this.snapshot.briefing?.local_date || null,
      fetchedAt: this.snapshot.fetchedAt,
    };
  }
}

/**
 * Words worth matching on. Stopwords and very short tokens carry no signal and
 * would otherwise make every candidate look equally relevant.
 */
const STOPWORDS = new Set(
  ('the a an and or but if then than that this these those is are was were be been being do does did done ' +
    'have has had i me my we our you your it its of to in on at for with from by as so up out about into ' +
    'over under again just now still also very can will would should could what when where which who how ' +
    'carvis one two get got put set make made take took go going went')
    .split(' '),
);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/** One-shot reachability check for the "Test connection" button. */
export async function testAtlas(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/healthz`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const info = await res.json();
  log('info', `Atlas ${info.version} reachable — database ${info.database}`);
  return info;
}
