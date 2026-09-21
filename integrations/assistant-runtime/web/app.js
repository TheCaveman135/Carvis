const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const S = {
  config: null,
  status: null,
  entities: [],
  logs: [],
  observed: new Set(),
  controlled: new Set(),
  guards: {},
  ollamaOk: false,
  models: [],
  chat: [],
  chatBusy: false,
  restarting: false,
  roles: [],
  providers: [],
  modelLists: {}, // providerId -> [{name, label}], fetched once
  providerErrors: {},
  feed: [],
  voice: null,
  atlas: null,
  mac: null,
  cost: null,
  hud: null,
  glassesDisplay: null,
  classifier: null,
  session: null,
  transcript: null,
  trace: null,
  bindWarning: '',
  tools: [],
  memories: [],
  patterns: [],
  automations: null,
  automationCatalog: null,
  automationEditor: {
    mode: 'list',
    id: null,
    revision: null,
    draft: null,
    dirty: false,
    validation: [],
    testResult: null,
    history: null,
    testValues: {},
    saving: false,
  },
};

const CONTROLLABLE_DOMAINS = new Set([
  'light', 'switch', 'fan', 'input_boolean', 'media_player', 'scene', 'script', 'automation',
  'button', 'input_button', 'humidifier', 'climate', 'number', 'input_number', 'select',
  'input_select', 'vacuum', 'remote', 'cover', 'lock', 'alarm_control_panel', 'siren', 'valve', 'water_heater',
]);
const SENSITIVE_DOMAINS = new Set([
  'cover', 'lock', 'alarm_control_panel', 'siren', 'valve', 'water_heater',
  'climate', 'humidifier', 'scene', 'script', 'automation', 'button', 'input_button', 'remote',
]);

// Mirrors the typed, unattended subset accepted by ha.entity.command. Keeping
// the picker domain-specific prevents combinations the gateway will reject
// (for example `light.media_pause`) and avoids presenting secure/indirect
// controls as background-safe automation targets.
const AUTOMATION_SERVICES_BY_DOMAIN = Object.freeze({
  light: ['turn_on', 'turn_off', 'toggle'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle', 'set_percentage'],
  input_boolean: ['turn_on', 'turn_off', 'toggle'],
  media_player: ['turn_on', 'turn_off', 'media_play', 'media_pause', 'media_stop', 'volume_set'],
  number: ['set_value'],
  input_number: ['set_value'],
  select: ['select_option'],
  input_select: ['select_option'],
  vacuum: ['start', 'pause', 'stop', 'return_to_base'],
});
// Keep the editor's affordances aligned with the server's hard safety guard.
// This is still only UX (the server is the authority), but offering a target
// that can never run is worse than hiding it with an explanation.
const AUTOMATION_WELLBEING_HINT = /(?:^|[_.\s-])(heater|heating|temperature|nozzle|extruder|furnace|hvac|thermostat|air.?con|humidifier|dehumidifier|purifier|cpap|oxygen|medical|smoke|carbon.?monoxide|co_alarm|leak|flood|water|gas|valve|siren|alarm|lock|door|garage|stove|oven|kettle|iron|fireplace|electric.?blanket|speaker.?volume|headphone.?volume)(?:$|[_.\s-])/i;

/* ── plumbing ──────────────────────────────────────────────── */

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    if (res.status === 401) showAuthGate('login');
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.json();
}

let toastTimer;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/* ── boot ──────────────────────────────────────────────────── */

let bootInFlight = false;
let uiWired = false;
let eventStream = null;
let uiClock = null;

async function boot() {
  if (bootInFlight) return;
  bootInFlight = true;
  try {
    const auth = await fetch('/integrations/assistant-engine/api/auth/status', { cache: 'no-store' }).then((res) => res.json());
    if (!auth.authenticated) {
      showAuthGate(auth.configured ? 'login' : 'setup');
      return;
    }
    $('#authGate').hidden = true;
    $('#logoutBtn').hidden = false;
    if (!uiWired) {
      wireNav();
      wireDashboard();
      wireCarvis();
      wireAutomations();
      wireTranscript();
      wireTrace();
      wireChat();
      wireEntities();
      wireBehavior();
      wireMemory();
      wireModels();
      wireTools();
      wireSettings();
      wireConfirmation();
      uiWired = true;
    }

    applySnapshot(await api('/integrations/assistant-engine/api/state'));
    showRequestedView();
    if (integrationEnabled('protocols')) loadAutomationCatalog()
      .then(() => handleAutomationRoute())
      .catch((err) => toast(`Protocol catalog: ${err.message}`, true));
    // Model lists come from live providers and can be slow or unreachable, so
    // the UI is already usable before this resolves.
    refreshRoles().catch((err) => toast(err.message, true));
    if (integrationEnabled('learned-memory')) loadMemories().catch((err) => toast(err.message, true));
    connectStream();
    clearInterval(uiClock);
    uiClock = setInterval(() => {
      renderStatus(); // keeps the countdown honest
      renderGlassesDisplay(); // turns a stopped G2 from LIVE to OFFLINE on time
      renderConfirmation(); // ticks the countdown bar
    }, 1000);
  } finally {
    bootInFlight = false;
  }
}

function showAuthGate(mode) {
  const setup = mode === 'setup';
  const gate = $('#authGate');
  if (!gate) return;
  gate.hidden = false;
  $('#authIntro').textContent = setup
    ? 'Create the first Carvis account. Anyone who can reach this page can sign in after this.'
    : 'Sign in to use Carvis from this device.';
  $('#authSubmit').textContent = setup ? 'Create account' : 'Sign in';
  $('#authPasswordConfirmField').hidden = !setup;
  $('#authPassword').autocomplete = setup ? 'new-password' : 'current-password';
  $('#authUsernameField').hidden = false;
  $('#authForm').dataset.mode = mode;
  $('#authError').hidden = true;
  $('#authUsername').focus();
}

function wireAuth() {
  const form = $('#authForm');
  if (!form || form.dataset.wired) return;
  form.dataset.wired = 'true';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const setup = form.dataset.mode === 'setup';
    const username = $('#authUsername').value.trim();
    const password = $('#authPassword').value;
    const confirm = $('#authPasswordConfirm').value;
    const error = $('#authError');
    if (setup && password !== confirm) {
      error.textContent = 'Passwords do not match.';
      error.hidden = false;
      return;
    }
    const button = $('#authSubmit');
    button.disabled = true;
    error.hidden = true;
    try {
      const res = await fetch(setup ? '/integrations/assistant-engine/api/auth/setup' : '/integrations/assistant-engine/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || 'Could not sign in.');
      $('#authGate').hidden = true;
      boot().catch((err) => toast(err.message, true));
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  $('#logoutBtn').textContent = 'Back to Carvis';
  $('#logoutBtn').addEventListener('click', () => { window.location.assign('/'); });
}

function applySnapshot(snap) {
  S.config = snap.config;
  S.status = snap.status;
  S.entities = snap.entities;
  S.logs = snap.logs;
  S.observed = new Set(snap.config.entities.observed);
  S.controlled = new Set(snap.config.entities.controlled);
  S.guards = {...snap.config.entities.guards};
  S.roles = snap.roles || S.roles;
  S.voice = snap.voice || S.voice;
  S.transcript = snap.transcript || S.transcript;
  S.atlas = snap.atlas || S.atlas;
  S.mac = snap.mac || S.mac;
  S.feed = snap.feed?.entries || S.feed;
  S.cost = snap.cost || S.cost;
  S.hud = snap.hud || S.hud;
  S.glassesDisplay = snap.glassesDisplay || S.glassesDisplay;
  S.classifier = snap.classifier || S.classifier;
  S.session = snap.session || S.session;
  S.trace = snap.trace || S.trace;
  S.bindWarning = snap.bindWarning || '';
  S.tools = snap.tools || S.tools;
  S.automations = snap.automations || S.automations;
  $('#configPath').textContent = snap.configPath;

  fillBehaviorForm();
  fillSettingsForm();
  renderStatus();
  renderThink();
  renderLogs();
  renderAreas();
  renderEntityFilters();
  renderEntityTable();
  renderCarvis();
  renderTranscript();
  renderTrace();
  renderTools();
  renderAutomations();
  renderConfirmation();
}

function connectStream() {
  eventStream?.close();
  const es = new EventSource('/integrations/assistant-engine/api/events');
  eventStream = es;
  es.onopen = () => scheduleAutomationCatalogRefresh();
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello') {
      applySnapshot(msg);
      scheduleAutomationCatalogRefresh();
      return;
    }
    if (msg.type === 'status') {
      S.status = msg.status;
      renderStatus();
      renderThink();
      // The mute switch and Atlas token state both arrive on a plain status
      // broadcast, so the Carvis panel has to redraw with it.
      api('/integrations/assistant-engine/api/state')
        .then((snap) => {
          S.voice = snap.voice;
          S.atlas = snap.atlas;
          S.mac = snap.mac;
          S.config = snap.config;
          if (Array.isArray(snap.entities)) {
            // A phone may load while HA is connecting. Adopt the complete
            // fresh inventory on the next status event, instead of keeping an
            // empty/stale Entities page until a manual browser reload.
            S.entities = snap.entities;
            S.observed = new Set(snap.config?.entities?.observed || []);
            S.controlled = new Set(snap.config?.entities?.controlled || []);
            renderAreas();
            renderEntityFilters();
            renderEntityTable();
          }
          renderCarvis();
          scheduleAutomationCatalogRefresh();
        })
        .catch(() => {});
      return;
    }
    if (msg.type === 'confirmation') {
      if (S.voice) S.voice.confirmation = msg.confirmation;
      renderConfirmation();
      return;
    }
    if (msg.type === 'hud') {
      S.hud = msg.hud;
      // This is desired state only. "On the glasses" changes exclusively on
      // a bridge-confirmed report from the G2.
      return;
    }
    if (msg.type === 'glasses-display') {
      S.glassesDisplay = msg.glassesDisplay;
      renderGlassesDisplay();
      return;
    }
    if (msg.type === 'trace') {
      S.trace = msg.trace;
      renderTrace();
      return;
    }
    if (/^(automation|timer|alarm|variable)\./.test(msg.type || '')) {
      scheduleAutomationRefresh();
      return;
    }
    if (msg.type === 'transcript') {
      S.transcript = msg.transcript;
      renderTranscript();
      return;
    }
    if (msg.type === 'feed') {
      S.feed.push(msg.entry);
      if (S.feed.length > 60) S.feed.shift();
      renderCarvis();
      return;
    }
    if (msg.type === 'mac') {
      if (S.mac) {
        S.mac.recent = [msg.intent, ...S.mac.recent.filter((i) => i.id !== msg.intent.id)].slice(0, 20);
        renderCarvis();
      }
      return;
    }
    if (msg.type === 'restarting') {
      $('#tickSub').textContent = 'Restarting…';
      return;
    }
    if (msg.type === 'log') {
      S.logs.push(msg.entry);
      if (S.logs.length > 300) S.logs.shift();
      renderLogs();
      return;
    }
    if (msg.type === 'state') {
      const ent = S.entities.find((e) => e.entity_id === msg.entity_id);
      if (ent) {
        ent.state = msg.state;
        ent.last_changed = msg.last_changed;
        renderAreas();
        const cell = $(`#entBody tr[data-id="${CSS.escape(msg.entity_id)}"] .state`);
        if (cell) cell.textContent = msg.state;
      } else {
        // Newly discovered or previously unobserved HA entities do not yet
        // have a row to patch. Refresh the inventory once, rather than making
        // the owner reload the page to see them.
        api('/integrations/assistant-engine/api/state').then((snap) => {
          if (!Array.isArray(snap.entities)) return;
          S.entities = snap.entities;
          S.config = snap.config || S.config;
          S.observed = new Set(snap.config?.entities?.observed || []);
          S.controlled = new Set(snap.config?.entities?.controlled || []);
          renderAreas();
          renderEntityFilters();
          renderEntityTable();
        }).catch(() => {});
      }
      scheduleAutomationCatalogRefresh(1_500);
    }
    if (msg.type === 'ha-registries') {
      // HA just reassigned or renamed an area. Refresh the complete inventory
      // so the Rooms and Entities screens follow HA immediately, without
      // changing the owner's Observe/Control selection sets.
      api('/integrations/assistant-engine/api/state').then((snap) => {
        if (!Array.isArray(snap.entities)) return;
        S.entities = snap.entities;
        S.config = snap.config || S.config;
        S.observed = new Set(snap.config?.entities?.observed || []);
        S.controlled = new Set(snap.config?.entities?.controlled || []);
        renderAreas();
        renderEntityFilters();
        renderEntityTable();
        renderCarvis();
        scheduleAutomationCatalogRefresh();
      }).catch(() => {});
    }
  };
  es.onerror = () => {
    $('#haStatusText').textContent = 'server offline';
    $('#haDot').className = 'dot bad';
  };
}

/* ── nav ───────────────────────────────────────────────────── */

function integrationEnabled(id) { return S.config?.integrations?.[id] === true || S.config?.integrations?.[id]?.enabled === true; }

function showRequestedView() {
  const view = location.hash.slice(1).split('/')[0];
  if (!['dashboard','carvis','automations','transcript','trace','chat','entities','behavior','models','tools','settings'].includes(view)) return;
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach(element => element.classList.toggle('active', element.id === `view-${view}`));
  if (view === 'automations') renderAutomations();
}

function wireNav() {
  window.addEventListener('hashchange', () => { showRequestedView(); if (integrationEnabled('protocols')) handleAutomationRoute(); });
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    if (
      btn.dataset.view !== 'automations' &&
      S.automationEditor.mode === 'edit' &&
      S.automationEditor.dirty &&
      !confirm('Leave this protocol without saving your changes?')
    ) return;
    if (btn.dataset.view !== 'automations' && S.automationEditor.mode === 'edit') showAutomationList();
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
    if (btn.dataset.view === 'automations') renderAutomations();
    if (!location.hash.startsWith('#automations/') || btn.dataset.view !== 'automations') history.replaceState(null, '', `#${btn.dataset.view}`);
  });

  $('#modalClose').addEventListener('click', () => ($('#modal').hidden = true));
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') $('#modal').hidden = true;
  });
}

function showModal(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modal').hidden = false;
}

/* ── confirmation ──────────────────────────────────────────── */

/**
 * A staged critical action — typed request or a dashboard click on a lock,
 * alarm, etc. — waiting on a swipe/accept. Answering here resolves the exact
 * same pending confirmation the glasses show; it is not a separate approval.
 */
function wireConfirmation() {
  $('#confirmAccept').addEventListener('click', () => resolveConfirmationClick(true));
  $('#confirmDecline').addEventListener('click', () => resolveConfirmationClick(false));
}

async function resolveConfirmationClick(accepted) {
  const id = S.voice?.confirmation?.id;
  if (!id) return;
  $('#confirmAccept').disabled = true;
  $('#confirmDecline').disabled = true;
  try {
    await api('/integrations/assistant-engine/api/glasses/confirmation', { method: 'POST', body: JSON.stringify({ id, accepted }) });
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#confirmAccept').disabled = false;
    $('#confirmDecline').disabled = false;
  }
}

function renderConfirmation() {
  const banner = $('#confirmBanner');
  const c = S.voice?.confirmation;
  if (!banner || !c) {
    if (banner) banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $('#confirmPrompt').textContent = c.prompt;
  const span = Math.max(1, c.expiresAt - c.createdAt);
  const pct = Math.max(0, Math.min(100, ((c.expiresAt - Date.now()) / span) * 100));
  $('#confirmBar').style.width = `${pct}%`;
}

/* ── dashboard ─────────────────────────────────────────────── */

function wireDashboard() {
  $('#clearLogBtn').addEventListener('click', () => {
    S.logs = [];
    renderLogs();
  });

  $('#restartBtn').addEventListener('click', restartServer);
}

/**
 * Restart the server, then wait for it to answer again and reload. The page
 * cannot stay live across the handover — the SSE stream dies with the old
 * process — so a reload is the honest way back.
 */
async function restartServer() {
  if (!confirm('Restart the server? The agent pauses for a couple of seconds and in-memory state (cooldowns, manual-override holds) is cleared.')) {
    return;
  }
  const btn = $('#restartBtn');
  btn.disabled = true;
  btn.textContent = 'Restarting…';
  S.restarting = true;
  $('#tickSub').textContent = 'Restarting…';

  try {
    await api('/integrations/assistant-engine/api/restart', { method: 'POST', body: '{}' });
  } catch {
    // The server often dies mid-response; that is the expected path.
  }

  toast('Restarting — waiting for the server to come back…');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch('/integrations/assistant-engine/api/state', { cache: 'no-store' });
      if (res.ok) return location.reload();
    } catch {
      // still down
    }
  }

  S.restarting = false;
  btn.disabled = false;
  btn.textContent = 'Restart';
  toast('Server did not come back — check the terminal or logs/agent.log', true);
}

function renderStatus() {
  const st = S.status;
  if (!st || S.restarting) return; // the 1s tick must not overwrite "Restarting…"

  const haOk = st.ha.status === 'connected';
  $('#haDot').className = `dot ${haOk ? 'ok' : st.ha.status === 'connecting' ? 'pending' : 'bad'}`;
  $('#haStatusText').textContent = haOk
    ? `HA ${st.ha.version} · ${st.ha.entityCount} entities`
    : st.ha.error || st.ha.status;

  const unset = S.roles.filter((r) => !r.ready);
  $('#ollamaDot').className = `dot ${S.roles.length === 0 ? 'pending' : unset.length ? 'bad' : 'ok'}`;
  $('#ollamaStatusText').textContent = !S.roles.length
    ? 'Models…'
    : unset.length
      ? `${unset.length} role${unset.length === 1 ? '' : 's'} unset`
      : `${new Set(S.roles.map((r) => r.model)).size} models in use`;

  const at = S.atlas;
  $('#atlasDot').className = `dot ${!at?.enabled ? '' : at.status === 'ok' ? (at.canWrite ? 'ok' : 'pending') : 'bad'}`;
  $('#atlasStatusText').textContent = !at?.enabled
    ? 'Atlas off'
    : at.status === 'ok'
      ? `Atlas · ${at.openTasks} open${at.canWrite ? '' : ' · read-only'}`
      : at.status;

  const v = S.voice;
  $('#voiceDot').className = `dot ${!v?.enabled ? '' : 'ok'}`;
  $('#voiceStatusText').textContent = !v?.enabled ? 'Voice off' : `Listening · ${v.stats.heard} heard`;

  const pulse = $('#brandPulse');
  pulse.className = `pulse ${S.carvis?.busy ? 'busy' : 'live'}`;

  $('#dryRunBadge').hidden = !st.dryRun;

  const acted = st.recentActions?.length || 0;
  let sub = acted ? `${acted} change${acted === 1 ? '' : 's'} this session` : 'Idle';
  if (st.lastError) sub += ` · last error: ${st.lastError}`;
  $('#tickSub').textContent = sub;

  $('#watchCount').textContent = `${S.observed.size} observed · ${S.controlled.size} controllable`;
}

/**
 * What actually reached Home Assistant, newest first. There is no periodic
 * "decision" to show anymore — protocols and spoken commands each act on their
 * own schedule, so the honest readout is the executed actions themselves.
 */
function renderThink() {
  const actions = S.status?.recentActions || [];
  const box = $('#thinkBody');
  const meta = $('#thinkMeta');
  if (!box) return;

  if (!actions.length) {
    meta.textContent = '';
    box.innerHTML = '<p class="empty">Nothing changed yet. Protocols and spoken commands show up here as they act.</p>';
    return;
  }

  meta.textContent = ago(actions[actions.length - 1].ts);
  box.innerHTML = [...actions]
    .reverse()
    .map((a) => `<div class="action-row"><span class="tick">●</span><div><code>${escapeHtml(a.entity_id)}</code> ${escapeHtml(String(a.service).replace('turn_', ''))}${a.brightness_pct ? ` @${a.brightness_pct}%` : ''}${a.dryRun ? ' <span class="muted">(dry run)</span>' : ''} <span class="muted">${escapeHtml(ago(a.ts))}</span><div class="why">${escapeHtml(a.reason || '')}</div></div></div>`)
    .join('');
}

function renderLogs() {
  $('#logList').innerHTML = S.logs
    .slice(-150)
    .map(
      (l) =>
        `<div class="log-row ${l.level}"><time>${fmtTime(l.ts)}</time><span class="msg">${escapeHtml(l.message)}</span></div>`,
    )
    .join('');
}

function renderAreas() {
  const grid = $('#areaGrid');
  const watched = S.entities.filter((e) => S.observed.has(e.entity_id) || S.controlled.has(e.entity_id));
  if (!watched.length) {
    grid.innerHTML =
      '<p class="empty">Nothing selected yet — open <strong>Entities</strong> and pick what the agent can see and control.</p>';
    return;
  }

  const byArea = new Map();
  for (const e of watched) {
    if (!byArea.has(e.area)) byArea.set(e.area, []);
    byArea.get(e.area).push(e);
  }

  grid.innerHTML = [...byArea.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([area, items]) => {
      const rows = items
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
        .map((e) => {
          const on = e.state === 'on' || e.state === 'playing' || e.state === 'home';
          const cls = e.state === 'on' ? 'on' : e.state === 'detected' ? 'detected' : '';
          const command = quickCommand(e, on);
          const ctl = S.controlled.has(e.entity_id) && command
            ? `<button class="ctl" data-entity="${escapeHtml(e.entity_id)}" data-service="${command.service}">${command.label}</button>`
            : '';
          return `<div class="ent-row"><span class="nm" title="${escapeHtml(e.entity_id)}">${escapeHtml(e.name)}</span><span class="st ${cls}">${escapeHtml(e.state)}${e.unit ? escapeHtml(e.unit) : ''}</span>${ctl}</div>`;
        })
        .join('');
      return `<div class="area"><h3>${escapeHtml(area)}</h3>${rows}</div>`;
    })
    .join('');

  grid.querySelectorAll('.ctl').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await api('/integrations/assistant-engine/api/control', {
        method: 'POST',
        body: JSON.stringify({ entity_id: btn.dataset.entity, service: btn.dataset.service }),
      });
      if (!r.ok) toast(r.message, true);
      else if (r.outcome === 'confirmation') toast('Confirm on your glasses or here');
      btn.disabled = false;
    }),
  );
}

function quickCommand(entity, on) {
  if (!CONTROLLABLE_DOMAINS.has(entity.domain)) return null;
  if (entity.domain === 'lock') return entity.state === 'locked'
    ? { service: 'unlock', label: 'unlock' }
    : { service: 'lock', label: 'lock' };
  if (entity.domain === 'cover') return entity.state === 'open'
    ? { service: 'close_cover', label: 'close' }
    : { service: 'open_cover', label: 'open' };
  if (entity.domain === 'alarm_control_panel') return entity.state.startsWith('armed')
    ? { service: 'alarm_disarm', label: 'disarm' }
    : { service: 'alarm_arm_home', label: 'arm home' };
  if (entity.domain === 'vacuum') {
    if (entity.state === 'cleaning') return { service: 'pause', label: 'pause' };
    if (entity.state === 'paused') return { service: 'start', label: 'resume' };
    return { service: 'start', label: 'start' };
  }
  if (entity.domain === 'valve') return entity.state === 'open'
    ? { service: 'close_valve', label: 'close' }
    : { service: 'open_valve', label: 'open' };
  if (entity.domain === 'button' || entity.domain === 'input_button') return { service: 'press', label: 'press' };
  if (entity.domain === 'scene' || entity.domain === 'script') return { service: 'turn_on', label: 'run' };
  if (['number', 'input_number', 'select', 'input_select'].includes(entity.domain)) return null;
  return { service: on ? 'turn_off' : 'turn_on', label: on ? 'off' : 'on' };
}

/* ── chat ──────────────────────────────────────────────────── */

function wireChat() {
  const form = $('#chatForm');
  const input = $('#chatText');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send(input.value);
  });

  // Enter sends, Shift+Enter makes a newline.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  });

  $('#chatLog').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip.suggest');
    if (chip) send(chip.textContent);
  });

  $('#chatClearBtn').addEventListener('click', () => {
    S.chat = [];
    $('#chatLog').innerHTML = '';
    addChatMessage('agent', 'New conversation. I still see the live state of the home.');
  });

  $('#chatContextBtn').addEventListener('click', async () => {
    const { context } = await api('/integrations/assistant-engine/api/chat/context');
    showModal('Everything the chat can see right now', context);
  });

  function send(text) {
    const message = text.trim();
    if (message && !S.chatBusy) {
      input.value = '';
      input.style.height = 'auto';
      sendChat(message);
    }
  }
}

function addChatMessage(role, text) {
  const log = $('#chatLog');
  $('.chat-intro')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="who">${role === 'user' ? 'You' : 'HB'}</div><div class="bubble"></div>`;
  el.querySelector('.bubble').textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el.querySelector('.bubble');
}

async function sendChat(message) {
  S.chatBusy = true;
  $('#chatSend').disabled = true;
  addChatMessage('user', message);
  S.chat.push({ role: 'user', content: message });

  const bubble = addChatMessage('agent', '');
  bubble.innerHTML = '<span class="cursor">&nbsp;</span>';
  const log = $('#chatLog');
  let reply = '';

  try {
    const res = await fetch('/integrations/assistant-engine/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: S.chat }),
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);

        if (msg.type === 'chunk') {
          reply += msg.text;
          bubble.textContent = reply;
          log.scrollTop = log.scrollHeight;
        } else if (msg.type === 'rule') {
          offerRule(msg.rule);
        } else if (msg.type === 'error') {
          bubble.parentElement.classList.add('error');
          bubble.textContent = reply ? `${reply}\n\n[${msg.message}]` : msg.message;
        }
      }
    }

    if (reply) S.chat.push({ role: 'assistant', content: reply });
    else if (!bubble.textContent) bubble.textContent = '(no reply)';
  } catch (err) {
    bubble.parentElement.classList.add('error');
    bubble.textContent = `Could not reach the model: ${err.message}`;
  } finally {
    bubble.querySelector('.cursor')?.remove();
    S.chatBusy = false;
    $('#chatSend').disabled = false;
    $('#chatText').focus();
  }
}

/**
 * The model thought the last message was a standing instruction. Offer it as a
 * house rule — editable, and never saved without a click.
 */
function offerRule(rule) {
  const log = $('#chatLog');
  const box = document.createElement('div');
  box.className = 'rule-offer';
  box.innerHTML = `
    <div class="lbl">Save as a house rule?</div>
    <textarea rows="2"></textarea>
    <div class="acts">
      <button class="btn tiny primary">Save rule</button>
      <button class="btn tiny ghost">Dismiss</button>
    </div>`;
  const textarea = box.querySelector('textarea');
  textarea.value = rule;
  const [saveBtn, dismissBtn] = box.querySelectorAll('button');

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const r = await api('/integrations/assistant-engine/api/rules/append', {
      method: 'POST',
      body: JSON.stringify({ rule: textarea.value.trim() }),
    });
    if (r.ok) {
      box.innerHTML = '<div class="lbl">Saved — it binds Carvis from the next turn.</div>';
      toast('House rule saved to memory');
      loadMemories().catch(() => {});
    } else {
      saveBtn.disabled = false;
      toast(r.message, true);
    }
  });

  dismissBtn.addEventListener('click', () => box.remove());

  log.appendChild(box);
  log.scrollTop = log.scrollHeight;
}

/* ── entities ──────────────────────────────────────────────── */

function wireEntities() {
  for (const id of ['#entSearch', '#entArea', '#entDomain', '#entOnlySelected']) {
    $(id).addEventListener('input', renderEntityTable);
  }

  $('#entBody').addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.dataset.kind === 'guard') { S.guards[cb.dataset.id] = cb.value; return; }
    if (cb.type !== 'checkbox') return;
    const id = cb.dataset.id;
    const set = cb.dataset.kind === 'observe' ? S.observed : S.controlled;
    if (cb.checked) set.add(id);
    else set.delete(id);
    // Controlling something implies observing it.
    if (cb.dataset.kind === 'control' && cb.checked) {
      S.observed.add(id);
      const obs = $(`#entBody input[data-kind="observe"][data-id="${CSS.escape(id)}"]`);
      if (obs) obs.checked = true;
    }
    updateSelCount();
  });

  $('#bulkObserve').addEventListener('click', () => {
    visibleEntities().forEach((e) => S.observed.add(e.entity_id));
    renderEntityTable();
  });

  $('#bulkControl').addEventListener('click', () => {
    visibleEntities().filter((e) => CONTROLLABLE_DOMAINS.has(e.domain)).forEach((e) => {
      S.controlled.add(e.entity_id);
      S.observed.add(e.entity_id);
    });
    renderEntityTable();
  });

  $('#bulkClear').addEventListener('click', () => {
    visibleEntities().forEach((e) => {
      S.observed.delete(e.entity_id);
      S.controlled.delete(e.entity_id);
    });
    renderEntityTable();
  });

  $('#saveEntitiesBtn').addEventListener('click', async () => {
    await saveConfig({ entities: { observed: [...S.observed], controlled: [...S.controlled], guards: S.guards } });
    toast(`Saved — ${S.observed.size} observed, ${S.controlled.size} controllable`);
    renderAreas();
  });
}

function renderEntityFilters() {
  const areas = [...new Set(S.entities.map((e) => e.area))].sort();
  const domains = [...new Set(S.entities.map((e) => e.domain))].sort();
  const keepArea = $('#entArea').value;
  const keepDomain = $('#entDomain').value;
  $('#entArea').innerHTML =
    '<option value="">All rooms</option>' + areas.map((a) => `<option>${escapeHtml(a)}</option>`).join('');
  $('#entDomain').innerHTML =
    '<option value="">All types</option>' + domains.map((d) => `<option>${escapeHtml(d)}</option>`).join('');
  $('#entArea').value = keepArea;
  $('#entDomain').value = keepDomain;
}

function visibleEntities() {
  const q = $('#entSearch').value.trim().toLowerCase();
  const area = $('#entArea').value;
  const domain = $('#entDomain').value;
  const onlySel = $('#entOnlySelected').checked;
  return S.entities.filter((e) => {
    if (area && e.area !== area) return false;
    if (domain && e.domain !== domain) return false;
    if (onlySel && !S.observed.has(e.entity_id) && !S.controlled.has(e.entity_id)) return false;
    if (q && !`${e.name} ${e.entity_id} ${e.area}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderEntityTable() {
  const rows = visibleEntities();
  const shown = rows.slice(0, 600);

  $('#entBody').innerHTML = shown
    .map((e) => {
      const canControl = CONTROLLABLE_DOMAINS.has(e.domain);
      return `<tr data-id="${escapeHtml(e.entity_id)}">
        <td><span class="nm">${escapeHtml(e.name)}</span><span class="eid">${escapeHtml(e.entity_id)}</span></td>
        <td>${escapeHtml(e.area)}</td>
        <td class="state">${escapeHtml(e.state)}</td>
        <td class="center"><input type="checkbox" data-kind="observe" data-id="${escapeHtml(e.entity_id)}" ${S.observed.has(e.entity_id) ? 'checked' : ''} /></td>
        <td class="center">${canControl ? `<input type="checkbox" data-kind="control" data-id="${escapeHtml(e.entity_id)}" ${S.controlled.has(e.entity_id) ? 'checked' : ''} />` : '<span class="muted">—</span>'}</td>
        <td>${canControl ? `<select data-kind="guard" data-id="${escapeHtml(e.entity_id)}" aria-label="Guard for ${escapeHtml(e.name)}">${[['auto','Automatic'],['standard','Standard'],['protected','Protected']].map(([value,label])=>`<option value="${value}" ${value===(S.guards[e.entity_id] || 'auto')?'selected':''} >${label}</option>`).join('')}</select><small>Effective: ${escapeHtml(e.effectiveGuard || 'automatic')}</small>` : '—'}</td>
      </tr>`;
    })
    .join('');

  $('#entFooter').textContent = S.entities.length
    ? `Showing ${shown.length} of ${rows.length} matching (${S.entities.length} total).${rows.length > shown.length ? ' Narrow the filters to see the rest.' : ''}`
    : 'No entities — connect Home Assistant in Settings first.';
  updateSelCount();
}

function updateSelCount() {
  $('#selCount').textContent = `${S.observed.size} observed · ${S.controlled.size} controllable`;
}

/* ── behavior ──────────────────────────────────────────────── */

const NUM_FIELDS = ['vacancyMinutes', 'cooldownSec', 'respectManualOverrideSec'];

function wireBehavior() {
  $('#saveBehaviorBtn').addEventListener('click', async () => {
    const agent = {};
    for (const f of NUM_FIELDS) agent[f] = Number($(`#${f}`).value);
    agent.dryRun = $('#dryRun').checked;
    agent.enforceOccupancyEnvelope = $('#enforceOccupancyEnvelope').checked;
    agent.allowedDomains = $$('#domainChips .chip.on').map((c) => c.dataset.domain);

    const areaNotes = {};
    $$('#areaNotes input').forEach((i) => {
      if (i.value.trim()) areaNotes[i.dataset.area] = i.value.trim();
    });

    const carvis = { personality: $('#personality').value };

    await saveConfig({ agent, areaNotes, carvis });
    toast('Saved');
  });

  $('#domainChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.classList.contains('locked')) return;
    chip.classList.toggle('on');
  });

  // The switches save on flip. Leaving them behind the Save button made them
  // look applied when they were not — the numeric fields still need Save,
  // because you are mid-edit while typing in them.
  for (const id of ['#dryRun', '#enforceOccupancyEnvelope']) {
    $(id).addEventListener('change', () => saveSwitch(id.slice(1)));
  }
}

const ARMING_WARNINGS = {
  dryRun: (n) =>
    `Turn dry run OFF?\n\nCarvis and your protocols will start actually controlling your home, across the ${n} entities you marked controllable.\n\nUntil now it has only been logging what it would do.`,
  enforceOccupancyEnvelope: () =>
    'Stop enforcing occupancy rules in code?\n\nThe model\'s judgement becomes final: nothing will re-check that a room is actually vacant before switching things off.',
};

async function saveSwitch(field) {
  const el = $(`#${field}`);
  const checked = el.checked;
  // Both of these switches are protective when ON, so only turning them off needs a warning.
  const warn = !checked && ARMING_WARNINGS[field];
  if (warn && !confirm(warn(S.controlled.size))) {
    el.checked = true;
    return;
  }
  await saveConfig({ agent: { [field]: checked } });
  const labels = {
    dryRun: checked ? 'Dry run on — nothing will be sent to Home Assistant' : 'Dry run OFF — Carvis is now controlling your home',
    enforceOccupancyEnvelope: checked ? 'Occupancy rules enforced in code' : 'Occupancy enforcement off — the model decides',
  };
  toast(labels[field]);
}

function wireMemory() {
  $('#patternList')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-dismiss-pattern]');
    if (!button) return;
    button.disabled = true;
    try { await api('/integrations/assistant-engine/api/patterns/dismiss',{method:'POST',body:JSON.stringify({id:button.dataset.dismissPattern})}); await loadMemories(); toast('Pattern dismissed'); }
    catch (error) { toast(error.message,'bad'); button.disabled = false; }
  });

  $('#memoryAddForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('#memoryAddText').value.trim();
    if (!text) return;
    const kind = $('#memoryAddKind').value;
    try {
      await api('/integrations/assistant-engine/api/memories', { method: 'POST', body: JSON.stringify({ text, kind }) });
      $('#memoryAddText').value = '';
      await loadMemories();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#memoryList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const memory = S.memories.find((m) => m.id === id);
    if (!memory) return;

    if (action === 'delete') {
      if (!confirm(`Forget this?\n\n"${memory.text}"`)) return;
      try {
        await api('/integrations/assistant-engine/api/memories/delete', { method: 'POST', body: JSON.stringify({ id }) });
        await loadMemories();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (action === 'edit') {
      const next = prompt('Edit memory', memory.text);
      if (next === null || !next.trim() || next.trim() === memory.text) return;
      try {
        await api('/integrations/assistant-engine/api/memories/update', { method: 'POST', body: JSON.stringify({ id, text: next.trim() }) });
        await loadMemories();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });
}

async function loadMemories() {
  const r = await api('/integrations/assistant-engine/api/memories');
  S.memories = r.memories;
  S.patterns = r.patterns || [];
  renderMemory();
}

function renderMemory() {
  const patterns = $('#patternList');
  if (patterns) patterns.innerHTML = S.patterns.length ? S.patterns.map(p => `<div class="log-row"><div style="flex:1"><span class="msg">${escapeHtml(p.description)}</span><small class="muted">${p.observations} observations · ${p.days} separate days · ${p.support}% of comparable requests · last ${ago(p.lastSeen)}</small></div><button class="btn tiny ghost" data-dismiss-pattern="${escapeHtml(p.id)}">Dismiss</button></div>`).join('') : '<p class="empty">No established patterns yet. Carvis needs matching requests on at least three separate days.</p>';

  const list = $('#memoryList');
  if (!list) return;
  $('#memoryMeta').textContent = S.memories.length
    ? `${S.memories.length} · ${S.memories.filter((m) => m.source === 'carvis').length} from Carvis`
    : '';

  if (!S.memories.length) {
    list.innerHTML = '<p class="empty">Nothing yet — Carvis fills this in as it learns things, or add one yourself.</p>';
    return;
  }

  list.innerHTML = S.memories
    .map((m) => {
      const used = m.use_count
        ? `used ${m.use_count}x · last ${ago(m.used_at)}`
        : 'never used yet';
      return `
        <div class="log-row">
          <span class="badge ${m.kind === 'preference' ? 'live' : ''}">${escapeHtml(m.kind)}</span>
          <div style="flex:1; min-width:0">
            <span class="msg">${escapeHtml(m.text)}</span>
            <small class="muted">${m.source === 'owner' ? 'You' : 'Carvis'} · ${used}</small>
          </div>
          <button class="btn tiny ghost" data-action="edit" data-id="${m.id}">Edit</button>
          <button class="btn tiny ghost" data-action="delete" data-id="${m.id}">Delete</button>
        </div>
      `;
    })
    .join('');
}

function fillBehaviorForm() {
  $('#personality').value = S.config.carvis?.personality || '';
  const a = S.config.agent;
  for (const f of NUM_FIELDS) $(`#${f}`).value = a[f];
  $('#dryRun').checked = a.dryRun;
  $('#enforceOccupancyEnvelope').checked = a.enforceOccupancyEnvelope;


  const domains = [...new Set([...Object.keys(SERVICE_DOMAINS), ...a.allowedDomains])].sort();
  $('#domainChips').innerHTML = domains
    .map((d) => {
      const sensitive = SENSITIVE_DOMAINS.has(d);
      return `<span class="chip ${a.allowedDomains.includes(d) ? 'on' : ''} ${sensitive ? 'sensitive' : ''}" data-domain="${d}" title="${sensitive ? 'Direct owner request only' : ''}">${d}</span>`;
    })
    .join('');

  const areas = [...new Set(S.entities.map((e) => e.area))].sort();
  $('#areaNotes').innerHTML = areas.length
    ? areas
        .map(
          (a2) =>
            `<label>${escapeHtml(a2)}<input type="text" data-area="${escapeHtml(a2)}" value="${escapeHtml(S.config.areaNotes?.[a2] || '')}" placeholder="optional context" /></label>`,
        )
        .join('')
    : '<p class="muted">Rooms appear here once Home Assistant is connected.</p>';
}

const SERVICE_DOMAINS = {
  light: 1, switch: 1, fan: 1, input_boolean: 1, media_player: 1,
  scene: 1, script: 1, automation: 1, button: 1, input_button: 1,
  humidifier: 1, climate: 1, number: 1, input_number: 1, select: 1, input_select: 1,
  vacuum: 1, remote: 1, cover: 1, lock: 1, alarm_control_panel: 1, siren: 1, valve: 1, water_heater: 1,
};

/* ── settings ──────────────────────────────────────────────── */

function wireSettings() {
  // Settings buttons have dedicated click handlers. Keep Enter in a credential
  // field from triggering navigation. Each credential card is its own form so
  // browser/password-manager semantics stay correct without one giant form.
  $$('.settings-card-form').forEach((form) => form.addEventListener('submit', (event) => event.preventDefault()));
  $('#saveSettingsBtn').addEventListener('click', async () => {
    const speaker = $('#speechMediaPlayer').value;
    // Choosing a voice output is explicit authorization for that one player to
    // be visible and controllable. Leave every existing selection untouched.
    const needsSpeakerSelection = speaker && (!S.observed.has(speaker) || !S.controlled.has(speaker));
    await saveConfig({
      ha: {
        url: $('#haUrl').value.trim(),
        token: $('#haToken').value.trim(),
        allowInsecureTls: $('#allowInsecureTls').checked,
      },
      ollama: {
        url: $('#ollamaUrl').value.trim(),
        temperature: Number($('#temperature').value),
        numCtx: Number($('#numCtx').value),
        timeoutSec: Number($('#timeoutSec').value),
        keepAlive: $('#keepAlive').value.trim() || '30m',
      },
      voice: {
        enabled: $('#voiceEnabled').checked,
        requireWakeWord: $('#requireWakeWord').checked,
        wakeWords: $('#wakeWords').value.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean),
      },
      speech: {
        mediaPlayer: speaker,
        autoReplies: $('#autoSpeakReplies').checked,
        outputMode: $('#speechOutputMode').value,
      },
      ...(needsSpeakerSelection ? {
        entities: {
          observed: [...new Set([...S.observed, speaker])],
          controlled: [...new Set([...S.controlled, speaker])],
        },
      } : {}),
      glasses: {
        proactive: $('#glassesProactive').checked,
        proactiveMinGapSec: Number($('#proactiveMinGapSec').value),
        token: $('#glassesToken').value.trim(),
      },
      atlas: {
        enabled: $('#atlasEnabled').checked,
        captureOverheard: $('#captureOverheard').checked,
        completeTasks: $('#completeTasks').checked,
        endpoints: $('#atlasEndpoints')
          .value.split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      },
      mac: {
        enabled: $('#macEnabled').checked,
        deliver: $('#macDeliver').value,
        pushUrl: $('#macPushUrl').value.trim(),
        pushToken: $('#macPushToken').value.trim(),
      },
      stt: {
        engine: $('#sttEngine').value,
        model: $('#sttModel').value.trim(),
        deepgramKey: $('#deepgramKey').value.trim(),
        assemblyaiKey: $('#assemblyaiKey').value.trim(),
      },
      search: {
        model: $('#searchModel').value.trim() || GEMINI_DEFAULT_MODEL,
        geminiKey: $('#geminiKey').value.trim(),
      },
    });
    $('#haToken').value = '';
    $('#glassesToken').value = '';
    $('#macPushToken').value = '';
    $('#deepgramKey').value = '';
    $('#assemblyaiKey').value = '';
    $('#geminiKey').value = '';
    toast('Settings saved');
    await refreshRoles();
  });

  $('#testHaBtn').addEventListener('click', async () => {
    const out = $('#haTestResult');
    out.textContent = 'testing…';
    const r = await api('/integrations/assistant-engine/api/ha/test', {
      method: 'POST',
      body: JSON.stringify({ url: $('#haUrl').value.trim(), token: $('#haToken').value.trim() }),
    });
    out.textContent = r.ok ? `✓ ${r.message}` : `✗ ${r.message}`;
    out.style.color = r.ok ? 'var(--accent)' : 'var(--danger)';
  });

  $('#reconnectBtn').addEventListener('click', async () => {
    await api('/integrations/assistant-engine/api/ha/reconnect', { method: 'POST', body: '{}' });
    toast('Reconnecting…');
  });

  $('#sttEngine').addEventListener('change', () => {
    // A Deepgram tier and an AssemblyAI tier are never the same model, so
    // switching engines resets to that engine's default rather than trying
    // to carry a now-meaningless value across.
    populateSttModelOptions($('#sttEngine').value);
  });

  $('#testAtlasBtn').addEventListener('click', async () => {
    const out = $('#atlasTestResult');
    out.textContent = 'trying each address…';
    // Save first, so the test exercises whatever is currently in the textarea
    // rather than whatever was last saved.
    await saveConfig({
      atlas: {
        endpoints: $('#atlasEndpoints')
          .value.split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      },
    });
    const r = await api('/integrations/assistant-engine/api/atlas/refresh', { method: 'POST', body: '{}' });
    out.textContent = r.ok ? `✓ reachable at ${r.state.endpoint}` : `✗ ${r.error || 'no address answered'}`;
    out.style.color = r.ok ? 'var(--accent)' : 'var(--danger)';
  });
}

function fillSettingsForm() {
  const c = S.config;
  $('#haUrl').value = c.ha.url;
  $('#haToken').placeholder = c.ha.tokenSet ? '•••••• saved — leave blank to keep' : 'paste your long-lived token';
  $('#allowInsecureTls').checked = Boolean(c.ha.allowInsecureTls);
  $('#ollamaUrl').value = c.ollama.url;
  $('#temperature').value = c.ollama.temperature;
  $('#numCtx').value = c.ollama.numCtx;
  $('#timeoutSec').value = c.ollama.timeoutSec;
  $('#keepAlive').value = c.ollama.keepAlive;

  $('#voiceEnabled').checked = Boolean(c.voice.enabled);
  $('#requireWakeWord').checked = Boolean(c.voice.requireWakeWord);
  $('#wakeWords').value = (c.voice.wakeWords || []).join(', ');
  populateSpeechSpeakerOptions(c.speech?.mediaPlayer || '');
  $('#autoSpeakReplies').checked = c.speech?.autoReplies === true;
  $('#speechOutputMode').value = c.speech?.outputMode || 'physical_then_ha';
  $('#glassesProactive').checked = Boolean(c.glasses.proactive);
  $('#glassesToken').placeholder = c.glasses.tokenSet ? '•••••• saved — leave blank to keep' : 'no token set';
  $('#proactiveMinGapSec').value = c.glasses.proactiveMinGapSec;

  $('#atlasEnabled').checked = Boolean(c.atlas.enabled);
  $('#captureOverheard').checked = Boolean(c.atlas.captureOverheard);
  $('#completeTasks').checked = Boolean(c.atlas.completeTasks);
  $('#atlasEndpoints').value = (c.atlas.endpoints || [c.atlas.baseUrl].filter(Boolean)).join('\n');

  $('#macEnabled').checked = Boolean(c.mac.enabled);
  $('#macDeliver').value = c.mac.deliver;
  $('#macPushUrl').value = c.mac.pushUrl;
  $('#macPushToken').placeholder = c.mac.pushTokenSet ? '•••••• saved — leave blank to keep' : 'no token set';

  $('#sttEngine').value = c.stt.engine || 'deepgram';
  populateSttModelOptions($('#sttEngine').value, c.stt.model);
  $('#deepgramKey').placeholder = c.stt.deepgramKeySet ? '•••••• saved — leave blank to keep' : 'paste your Deepgram API key';
  $('#assemblyaiKey').placeholder = c.stt.assemblyaiKeySet ? '•••••• saved — leave blank to keep' : 'paste your AssemblyAI API key';

  // Live-fetched from Gemini, not typed from memory — resolves after the
  // options above, so it never blocks the rest of the form from filling in.
  void populateSearchModelOptions(c.search.model);
  $('#geminiKey').placeholder = c.search.geminiKeySet ? '•••••• saved — leave blank to keep' : 'paste your Gemini API key';
}

function populateSpeechSpeakerOptions(selected) {
  const select = $('#speechMediaPlayer');
  const players = (S.entities || [])
    .filter((entity) => entity.domain === 'media_player')
    .sort((left, right) => String(left.name || left.entity_id).localeCompare(String(right.name || right.entity_id)));
  const known = players.some((entity) => entity.entity_id === selected);
  const configured = !selected
    ? '<option value="" selected>No speaker configured</option>'
    : known
      ? ''
      : `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} — unavailable right now</option>`;
  const options = players.map((entity) => {
    const selectedAttr = entity.entity_id === selected ? ' selected' : '';
    const selectedState = S.controlled.has(entity.entity_id) ? ' · already available' : ' · will be added on save';
    return `<option value="${escapeHtml(entity.entity_id)}"${selectedAttr}>${escapeHtml(entity.name || entity.entity_id)} · ${escapeHtml(entity.state || 'unknown')}${selectedState}</option>`;
  }).join('');
  select.innerHTML = configured + options;
  if (selected && known) select.value = selected;
}

/** Deepgram and AssemblyAI don't expose an account-level model catalog the
 * way OpenAI/Anthropic/Gemini do — each has a small, fixed, well-known set
 * of tiers, so this is curated rather than fetched. */
const STT_MODELS = {
  deepgram: [
    { id: 'nova-3', label: 'nova-3 (default)' },
    { id: 'nova-2', label: 'nova-2' },
    { id: 'nova', label: 'nova' },
    { id: 'enhanced', label: 'enhanced' },
    { id: 'base', label: 'base' },
  ],
  assemblyai: [
    { id: 'universal-3-5-pro', label: 'universal-3-5-pro (default)' },
    { id: 'best', label: 'best' },
    { id: 'nano', label: 'nano' },
  ],
};

function populateSttModelOptions(engine, selected) {
  const list = STT_MODELS[engine] || STT_MODELS.deepgram;
  const value = selected || list[0].id;
  const known = list.some((m) => m.id === value);
  $('#sttModel').innerHTML =
    // A model no longer in the curated list must still show, or switching
    // engines and back — or a config edited by hand — would silently
    // discard it on the next save.
    (known ? '' : `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)} (not listed)</option>`) +
    list.map((m) => `<option value="${escapeHtml(m.id)}"${m.id === value ? ' selected' : ''}>${escapeHtml(m.label)}</option>`).join('');
}

const GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';

/** Live models this Gemini key can actually reach, same "fetch, don't guess" pattern as the Models tab. */
async function populateSearchModelOptions(selected) {
  const sel = $('#searchModel');
  const value = selected || GEMINI_DEFAULT_MODEL;
  let r;
  try {
    r = await api('/integrations/assistant-engine/api/search/models');
  } catch (err) {
    r = { ok: false, message: err.message, models: [] };
  }
  if (!r.ok || !r.models.length) {
    // No key saved yet, or Gemini couldn't be reached — keep the field
    // usable with whatever is already configured instead of going blank.
    sel.innerHTML = `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}${r.ok ? '' : ' — save a Gemini key to list live models'}</option>`;
    return;
  }
  const known = r.models.some((m) => m.id === value);
  sel.innerHTML =
    (known ? '' : `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)} (not listed)</option>`) +
    r.models
      .map(
        (m) =>
          `<option value="${escapeHtml(m.id)}"${m.id === value ? ' selected' : ''}>${escapeHtml(m.label ? `${m.id} — ${m.label}` : m.id)}</option>`,
      )
      .join('');
}

/* ── models ────────────────────────────────────────────────── */

function wireModels() {
  $('#saveRolesBtn').addEventListener('click', async () => {
    const roles = {};
    for (const row of $$('#rolesBody tr')) {
      const role = row.dataset.role;
      roles[role] = {
        ...S.config.models.roles[role],
        provider: row.querySelector('.role-provider').value,
        model: row.querySelector('.role-model').value,
        effort: row.querySelector('.role-effort').value || undefined,
      };
    }
    await saveConfig({ models: { roles } });
    toast('Roles saved');
    await refreshRoles();
  });

  $('#refreshAllModelsBtn').addEventListener('click', async () => {
    S.modelLists = {};
    await refreshRoles();
    toast('Model lists refreshed');
  });
}

/** Model names per provider, fetched once and reused across every role row. */
async function modelsFor(providerId) {
  if (S.modelLists[providerId]) return S.modelLists[providerId];
  const r = await api(`/integrations/assistant-engine/api/models/list?provider=${encodeURIComponent(providerId)}`);
  S.modelLists[providerId] = r.ok ? r.models : [];
  S.providerErrors[providerId] = r.ok ? '' : r.message;
  return S.modelLists[providerId];
}

async function refreshRoles() {
  const data = await api('/integrations/assistant-engine/api/models');
  S.roles = data.roles;
  S.providers = data.providers;
  await Promise.all(data.providers.map((p) => modelsFor(p.id).catch(() => [])));
  renderRoles();
  renderProviders();
  renderStatus();
}

function renderRoles() {
  const efforts = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  $('#rolesBody').innerHTML = S.roles
    .map((r) => {
      const providerOptions = S.providers
        .map((p) => `<option value="${escapeHtml(p.id)}"${p.id === r.provider ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
        .join('');
      const list = S.modelLists[r.provider] || [];
      const known = list.some((m) => m.name === r.model);
      const modelOptions =
        '<option value="">— pick —</option>' +
        // A model the provider no longer lists must still show, or saving the
        // row would silently blank a working configuration.
        (known || !r.model ? '' : `<option value="${escapeHtml(r.model)}" selected>${escapeHtml(r.model)} (not listed)</option>`) +
        list
          .map((m) => `<option value="${escapeHtml(m.name)}"${m.name === r.model ? ' selected' : ''}>${escapeHtml(m.label || m.name)}</option>`)
          .join('');
      const effortOptions = efforts
        .map((e) => `<option value="${e}"${e === (r.effort || '') ? ' selected' : ''}>${e || '—'}</option>`)
        .join('');

      return `<tr data-role="${escapeHtml(r.role)}">
        <td><strong>${escapeHtml(r.role)}</strong>${r.ready ? '' : ' <span class="badge warn">unset</span>'}</td>
        <td class="muted">${escapeHtml(r.purpose)}</td>
        <td><select class="role-provider">${providerOptions}</select></td>
        <td><select class="role-model">${modelOptions}</select></td>
        <td><select class="role-effort">${effortOptions}</select></td>
      </tr>`;
    })
    .join('');

  for (const sel of $$('#rolesBody .role-provider')) {
    sel.addEventListener('change', async (ev) => {
      const row = ev.target.closest('tr');
      const list = await modelsFor(ev.target.value);
      const modelSel = row.querySelector('.role-model');
      modelSel.innerHTML =
        '<option value="">— pick —</option>' +
        list.map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.label || m.name)}</option>`).join('');
    });
  }

  // r.local is the provider's own explicit flag, not derived from r.kind —
  // kind is a wire protocol (Ollama, OpenAI-shaped, Anthropic), and a real
  // billed OpenAI account shares "openai" kind with a local LM Studio
  // server. Filtering by kind==='anthropic' alone missed every cloud role
  // routed through the OpenAI-compatible path, rendering "Everything is
  // local" while real metered calls were happening.
  const cloud = S.roles.filter((r) => !r.local && r.ready).map((r) => r.role);
  // Background classification and live speech routing are independently configured.
  const always = S.roles.filter((r) => r.role === 'triage' || r.role === 'voice_triage');
  const alwaysCloud = always.filter((r) => !r.local);
  $('#rolesHint').textContent = alwaysCloud.length
    ? `${alwaysCloud.map((r) => r.role).join(' and ')} run on regular owner interactions — on a paid model that is a bill that never stops. Keep them cheap, or move them to Ollama.`
    : cloud.length
      ? `Cloud: ${cloud.join(', ')}. The always-on roles are local, so an idle house costs nothing.`
      : 'Everything is local. Nothing leaves this Mac.';
}

function renderProviders() {
  $('#providersBody').innerHTML = S.providers
    .map((p) => {
      const err = S.providerErrors[p.id];
      const count = (S.modelLists[p.id] || []).length;
      const status = err
        ? `<span class="bad">${escapeHtml(err)}</span>`
        : `${count} model${count === 1 ? '' : 's'}`;
      return `<tr>
        <td><strong>${escapeHtml(p.label)}</strong></td>
        <td class="muted">${escapeHtml(p.kind)}</td>
        <td class="muted">${escapeHtml(p.baseUrl || '—')}</td>
        <td class="muted">${p.apiKeyEnv ? `${escapeHtml(p.apiKeyEnv)} ${p.keyAvailable ? '✓' : '✗ not set'}` : '—'}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('');
}

/* ── tools ─────────────────────────────────────────────────── */

const TOOL_RISK_LABELS = ['read', 'low', 'medium', 'sensitive', 'critical'];
const TOOL_TRIGGERS = [
  ['user_text', 'Text'],
  ['user_voice', 'Voice'],
  ['automation', 'Protocol'],
  ['home_event', 'Home event'],
  ['system_event', 'System'],
];

function wireTools() {
  $('#toolSearch').addEventListener('input', renderTools);
  $('#toolRiskFilter').addEventListener('change', renderTools);
}

function toolReach(tool) {
  const cfg = S.config?.tools || {};
  const byTrigger = cfg.maxRiskByTrigger || {};
  const fallback = cfg.maxRisk ?? 2;
  return TOOL_TRIGGERS
    .filter(([trigger]) => tool.risk <= (byTrigger[trigger] ?? fallback))
    .map(([, label]) => label);
}

function renderTools() {
  const body = $('#toolsBody');
  if (!body) return;

  const query = $('#toolSearch')?.value.trim().toLowerCase() || '';
  const wantedRisk = $('#toolRiskFilter')?.value || '';
  const tools = (S.tools || []).filter((tool) => {
    if (wantedRisk && String(tool.risk) !== wantedRisk) return false;
    return !query || `${tool.name} ${tool.description}`.toLowerCase().includes(query);
  });

  $('#toolsMeta').textContent = `${tools.length} of ${(S.tools || []).length} available`;
  body.innerHTML = tools.length
    ? tools
        .map((tool) => {
          const risk = TOOL_RISK_LABELS[tool.risk] || tool.riskName || 'unknown';
          const reachable = toolReach(tool);
          return `<tr>
            <td><code class="tool-name">${escapeHtml(tool.name)}</code></td>
            <td class="tool-description">${escapeHtml(tool.description)}</td>
            <td><span class="tool-risk risk-${escapeHtml(risk)}">${escapeHtml(risk)}</span></td>
            <td>${reachable.length ? reachable.map((label) => `<span class="tool-trigger">${escapeHtml(label)}</span>`).join('') : '<span class="muted">None</span>'}</td>
            <td>${tool.idempotent ? '<span class="tool-idempotent">Yes</span>' : '<span class="muted">No</span>'}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty">No tools match that filter.</td></tr>';
}

/* ── deterministic automations ────────────────────────────── */

const AUTOMATION_RULE_KEYS = [
  'version', 'id', 'name', 'description', 'enabled', 'when', 'if', 'while', 'then', 'else', 'metadata',
];
const AUTOMATION_TEMPORAL_DURATION = new Set(['for_duration', 'has_been']);
const AUTOMATION_TEMPORAL_WINDOW = new Set(['within', 'hasnt_happened']);
let automationRefreshTimer;
let automationCatalogRefreshTimer;

async function automationPost(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, message: await response.text().catch(() => '') };
  }
  if (!response.ok) {
    if (response.status === 401) showAuthGate('login');
    const error = new Error(payload.message || `Request failed (${response.status})`);
    error.data = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function automationRules() {
  return S.automations?.rules?.items || [];
}

async function loadAutomationCatalog() {
  const catalog = await api('/integrations/assistant-engine/api/automations/catalog');
  S.automationCatalog = catalog;
  renderAutomationDatalists();
  // A reconnect can arrive while somebody is typing inside a block. The
  // catalog is live immediately for datalists and the next editor render, but
  // never rebuild the open lane underneath an unsaved/focused control.
  const editing = S.automationEditor.mode === 'edit';
  const editorFocused = editing && $('#automationEditor')?.contains(document.activeElement);
  if (editing && !S.automationEditor.dirty && !editorFocused) renderAutomationEditor();
  else renderAutomations();
  return catalog;
}

async function loadAutomations({ render = true } = {}) {
  S.automations = await api('/integrations/assistant-engine/api/automations');
  renderAutomationDatalists();
  if (render) renderAutomations();
  return S.automations;
}

function scheduleAutomationRefresh() {
  if (!integrationEnabled('protocols')) return;
  clearTimeout(automationRefreshTimer);
  automationRefreshTimer = setTimeout(() => {
    loadAutomations().catch((err) => toast(`Protocols: ${err.message}`, true));
  }, 120);
}

function scheduleAutomationCatalogRefresh(delay = 450) {
  if (!integrationEnabled('protocols')) return;
  clearTimeout(automationCatalogRefreshTimer);
  automationCatalogRefreshTimer = setTimeout(() => {
    loadAutomationCatalog().catch((err) => toast(`Protocol choices: ${err.message}`, true));
  }, delay);
}

function wireAutomations() {
  const view = $('#view-automations');
  if (!view || view.dataset.wired) return;
  view.dataset.wired = 'true';

  $('#automationNewBtn').addEventListener('click', () => openAutomationEditor(newAutomationDefinition()));
  $('#automationAskBtn').addEventListener('click', () => {
    if (S.automationEditor.dirty && !confirm('Leave this protocol without saving your changes?')) return;
    S.automationEditor.dirty = false;
    const nav = $('.nav-item[data-view="carvis"]');
    nav?.click();
    const field = $('#sayText');
    if (field && !field.value.trim()) field.value = 'Create a protocol that ';
    field?.focus();
  });

  $('#automationTemplates').addEventListener('click', (event) => {
    const button = event.target.closest('[data-template]');
    if (button) openAutomationEditor(automationTemplate(button.dataset.template));
  });
  $('#automationSearch').addEventListener('input', renderAutomations);
  $('#automationStatusFilter').addEventListener('change', renderAutomations);

  $('#automationList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-automation-action]');
    if (!button) return;
    const { automationAction: action, id } = button.dataset;
    button.disabled = true;
    try {
      if (action === 'open' || action === 'history') {
        const result = await automationPost('/integrations/assistant-engine/api/automations/get', { id });
        openAutomationEditor(result.rule);
        if (action === 'history') {
          $('#automationHistoryCard').open = true;
          await loadAutomationHistory();
        }
      } else if (action === 'toggle') {
        const enabled = button.dataset.enabled !== 'true';
        await automationPost('/integrations/assistant-engine/api/automations/toggle', { id, enabled });
        toast(enabled ? 'Protocol enabled' : 'Protocol paused');
        await loadAutomations();
      } else if (action === 'duplicate') {
        const result = await automationPost('/integrations/assistant-engine/api/automations/duplicate', { id });
        await loadAutomations({ render: false });
        openAutomationEditor(result.rule);
        toast('Paused copy created');
      } else if (action === 'archive') {
        const rule = automationRules().find((item) => item.id === id);
        if (!confirm(`Archive “${rule?.name || id}”?\n\nIts execution history stays available in the database.`)) return;
        await automationPost('/integrations/assistant-engine/api/automations/archive', { id });
        toast('Protocol archived');
        await loadAutomations();
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('#automationBackBtn').addEventListener('click', () => closeAutomationEditor());
  $('#automationName').addEventListener('input', (event) => {
    if (!S.automationEditor.draft) return;
    S.automationEditor.draft.name = event.target.value;
    setAutomationDirty();
  });
  $('#automationDescription').addEventListener('input', (event) => {
    if (!S.automationEditor.draft) return;
    const value = event.target.value;
    if (value) S.automationEditor.draft.description = value;
    else delete S.automationEditor.draft.description;
    setAutomationDirty();
  });
  $('#automationEnabled').addEventListener('change', (event) => {
    if (!S.automationEditor.draft) return;
    S.automationEditor.draft.enabled = event.target.checked;
    setAutomationDirty();
  });

  $('#automationLane').addEventListener('change', handleAutomationLaneChange);
  $('#automationLane').addEventListener('click', handleAutomationLaneClick);
  $('#automationSaveBtn').addEventListener('click', saveAutomationDraft);
  $('#automationTestBtn').addEventListener('click', testAutomationDraft);
  $('#automationDuplicateBtn').addEventListener('click', duplicateAutomationDraft);
  $('#automationArchiveBtn').addEventListener('click', archiveAutomationDraft);
  $('#automationJsonApplyBtn').addEventListener('click', applyAutomationJson);
  $('#automationJsonCopyBtn').addEventListener('click', copyAutomationJson);
  $('#automationHistoryCard').addEventListener('toggle', () => {
    if ($('#automationHistoryCard').open) loadAutomationHistory().catch((err) => toast(err.message, true));
  });

  window.addEventListener('popstate', () => {
    const route = automationRouteId();
    if (S.automationEditor.mode === 'edit' && S.automationEditor.dirty && !confirm('Leave this protocol without saving your changes?')) {
      const current = S.automationEditor.id || 'new';
      history.pushState({ carvisAutomation: true }, '', `#automations/${encodeURIComponent(current)}`);
      return;
    }
    showAutomationList({ clearRoute: false });
    if (route) handleAutomationRoute();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!S.automationEditor.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function automationRouteId() {
  const match = location.hash.match(/^#automations\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function handleAutomationRoute() {
  const id = automationRouteId();
  if (!id || S.automationEditor.mode === 'edit') return;
  const nav = $('.nav-item[data-view="automations"]');
  nav?.click();
  if (id === 'new') return openAutomationEditor(newAutomationDefinition(), { push: false });
  try {
    const result = await automationPost('/integrations/assistant-engine/api/automations/get', { id });
    openAutomationEditor(result.rule, { push: false });
  } catch (err) {
    toast(err.message, true);
    showAutomationList();
  }
}

function definitionFromPublic(rule) {
  const definition = {};
  for (const key of AUTOMATION_RULE_KEYS) {
    if (Object.hasOwn(rule || {}, key)) definition[key] = structuredClone(rule[key]);
  }
  return definition;
}

function newAutomationDefinition() {
  return {
    version: S.automationCatalog?.version || 1,
    name: 'New protocol',
    description: '',
    enabled: false,
    when: defaultAutomationCondition(),
    then: [defaultAutomationAction('hud.show_notification')],
  };
}

function entitySearchText(entity) {
  return `${entity?.entity_id || ''} ${entity?.name || ''} ${entity?.friendly_name || ''} ${entity?.area || ''} ${entity?.device_class || ''}`.toLowerCase();
}

function findAutomationEntity(domain, { controllable = false, hints = [], allowOnlyEntity = true } = {}) {
  const candidates = (S.automationCatalog?.options?.entities || []).filter((entity) =>
    entity.domain === domain && (!controllable || entity.controllable === true),
  );
  for (const hint of hints) {
    const words = String(hint).toLowerCase().replaceAll('_', ' ').split(/\s+/).filter(Boolean);
    const found = candidates.find((entity) => words.every((word) => entitySearchText(entity).replaceAll('_', ' ').includes(word)));
    if (found) return found;
  }
  return allowOnlyEntity && candidates.length === 1 ? candidates[0] : null;
}

function firstLocationRef() {
  const locations = S.automationCatalog?.options?.locations || [];
  const people = locations.filter(item => item.domain === 'person');
  const entity = people.length === 1 ? people[0] : locations[0];
  if (!entity?.entity_id) return '';
  return `location.${entity.entity_id.split('.').slice(1).join('.')}`;
}

function namedEntityId(domain, fallback, options = {}) {
  return findAutomationEntity(domain, options)?.entity_id || fallback;
}

function preferredTemperatureUnit() {
  const sensor = (S.entities || []).find((entity) => entity.device_class === 'temperature' && /^(?:°?[FC])$/i.test(entity.unit || ''))
    || (S.entities || []).find((entity) => /^(?:°?[FC])$/i.test(entity.unit || ''));
  if (sensor?.unit) return sensor.unit.toUpperCase().includes('C') ? '°C' : '°F';
  return /^en-US\b/i.test(navigator.language || '') ? '°F' : '°C';
}

function automationTemplate(kind) {
  const base = { version: S.automationCatalog?.version || 1, enabled: false };
  if (kind === 'arrival') {
    return {
      ...base,
      name: 'Evening arrival',
      description: 'Welcome me home after 8 PM.',
      when: { op: 'changed_to', left: { ref: firstLocationRef() }, right: { literal: 'home' } },
      if: { op: 'greater_than', left: { ref: 'time.hour' }, right: { literal: 19 } },
      then: [{
        type: 'hud.show_notification',
        payload: { text: 'Welcome home', detail: 'Carvis detected your arrival.', seconds: 15 },
      }],
    };
  }
  if (kind === 'timer') {
    return {
      ...base,
      name: 'Timer finished',
      description: 'Speak and show a message when a named timer finishes.',
      // Events need an edge: a saved rule baselines before the first event,
      // so equality would silently swallow that first timer completion.
      when: { op: 'changed_to', left: { ref: 'event.type' }, right: { literal: 'timer.pasta.finished' } },
      then: [
        { type: 'speech.say', text: { literal: 'Your timer is finished.' } },
        { type: 'hud.show_notification', payload: { text: 'Timer finished', detail: 'Pasta timer', seconds: 20 } },
      ],
    };
  }
  if (kind === 'weather') {
    const weather = findAutomationEntity('weather', { hints: ['home', 'forecast'] });
    const weatherRef = weather ? `weather.${weather.entity_id.slice('weather.'.length)}.temperature` : 'weather.temperature';
    const unit = preferredTemperatureUnit();
    const threshold = unit === '°C' ? 32 : 90;
    return {
      ...base,
      name: 'Hot weather alert',
      description: 'Warn once when the outdoor temperature crosses the threshold.',
      when: { op: 'greater_than', left: { ref: weatherRef }, right: { literal: threshold } },
      then: [{
        type: 'hud.show_notification',
        payload: { text: 'Heat alert', detail: `Outdoor temperature is above ${threshold}${unit}.`, seconds: 30 },
      }],
    };
  }
  if (kind === 'camera') {
    return {
      ...base,
      name: 'Evening living room camera',
      description: 'Put the living room camera on the HUD when I am home in the evening.',
      when: { op: 'equals', left: { ref: 'time.hour' }, right: { literal: 20 } },
      if: { op: 'equals', left: { ref: firstLocationRef() }, right: { literal: 'home' } },
      then: [{
        type: 'hud.show_camera',
        payload: {
          entity_id: namedEntityId('camera', '', { hints: ['living room'], allowOnlyEntity: false }),
          slot: 0,
          ttl_seconds: 3600,
        },
      }],
    };
  }
  return newAutomationDefinition();
}

function openAutomationEditor(rule, { push = true } = {}) {
  if (S.automationEditor.dirty && !confirm('Replace the unsaved protocol currently open?')) return;
  const revision = Number.isInteger(rule?.revision) ? rule.revision : null;
  const definition = definitionFromPublic(rule || newAutomationDefinition());
  S.automationEditor = {
    mode: 'edit',
    // A client-reserved ID on a new draft is not proof that the rule exists.
    id: revision !== null ? definition.id || null : null,
    revision,
    draft: definition,
    dirty: false,
    validation: [],
    testResult: null,
    history: null,
    testValues: {},
    saving: false,
  };
  $('#automationListScreen').hidden = true;
  $('#automationEditor').hidden = false;
  $('#automationHistoryCard').open = false;
  if ($('#automationTestValues')) $('#automationTestValues').value = '{}';
  renderAutomationEditor();
  if (push) {
    history.pushState(
      { carvisAutomation: true },
      '',
      `#automations/${encodeURIComponent(definition.id || 'new')}`,
    );
  }
  $('#automationName').focus();
  $('#automationEditor').scrollIntoView({ block: 'start' });
}

function closeAutomationEditor() {
  if (S.automationEditor.dirty && !confirm('Leave this protocol without saving your changes?')) return;
  // The user already approved discarding. Clear dirty before history.back()
  // so the ensuing popstate does not ask the same question a second time.
  S.automationEditor.dirty = false;
  if (history.state?.carvisAutomation) history.back();
  else showAutomationList();
}

function showAutomationList({ clearRoute = true } = {}) {
  S.automationEditor = {
    mode: 'list', id: null, revision: null, draft: null, dirty: false,
    validation: [], testResult: null, history: null, testValues: {}, saving: false,
  };
  $('#automationEditor').hidden = true;
  $('#automationListScreen').hidden = false;
  if (clearRoute && location.hash.startsWith('#automations/')) {
    history.replaceState({}, '', `${location.pathname}${location.search}`);
  }
  renderAutomations();
}

function renderAutomations() {
  if (!$('#automationList')) return;
  renderAutomationMetrics();
  if (S.automationEditor.mode === 'edit') return;
  const query = ($('#automationSearch')?.value || '').trim().toLowerCase();
  const filter = $('#automationStatusFilter')?.value || '';
  const rules = automationRules().filter((rule) => {
    if (query && !`${rule.name || ''} ${rule.description || ''} ${rule.summary || ''}`.toLowerCase().includes(query)) return false;
    if (filter === 'enabled' && !rule.enabled) return false;
    if (filter === 'disabled' && rule.enabled) return false;
    if (filter === 'failed' && !rule.lastError) return false;
    return true;
  });
  $('#automationList').innerHTML = rules.length
    ? rules.map(renderAutomationCard).join('')
    : `<div class="card automation-empty">
        <h2>${automationRules().length ? 'No matches' : 'No protocols yet'}</h2>
        <p class="muted">${automationRules().length ? 'Try a different search or status.' : 'Build one in blocks, start from a template, or ask Carvis.'}</p>
        ${automationRules().length ? '' : '<button class="btn primary" data-automation-action="new">New protocol</button>'}
      </div>`;
  const newButton = $('#automationList [data-automation-action="new"]');
  if (newButton) newButton.addEventListener('click', () => openAutomationEditor(newAutomationDefinition()));
}

function renderAutomationMetrics() {
  const el = $('#automationMetrics');
  if (!el) return;
  const state = S.automations;
  const total = state?.rules?.total || 0;
  const enabled = state?.rules?.enabled || 0;
  const failed = state?.rules?.failed || 0;
  const metrics = [
    ['Rules', total, 'total saved'],
    ['Running', enabled, enabled ? 'evaluating locally' : 'none enabled'],
    ['Attention', failed, failed ? 'last run failed' : 'all clear'],
    ['Timers', state?.timers?.length || 0, 'active'],
    ['Alarms', state?.alarms?.length || 0, 'active'],
  ];
  el.innerHTML = metrics.map(([label, value, detail], index) => `
    <div class="automation-metric ${index === 2 && value ? 'bad' : ''}">
      <span>${escapeHtml(label)}</span><strong>${value}</strong><small>${escapeHtml(detail)}</small>
    </div>`).join('');
}

function renderAutomationCard(rule) {
  const stages = [
    ['WHEN', conditionSummary(rule.when)],
    ...(rule.if ? [['IF', conditionSummary(rule.if)]] : []),
    ...(rule.while ? [['WHILE', conditionSummary(rule.while)]] : []),
    ['THEN', actionListSummary(rule.then)],
  ];
  const status = rule.lastError ? 'attention' : rule.enabled ? 'running' : 'paused';
  const last = rule.lastFiredAt
    ? `Last ran ${ago(rule.lastFiredAt)} · ${rule.lastOutcome || 'completed'}`
    : rule.lastEvaluatedAt ? `Last checked ${ago(rule.lastEvaluatedAt)} · never fired` : 'Not evaluated yet';
  return `<article class="automation-card ${status}">
    <div class="automation-card-head">
      <div class="automation-card-name">
        <span class="dot ${rule.lastError ? 'bad' : rule.enabled ? 'ok' : ''}"></span>
        <div><strong>${escapeHtml(rule.name || 'Untitled protocol')}</strong>
        ${rule.description ? `<small>${escapeHtml(rule.description)}</small>` : ''}</div>
      </div>
      <span class="badge ${rule.lastError ? 'bad' : rule.enabled ? 'live' : ''}">${rule.lastError ? 'ATTENTION' : rule.enabled ? 'RUNNING' : 'PAUSED'}</span>
    </div>
    <div class="automation-mini-flow" aria-label="${escapeHtml(stages.map(([key, value]) => `${key} ${value}`).join(', then '))}">
      ${stages.map(([key, value], index) => `${index ? '<span class="automation-mini-arrow" aria-hidden="true">›</span>' : ''}
        <div class="automation-mini-block"><span>${key}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}
    </div>
    ${rule.lastError ? `<p class="automation-card-error">${escapeHtml(rule.lastError)}</p>` : ''}
    <div class="automation-card-foot">
      <small>${escapeHtml(last)}${rule.fireCount ? ` · ${rule.fireCount} total` : ''}</small>
      <div class="row-actions">
        <button class="btn tiny ghost" data-automation-action="toggle" data-id="${escapeHtml(rule.id)}" data-enabled="${rule.enabled}">${rule.enabled ? 'Pause' : 'Enable'}</button>
        <button class="btn tiny primary" data-automation-action="open" data-id="${escapeHtml(rule.id)}">Open</button>
        <details class="automation-card-menu">
          <summary class="btn tiny ghost" aria-label="More actions">•••</summary>
          <div>
            <button data-automation-action="history" data-id="${escapeHtml(rule.id)}">History</button>
            <button data-automation-action="duplicate" data-id="${escapeHtml(rule.id)}">Duplicate</button>
            <button data-automation-action="archive" data-id="${escapeHtml(rule.id)}">Archive</button>
          </div>
        </details>
      </div>
    </div>
  </article>`;
}

function valueSummary(node) {
  if (node && typeof node === 'object' && typeof node.ref === 'string') return node.ref;
  if (node && typeof node === 'object' && Object.hasOwn(node, 'literal')) {
    if (typeof node.literal === 'string') return node.literal;
    try { return JSON.stringify(node.literal); } catch { return String(node.literal); }
  }
  return '<?> ';
}

function operatorLabel(operator) {
  return S.automationCatalog?.operators?.find((item) => item.id === operator)?.label
    || String(operator || '?').replaceAll('_', ' ');
}

function durationSummary(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '?';
  if (value % 86_400_000 === 0) return `${value / 86_400_000}d`;
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1_000 === 0) return `${value / 1_000}s`;
  return `${value}ms`;
}

function conditionSummary(condition, depth = 0) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return 'invalid condition';
  if (depth > 5) return 'nested condition';
  if (Array.isArray(condition.all)) return condition.all.map((child) => conditionSummary(child, depth + 1)).join(' AND ');
  if (Array.isArray(condition.any)) return condition.any.map((child) => conditionSummary(child, depth + 1)).join(' OR ');
  if (condition.not) return `NOT ${conditionSummary(condition.not, depth + 1)}`;
  const right = Object.hasOwn(condition, 'right') ? ` ${valueSummary(condition.right)}` : '';
  const duration = AUTOMATION_TEMPORAL_DURATION.has(condition.op) ? ` for ${durationSummary(condition.durationMs)}` : '';
  const within = AUTOMATION_TEMPORAL_WINDOW.has(condition.op) ? ` ${durationSummary(condition.withinMs)}` : '';
  return `${valueSummary(condition.left)} ${operatorLabel(condition.op)}${right}${duration}${within}`.trim();
}

function actionSummary(action) {
  if (!action) return 'unknown action';
  if (action.type === 'tool.call') return `call ${action.tool || 'tool'}`;
  if (action.type === 'variable.set') return `set ${action.name || 'variable'}`;
  if (action.type === 'timer.start') return `start ${action.timer || 'timer'}`;
  if (action.type === 'timer.cancel') return `cancel ${action.timer || 'timer'}`;
  if (action.type === 'rule.enable' || action.type === 'rule.disable') return `${action.type.split('.')[1]} ${action.ruleId || 'rule'}`;
  if (action.type === 'carvis.wake') return 'wake Carvis';
  if (action.type === 'speech.say') return `say ${valueSummary(action.text)}`;
  if (action.type === 'hud.show_camera') return `show ${action.payload?.entity_id || 'camera'}`;
  if (action.type?.startsWith('hud.')) return action.type.replace('hud.', 'HUD ');
  return action.type || 'unknown action';
}

function actionListSummary(actions) {
  if (!Array.isArray(actions) || !actions.length) return 'no actions';
  const shown = actions.slice(0, 2).map(actionSummary).join(' + ');
  return actions.length > 2 ? `${shown} + ${actions.length - 2} more` : shown;
}

function defaultAutomationCondition(ref = 'time.hour', op = 'equals', literal = 20) {
  return { op, left: { ref }, right: { literal } };
}

function firstAutomatableTool() {
  const tools = S.automationCatalog?.tools || [];
  return tools.find((tool) => tool.name === 'ha.entity.command' && tool.automatable)
    || tools.find((tool) => tool.automatable)
    || null;
}

function schemaDefault(schema, key = '') {
  if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
  if (key === 'entity_id') {
    return namedEntityId('light', 'light.living_room', {
      controllable: true,
      hints: ['living room', 'office'],
    });
  }
  if (key === 'service') return 'turn_on';
  if (schema?.type === 'boolean') return false;
  if (schema?.type === 'integer' || schema?.type === 'number') return Number.isFinite(schema.minimum) ? schema.minimum : 0;
  return '';
}

function defaultToolArguments(tool) {
  const args = {};
  for (const key of tool?.schema?.required || []) {
    args[key] = schemaDefault(tool.schema.properties?.[key], key);
  }
  if (tool?.name === 'ha.entity.command') {
    const target = automationCommandEntities().find((entity) => /living.?room|office/i.test(entitySearchText(entity)))
      || automationCommandEntities()[0];
    args.entity_id = target?.entity_id || '';
    args.service = servicesForAutomationEntity(args.entity_id)[0] || '';
  }
  return args;
}

function defaultAutomationAction(type = 'hud.show_notification') {
  if (type === 'tool.call') {
    const tool = firstAutomatableTool();
    return { type, tool: tool?.name || '', arguments: defaultToolArguments(tool) };
  }
  if (type === 'variable.set') return { type, name: 'my_variable', value: { literal: true } };
  if (type === 'timer.start') return { type, timer: 'my_timer', durationMs: { literal: 300_000 }, payload: {} };
  if (type === 'timer.cancel') return { type, timer: 'my_timer' };
  if (type === 'rule.enable' || type === 'rule.disable') return { type, ruleId: automationRules()[0]?.id || 'another_rule' };
  if (type === 'carvis.wake') return { type, prompt: { literal: 'The protocol fired.' }, trigger: 'automation' };
  if (type === 'speech.say') return { type, text: { literal: 'The protocol fired.' } };
  if (type === 'hud.show_camera') return { type, payload: {
    entity_id: namedEntityId('camera', 'camera.living_room', { hints: ['living room'], allowOnlyEntity: false }),
    slot: 0,
    ttl_seconds: 300,
  } };
  if (type === 'hud.set_widget') return { type, payload: { title: 'Carvis', value: 'Protocol fired', slot: 0, ttl_seconds: 300 } };
  return { type, payload: { text: 'Protocol fired', detail: '', seconds: 20 } };
}

function renderAutomationEditor() {
  const editor = S.automationEditor;
  const draft = editor.draft;
  if (!draft || !$('#automationEditor')) return;
  const lane = $('#automationLane');
  const priorScroll = lane?.scrollLeft || 0;
  const openBlocks = new Set(
    [...(lane?.querySelectorAll('details[data-block-path][open]') || [])].map((details) => details.dataset.blockPath),
  );
  $('#automationName').value = draft.name || '';
  $('#automationDescription').value = draft.description || '';
  $('#automationEnabled').checked = draft.enabled === true;
  $('#automationDirtyState').textContent = editor.saving ? 'Saving…' : editor.dirty ? 'Unsaved changes' : editor.revision ? `Saved · revision ${editor.revision}` : 'New paused draft';
  $('#automationDuplicateBtn').hidden = !editor.id;
  $('#automationArchiveBtn').hidden = !editor.id;
  $('#automationHistoryCard').hidden = !editor.id;
  lane.innerHTML = renderAutomationLane(draft);
  for (const details of lane.querySelectorAll('details[data-block-path]')) {
    details.open = openBlocks.has(details.dataset.blockPath);
  }
  lane.scrollLeft = priorScroll;
  renderAutomationValidation();
  renderAutomationTest();
  renderAutomationHistory();
  renderAutomationDatalists();
  if (document.activeElement !== $('#automationJson')) {
    $('#automationJson').value = JSON.stringify(draft, null, 2);
  }
}

function renderAutomationLane(draft) {
  const stages = [
    renderConditionStage('WHEN', 'when', draft.when, false),
    renderConditionStage('IF', 'if', draft.if, true),
    renderConditionStage('WHILE', 'while', draft.while, true),
    renderActionStage('THEN', 'then', Array.isArray(draft.then) ? draft.then : [], false),
  ];
  if (Array.isArray(draft.else)) stages.push(renderActionStage('ELSE', 'else', draft.else, true));
  else stages.push(`<section class="automation-stage optional" role="listitem">
    <div class="automation-stage-head"><span class="automation-stage-key">ELSE</span><small>optional fallback</small></div>
    <button class="automation-stage-add" data-automation-command="add-else">Add an ELSE branch</button>
  </section>`);
  return stages.map((stage, index) => `${index ? '<span class="automation-lane-arrow" aria-hidden="true">›</span>' : ''}${stage}`).join('');
}

function renderConditionStage(label, key, condition, optional) {
  if (!condition) {
    return `<section class="automation-stage optional" role="listitem">
      <div class="automation-stage-head"><span class="automation-stage-key">${label}</span><small>optional guard</small></div>
      <p>Skip this stage, or add a condition that must pass.</p>
      <button class="automation-stage-add" data-automation-command="add-condition-stage" data-stage="${key}">Add ${label}</button>
    </section>`;
  }
  return `<section class="automation-stage stage-${key}" role="listitem">
    <div class="automation-stage-head">
      <span class="automation-stage-key">${label}</span>
      <small>${key === 'when' ? 'starts the rule' : key === 'while' ? 'keeps repeat runs bounded' : 'checked after WHEN'}</small>
    </div>
    <div class="automation-condition-tree">${renderConditionNode(condition, [key], { optional, root: true })}</div>
    ${key === 'while' ? renderWhileControls() : ''}
  </section>`;
}

function renderWhileControls() {
  const metadata = S.automationEditor.draft?.metadata || {};
  const limits = S.automationCatalog?.limits || {};
  const repeat = Number(metadata.repeatEveryMs) || Number(limits.whileDefaultRepeatMs) || 60_000;
  const max = Number(metadata.maxIterations) || Math.min(100, Number(limits.whileMaxIterations) || 1000);
  return `<div class="automation-while-controls">
    <strong>Repeat safety</strong>
    <label>Run at most every
      <div class="automation-unit-input"><input type="number" min="${Math.max(1, Math.ceil(Number(limits.whileMinRepeatMs || 1000) / 1000))}" step="1" value="${Math.max(1, repeat / 1000)}" data-automation-metadata-number="repeatEveryMs" data-multiplier="1000" /><span>seconds</span></div>
    </label>
    <label>Stop after<input type="number" min="1" max="${Number(limits.whileMaxIterations) || 1000}" step="1" value="${max}" data-automation-metadata-number="maxIterations" /></label>
    <small>The counter resets when WHEN becomes false.</small>
  </div>`;
}

function conditionKind(condition) {
  if (Array.isArray(condition?.all)) return 'all';
  if (Array.isArray(condition?.any)) return 'any';
  if (condition?.not) return 'not';
  return 'predicate';
}

function pathToken(path) {
  return encodeURIComponent(JSON.stringify(path));
}

function conditionStructureOptions(selected) {
  return [
    ['predicate', 'VALUE'], ['all', 'AND'], ['any', 'OR'], ['not', 'NOT'],
  ].map(([value, label]) => `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`).join('');
}

function conditionNodeControls(path, { optional = false, root = false } = {}) {
  const token = pathToken(path);
  const index = path.at(-1);
  const canMove = Number.isInteger(index);
  const canDelete = optional || canMove;
  return `<div class="automation-block-controls">
    ${canMove ? `<button type="button" title="Move earlier" data-automation-command="move-condition" data-direction="-1" data-path="${token}">↑</button>
      <button type="button" title="Move later" data-automation-command="move-condition" data-direction="1" data-path="${token}">↓</button>` : ''}
    ${canDelete ? `<button type="button" class="danger-text" title="Remove" data-automation-command="remove-condition" data-path="${token}">${root ? 'Remove stage' : 'Remove'}</button>` : ''}
  </div>`;
}

function renderConditionNode(condition, path, options = {}) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return `<div class="automation-malformed-block">
      <strong>Malformed condition</strong>
      <small>Use Advanced JSON to inspect it, or replace this block.</small>
      <button type="button" data-automation-command="reset-condition" data-path="${pathToken(path)}">Replace condition</button>
    </div>`;
  }
  const kind = conditionKind(condition);
  const token = pathToken(path);
  if (kind === 'all' || kind === 'any') {
    const children = condition[kind];
    return `<div class="automation-boolean-group ${kind}">
      <div class="automation-group-head">
        <label>Logic<select data-automation-condition-kind data-path="${token}">${conditionStructureOptions(kind)}</select></label>
        ${conditionNodeControls(path, options)}
      </div>
      <div class="automation-group-children">
        ${children.map((child, index) => renderConditionNode(child, [...path, kind, index])).join('')}
      </div>
      <button class="automation-block-add" type="button" data-automation-command="add-condition-child" data-path="${token}">Add condition to ${kind.toUpperCase()}</button>
    </div>`;
  }
  if (kind === 'not') {
    return `<div class="automation-boolean-group not">
      <div class="automation-group-head">
        <label>Logic<select data-automation-condition-kind data-path="${token}">${conditionStructureOptions(kind)}</select></label>
        ${conditionNodeControls(path, options)}
      </div>
      <div class="automation-group-children">${renderConditionNode(condition.not, [...path, 'not'])}</div>
    </div>`;
  }

  const operator = condition.op || 'equals';
  const operators = (S.automationCatalog?.operators || []).map((item) =>
    `<option value="${escapeHtml(item.id)}"${item.id === operator ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
  const optionalRight = AUTOMATION_TEMPORAL_WINDOW.has(operator);
  const hasRight = Object.hasOwn(condition, 'right');
  return `<details class="automation-rule-block" data-block-path="${token}">
    <summary>
      <span class="automation-block-kicker">VALUE</span>
      <strong>${escapeHtml(conditionSummary(condition))}</strong>
      <small>Tap for details</small>
    </summary>
    <div class="automation-rule-block-body">
      <div class="automation-group-head compact">
        <label>Block type<select data-automation-condition-kind data-path="${token}">${conditionStructureOptions(kind)}</select></label>
        ${conditionNodeControls(path, options)}
      </div>
      ${renderValueEditor(condition.left, [...path, 'left'], 'Left value', true)}
      <label>Operator<select data-automation-condition-operator data-path="${token}">${operators}</select></label>
      ${!optionalRight || hasRight ? renderValueEditor(condition.right || { literal: '' }, [...path, 'right'], optionalRight ? 'Expected value (optional)' : 'Compared with') : `
        <div class="automation-optional-value"><span>Any value or occurrence</span><button type="button" data-automation-command="add-condition-right" data-path="${token}">Match a specific value</button></div>`}
      ${optionalRight && hasRight ? `<button class="automation-stage-remove" type="button" data-automation-command="remove-condition-right" data-path="${token}">Match any value instead</button>` : ''}
      ${AUTOMATION_TEMPORAL_DURATION.has(operator) ? `<label>Duration in seconds<input type="number" min="1" step="1" value="${Math.max(1, Number(condition.durationMs || 60_000) / 1000)}" data-automation-duration="durationMs" data-path="${token}" /></label>` : ''}
      ${AUTOMATION_TEMPORAL_WINDOW.has(operator) ? `<label>Window in seconds<input type="number" min="1" step="1" value="${Math.max(1, Number(condition.withinMs || 60_000) / 1000)}" data-automation-duration="withinMs" data-path="${token}" /></label>` : ''}
    </div>
  </details>`;
}

function renderValueEditor(node, path, label, preferRef = false) {
  const token = pathToken(path);
  const refMode = node && typeof node === 'object' && Object.hasOwn(node, 'ref');
  const value = refMode ? node.ref : literalInputValue(node?.literal);
  return `<div class="automation-value-editor">
    <label>${escapeHtml(label)}
      <div class="automation-value-row">
        <select data-automation-value-mode data-path="${token}" aria-label="${escapeHtml(label)} type">
          <option value="ref"${refMode ? ' selected' : ''}>Live value</option>
          <option value="literal"${!refMode ? ' selected' : ''}>Fixed value</option>
        </select>
        <input type="text" value="${escapeHtml(value)}" ${refMode || preferRef ? 'list="automationRefOptions"' : ''}
          placeholder="${refMode ? 'time.hour or ha.light.office.state' : 'Text, number, true, null, or JSON'}"
          data-automation-value-input data-path="${token}" />
      </div>
    </label>
  </div>`;
}

function literalInputValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function renderActionStage(label, key, actions, optional) {
  return `<section class="automation-stage stage-${key}" role="listitem">
    <div class="automation-stage-head">
      <span class="automation-stage-key">${label}</span>
      <small>${key === 'then' ? `${actions.length} action${actions.length === 1 ? '' : 's'}` : 'if a guard fails'}</small>
    </div>
    <div class="automation-action-stack">
      ${actions.map((action, index) => renderActionNode(action, [key, index])).join('')}
    </div>
    <button class="automation-block-add" type="button" data-automation-command="add-action" data-stage="${key}">Add action</button>
    ${optional ? `<button class="automation-stage-remove" type="button" data-automation-command="remove-action-stage" data-stage="${key}">Remove ${label}</button>` : ''}
  </section>`;
}

function actionTypeOptions(selected) {
  const actions = [...(S.automationCatalog?.actions || [
    { id: 'tool.call', label: 'Call a tool' }, { id: 'hud.show_notification', label: 'Show HUD notification' },
  ])];
  if (selected && !actions.some((item) => item.id === selected)) actions.push({ id: selected, label: selected });
  return actions.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
}

function renderActionNode(action, path) {
  const token = pathToken(path);
  const index = path.at(-1);
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return `<div class="automation-malformed-block">
      <strong>Malformed action ${index + 1}</strong>
      <small>Use Advanced JSON to inspect it, or replace this block.</small>
      <button type="button" data-automation-command="reset-action" data-path="${token}">Replace action</button>
    </div>`;
  }
  return `<details class="automation-rule-block action" data-block-path="${token}">
    <summary>
      <span class="automation-block-kicker">ACTION ${index + 1}</span>
      <strong>${escapeHtml(actionSummary(action))}</strong>
      <small>Tap for details</small>
    </summary>
    <div class="automation-rule-block-body">
      <div class="automation-block-controls action-controls">
        <button type="button" title="Move earlier" data-automation-command="move-action" data-direction="-1" data-path="${token}">↑</button>
        <button type="button" title="Move later" data-automation-command="move-action" data-direction="1" data-path="${token}">↓</button>
        <button type="button" class="danger-text" data-automation-command="remove-action" data-path="${token}">Remove</button>
      </div>
      <label>Action<select data-automation-action-type data-path="${token}">${actionTypeOptions(action.type)}</select></label>
      ${renderActionFields(action, path)}
    </div>
  </details>`;
}

function renderActionFields(action, path) {
  const token = pathToken(path);
  if (action.type === 'tool.call') {
    const tools = S.automationCatalog?.tools || [];
    const selected = tools.find((tool) => tool.name === action.tool);
    const options = tools.map((tool) => `<option value="${escapeHtml(tool.name)}"${tool.name === action.tool ? ' selected' : ''}${tool.automatable ? '' : ' disabled'}>${escapeHtml(tool.name)}${tool.automatable ? '' : ' — unavailable in rules'}</option>`).join('');
    return `<label>Tool<select data-automation-action-field="tool" data-path="${token}">${options}</select></label>
      ${selected?.automatable ? '' : '<p class="automation-inline-warning">This tool cannot run unattended. Replace it with <strong>Wake Carvis</strong> if confirmation is required.</p>'}
      ${renderSchemaFields(selected, action.arguments || {}, [...path, 'arguments'])}`;
  }
  if (action.type === 'variable.set') {
    return `<label>Variable name<input type="text" value="${escapeHtml(action.name || '')}" data-automation-action-field="name" data-path="${token}" /></label>
      ${renderValueEditor(action.value || { literal: '' }, [...path, 'value'], 'Value')}`;
  }
  if (action.type === 'timer.start') {
    return `<label>Timer name<input type="text" value="${escapeHtml(action.timer || '')}" data-automation-action-field="timer" data-path="${token}" /></label>
      ${renderValueEditor(action.durationMs || { literal: 300000 }, [...path, 'durationMs'], 'Duration in milliseconds')}
      <label>Payload JSON<textarea rows="4" data-automation-json-field="payload" data-path="${token}">${escapeHtml(JSON.stringify(action.payload || {}, null, 2))}</textarea></label>`;
  }
  if (action.type === 'timer.cancel') {
    return `<label>Timer name<input type="text" value="${escapeHtml(action.timer || '')}" data-automation-action-field="timer" data-path="${token}" /></label>`;
  }
  if (action.type === 'rule.enable' || action.type === 'rule.disable') {
    const rules = automationRules().filter((rule) => rule.id !== S.automationEditor.id);
    const selectedKnown = !action.ruleId || rules.some((rule) => rule.id === action.ruleId);
    const missing = !selectedKnown ? `<option value="${escapeHtml(action.ruleId)}" selected disabled>${escapeHtml(action.ruleId)} — no longer available</option>` : '';
    const options = rules.map((rule) => `<option value="${escapeHtml(rule.id)}"${rule.id === action.ruleId ? ' selected' : ''}>${escapeHtml(rule.name)}</option>`).join('');
    return `<label>Automation<select data-automation-action-field="ruleId" data-path="${token}">${missing}${options || `<option value=""${action.ruleId ? '' : ' selected'} disabled>No other rules</option>`}</select></label>`;
  }
  if (action.type === 'carvis.wake') {
    return `${renderValueEditor(action.prompt || { literal: '' }, [...path, 'prompt'], 'What Carvis should handle')}
      <p class="automation-inline-note">This always wakes Carvis as an automation. Its trigger label is fixed for audit safety.</p>`;
  }
  if (action.type === 'speech.say') {
    const speakers = (S.automationCatalog?.options?.mediaPlayers || []).filter((entity) => entity.controllable === true);
    const ttsProviders = S.automationCatalog?.options?.tts || [];
    const selectedSpeakerAvailable = !action.media_player || speakers.some((entity) => entity.entity_id === action.media_player);
    const speakerOptions = `${selectedSpeakerAvailable ? '' : `<option value="${escapeHtml(action.media_player)}" selected disabled>${escapeHtml(action.media_player)} — not controllable</option>`}${speakers.map((entity) => `<option value="${escapeHtml(entity.entity_id)}"${action.media_player === entity.entity_id ? ' selected' : ''}>${escapeHtml(entity.friendly_name || entity.name || entity.entity_id)}</option>`).join('')}`;
    const ttsAvailable = !action.tts_entity || ttsProviders.some((entity) => entity.entity_id === action.tts_entity);
    const ttsOptions = `${ttsAvailable ? '' : `<option value="${escapeHtml(action.tts_entity)}" selected disabled>${escapeHtml(action.tts_entity)} — no longer available</option>`}${ttsProviders.map((entity) => `<option value="${escapeHtml(entity.entity_id)}"${action.tts_entity === entity.entity_id ? ' selected' : ''}>${escapeHtml(entity.friendly_name || entity.name || entity.entity_id)}</option>`).join('')}`;
    return `${renderValueEditor(action.text || { literal: '' }, [...path, 'text'], 'Text to speak')}
      <label>Speaker <small>optional; only controllable players are listed</small><select data-automation-action-field="media_player" data-path="${token}"><option value="">Automatic</option>${speakerOptions}</select></label>
      <label>TTS provider <small>optional</small><select data-automation-action-field="tts_entity" data-path="${token}"><option value="">Automatic</option>${ttsOptions}</select></label>
      <label>Language <small>optional</small><input type="text" value="${escapeHtml(action.language || '')}" data-automation-action-field="language" data-path="${token}" /></label>
      <label>Provider voice hint <small>optional</small><input type="text" value="${escapeHtml(action.voice || '')}" data-automation-action-field="voice" data-path="${token}" /></label>`;
  }
  if (action.type?.startsWith('hud.')) {
    const tool = S.automationCatalog?.tools?.find((item) => item.name === action.type);
    const fields = renderSchemaFields(tool, action.payload || {}, [...path, 'payload'], {
      omit: action.type === 'hud.show_notification' ? new Set(['proactive']) : new Set(),
    });
    return action.type === 'hud.show_notification'
      ? `${fields}<p class="automation-inline-note">Saved rules are automatically treated as proactive and rate-limited; this cannot be bypassed per action.</p>`
      : fields;
  }
  return `<label>Payload JSON<textarea rows="6" data-automation-json-field="payload" data-path="${token}">${escapeHtml(JSON.stringify(action.payload || {}, null, 2))}</textarea></label>`;
}

function templateInputValue(value) {
  if (value && typeof value === 'object' && typeof value.ref === 'string' && Object.keys(value).length === 1) return `=${value.ref}`;
  if (value && typeof value === 'object' && Object.hasOwn(value, 'literal') && Object.keys(value).length === 1) return literalInputValue(value.literal);
  return literalInputValue(value);
}

function automationCommandEntities() {
  const allowedDomains = new Set(S.config?.agent?.allowedDomains || Object.keys(AUTOMATION_SERVICES_BY_DOMAIN));
  return (S.automationCatalog?.options?.entities || []).filter((entity) =>
    entity.controllable === true
    && Object.hasOwn(AUTOMATION_SERVICES_BY_DOMAIN, entity.domain)
    && allowedDomains.has(entity.domain)
    && !AUTOMATION_WELLBEING_HINT.test(entitySearchText(entity)),
  );
}

function servicesForAutomationEntity(entityId) {
  const fixed = typeof entityId === 'string' ? entityId : entityId?.literal;
  const domain = typeof fixed === 'string' ? fixed.split('.')[0] : '';
  return AUTOMATION_SERVICES_BY_DOMAIN[domain] || [];
}

function automationChoiceId(path, key) {
  return `automation-choice-${[...path, key].join('-').replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function renderSchemaFields(tool, values, path, { omit = new Set() } = {}) {
  if (!tool?.schema?.properties || !Object.keys(tool.schema.properties).length) return '<p class="muted">No arguments.</p>';
  if (!values || typeof values !== 'object' || Array.isArray(values)) values = {};
  const required = new Set(tool.schema.required || []);
  const entries = Object.entries(tool.schema.properties)
    .filter(([key]) => !omit.has(key))
    .sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)));
  const pathData = pathToken(path);
  return `<div class="automation-schema-fields">${entries.map(([key, schema]) => {
    const present = Object.hasOwn(values, key);
    const value = present ? values[key] : '';
    const label = `${key}${required.has(key) ? ' *' : ''}`;
    if (tool.name === 'ha.entity.command' && key === 'entity_id') {
      const entities = automationCommandEntities();
      const fixedValue = typeof value === 'string' ? value : typeof value?.literal === 'string' ? value.literal : '';
      const available = !fixedValue || entities.some((entity) => entity.entity_id === fixedValue);
      return `<label title="${escapeHtml(schema.description || '')}">${escapeHtml(label)}<select data-automation-template-field="entity_id" data-value-type="string" data-path="${pathData}">
        <option value="">Choose a controllable device…</option>
        ${available ? '' : `<option value="${escapeHtml(fixedValue)}" selected disabled>${escapeHtml(fixedValue)} — unavailable for unattended rules</option>`}
        ${entities.map((entity) => `<option value="${escapeHtml(entity.entity_id)}"${fixedValue === entity.entity_id ? ' selected' : ''}>${escapeHtml(entity.name || entity.entity_id)} · ${escapeHtml(entity.area || 'Unassigned')}</option>`).join('')}
      </select></label>`;
    }
    const number = schema.type === 'number' || schema.type === 'integer';
    const type = schema.type === 'boolean' ? 'boolean' : number ? schema.type : 'string';
    let choices = Array.isArray(schema.enum) ? schema.enum : schema.type === 'boolean' ? [true, false] : [];
    if (tool.name === 'ha.entity.command' && key === 'service') choices = servicesForAutomationEntity(values.entity_id);
    const choiceId = choices.length ? automationChoiceId(path, key) : '';
    let list = choiceId ? ` list="${choiceId}"` : '';
    if (!list && (key.includes('entity') || key === 'entity_id')) {
      list = tool.name === 'hud.show_camera' ? ' list="automationCameraOptions"' : ' list="automationEntityOptions"';
    }
    if (!list && key === 'media_player') list = ' list="automationSpeakerOptions"';
    const bounds = [
      number && Number.isFinite(schema.minimum) ? `minimum ${schema.minimum}` : '',
      number && Number.isFinite(schema.maximum) ? `maximum ${schema.maximum}` : '',
    ].filter(Boolean).join(', ');
    return `<label title="${escapeHtml([schema.description, bounds].filter(Boolean).join(' · '))}">${escapeHtml(label)}
      <input type="text" value="${escapeHtml(templateInputValue(value))}"${list}${number ? ' inputmode="decimal"' : ''}
        placeholder="${required.has(key) ? 'required' : 'optional'} · prefix = for a live value"
        data-automation-template-field="${escapeHtml(key)}" data-value-type="${escapeHtml(type)}" data-path="${pathData}" />
      ${choiceId ? `<datalist id="${choiceId}">${choices.map((option) => `<option value="${escapeHtml(String(option))}"></option>`).join('')}</datalist>` : ''}
    </label>`;
  }).join('')}</div>`;
}

function draftAt(path) {
  let value = S.automationEditor.draft;
  for (const key of path) value = value?.[key];
  return value;
}

function setDraftAt(path, value) {
  if (!path.length) return;
  let parent = S.automationEditor.draft;
  for (const key of path.slice(0, -1)) parent = parent[key];
  parent[path.at(-1)] = value;
}

function deleteDraftAt(path) {
  if (!path.length) return;
  const parent = draftAt(path.slice(0, -1));
  const key = path.at(-1);
  if (Array.isArray(parent) && Number.isInteger(key)) {
    parent.splice(key, 1);
    if (!parent.length) parent.push(defaultAutomationCondition());
  } else if (parent && typeof parent === 'object') {
    delete parent[key];
  }
}

function decodePath(value) {
  try { return JSON.parse(decodeURIComponent(value)); } catch { return []; }
}

function firstPredicate(condition) {
  if (!condition || typeof condition !== 'object') return defaultAutomationCondition();
  if (condition.op) return structuredClone(condition);
  if (Array.isArray(condition.all) && condition.all.length) return firstPredicate(condition.all[0]);
  if (Array.isArray(condition.any) && condition.any.length) return firstPredicate(condition.any[0]);
  if (condition.not) return firstPredicate(condition.not);
  return defaultAutomationCondition();
}

function changeConditionKind(path, nextKind) {
  const current = draftAt(path) || defaultAutomationCondition();
  const currentKind = conditionKind(current);
  if (currentKind === nextKind) return;
  let next;
  if (nextKind === 'predicate') next = firstPredicate(current);
  else if (nextKind === 'all' || nextKind === 'any') {
    const children = Array.isArray(current.all) ? current.all : Array.isArray(current.any) ? current.any : [structuredClone(current)];
    next = { [nextKind]: children };
  } else {
    next = { not: structuredClone(current) };
  }
  setDraftAt(path, next);
}

function parseFixedInput(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try { return JSON.parse(value); } catch { return value; }
}

function parseTemplateInput(raw, type = 'string') {
  const value = String(raw ?? '').trim();
  if (!value) return undefined;
  if (value.startsWith('=') && value.slice(1).trim()) return { ref: value.slice(1).trim() };
  if (type === 'integer') return Number.parseInt(value, 10);
  if (type === 'number') return Number(value);
  if (type === 'boolean') return value === 'true';
  return parseFixedInput(value);
}

function handleAutomationLaneChange(event) {
  const target = event.target;
  const path = decodePath(target.dataset.path || '');
  let needsRender = false;
  try {
    if (target.matches('[data-automation-condition-kind]')) {
      changeConditionKind(path, target.value);
      needsRender = true;
    } else if (target.matches('[data-automation-condition-operator]')) {
      const node = draftAt(path);
      node.op = target.value;
      if (AUTOMATION_TEMPORAL_DURATION.has(node.op)) {
        node.durationMs = Number(node.durationMs) || 60_000;
        delete node.withinMs;
        if (!node.right) node.right = { literal: '' };
      } else if (AUTOMATION_TEMPORAL_WINDOW.has(node.op)) {
        node.withinMs = Number(node.withinMs) || 60_000;
        delete node.durationMs;
      } else {
        delete node.durationMs;
        delete node.withinMs;
        if (!node.right) node.right = { literal: '' };
      }
      needsRender = true;
    } else if (target.matches('[data-automation-duration]')) {
      draftAt(path)[target.dataset.automationDuration] = Math.max(1, Number(target.value) || 1) * 1000;
    } else if (target.matches('[data-automation-value-mode]')) {
      setDraftAt(path, target.value === 'ref' ? { ref: 'time.hour' } : { literal: '' });
      needsRender = true;
    } else if (target.matches('[data-automation-value-input]')) {
      const current = draftAt(path);
      setDraftAt(path, current && Object.hasOwn(current, 'ref') ? { ref: target.value.trim() } : { literal: parseFixedInput(target.value) });
    } else if (target.matches('[data-automation-action-type]')) {
      setDraftAt(path, defaultAutomationAction(target.value));
      needsRender = true;
    } else if (target.matches('[data-automation-action-field]')) {
      const action = draftAt(path);
      const field = target.dataset.automationActionField;
      if (field === 'tool') {
        const tool = S.automationCatalog?.tools?.find((item) => item.name === target.value);
        action.tool = target.value;
        action.arguments = defaultToolArguments(tool);
        needsRender = true;
      } else if (target.value) action[field] = target.value;
      else delete action[field];
    } else if (target.matches('[data-automation-template-field]')) {
      const container = draftAt(path);
      const key = target.dataset.automationTemplateField;
      const value = parseTemplateInput(target.value, target.dataset.valueType);
      if (value === undefined) delete container[key];
      else container[key] = value;
      const action = draftAt(path.slice(0, -1));
      if (action?.type === 'tool.call' && action.tool === 'ha.entity.command' && key === 'entity_id') {
        const services = servicesForAutomationEntity(container.entity_id);
        if (typeof container.service === 'string' && !services.includes(container.service)) {
          container.service = services[0] || '';
        }
        needsRender = true;
      }
    } else if (target.matches('[data-automation-json-field]')) {
      const action = draftAt(path);
      action[target.dataset.automationJsonField] = JSON.parse(target.value || '{}');
    } else if (target.matches('[data-automation-metadata-number]')) {
      const key = target.dataset.automationMetadataNumber;
      const multiplier = Number(target.dataset.multiplier || 1);
      if (!S.automationEditor.draft.metadata || typeof S.automationEditor.draft.metadata !== 'object' || Array.isArray(S.automationEditor.draft.metadata)) {
        S.automationEditor.draft.metadata = {};
      }
      S.automationEditor.draft.metadata[key] = Math.max(1, Number(target.value) || 1) * multiplier;
    } else {
      return;
    }
    setAutomationDirty({ render: needsRender });
  } catch (err) {
    toast(`Could not apply block: ${err.message}`, true);
    renderAutomationEditor();
  }
}

function handleAutomationLaneClick(event) {
  const button = event.target.closest('[data-automation-command]');
  if (!button) return;
  const command = button.dataset.automationCommand;
  const path = decodePath(button.dataset.path || '');
  if (command === 'add-condition-stage') {
    S.automationEditor.draft[button.dataset.stage] = defaultAutomationCondition();
  } else if (command === 'add-condition-child') {
    const group = draftAt(path);
    const key = conditionKind(group);
    group[key].push(defaultAutomationCondition());
  } else if (command === 'remove-condition') {
    deleteDraftAt(path);
  } else if (command === 'reset-condition') {
    setDraftAt(path, defaultAutomationCondition());
  } else if (command === 'add-condition-right') {
    draftAt(path).right = { literal: '' };
  } else if (command === 'remove-condition-right') {
    delete draftAt(path).right;
  } else if (command === 'move-condition') {
    moveDraftArrayItem(path, Number(button.dataset.direction));
  } else if (command === 'add-action') {
    const stage = button.dataset.stage;
    if (!Array.isArray(S.automationEditor.draft[stage])) S.automationEditor.draft[stage] = [];
    S.automationEditor.draft[stage].push(defaultAutomationAction('hud.show_notification'));
  } else if (command === 'remove-action') {
    const parent = draftAt(path.slice(0, -1));
    if (path[0] === 'then' && parent.length <= 1) return toast('THEN needs at least one action', true);
    parent.splice(path.at(-1), 1);
  } else if (command === 'move-action') {
    moveDraftArrayItem(path, Number(button.dataset.direction));
  } else if (command === 'reset-action') {
    setDraftAt(path, defaultAutomationAction('hud.show_notification'));
  } else if (command === 'add-else') {
    S.automationEditor.draft.else = [defaultAutomationAction('hud.show_notification')];
  } else if (command === 'remove-action-stage') {
    delete S.automationEditor.draft[button.dataset.stage];
  } else {
    return;
  }
  setAutomationDirty({ render: true });
}

function moveDraftArrayItem(path, direction) {
  const list = draftAt(path.slice(0, -1));
  const index = path.at(-1);
  if (!Array.isArray(list) || !Number.isInteger(index)) return;
  const next = index + direction;
  if (next < 0 || next >= list.length) return;
  [list[index], list[next]] = [list[next], list[index]];
}

function setAutomationDirty({ render = false } = {}) {
  S.automationEditor.dirty = true;
  S.automationEditor.validation = [];
  S.automationEditor.testResult = null;
  $('#automationDirtyState').textContent = 'Unsaved changes';
  if (render) renderAutomationEditor();
  else if (document.activeElement !== $('#automationJson')) $('#automationJson').value = JSON.stringify(S.automationEditor.draft, null, 2);
}

function validationFromError(err) {
  return err.data?.validationErrors || err.data?.errors || [{ path: '$', message: err.message }];
}

function reserveAutomationId() {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12)
    || Math.random().toString(36).slice(2, 14);
  return `rule_web_${Date.now().toString(36)}_${random}`;
}

function adoptSavedAutomation(editor, rule) {
  editor.id = rule.id;
  editor.revision = rule.revision;
  editor.draft = definitionFromPublic(rule);
  editor.dirty = false;
  editor.validation = [];
  editor.testResult = null;
  history.replaceState({ carvisAutomation: true }, '', `#automations/${encodeURIComponent(rule.id)}`);
}

async function saveAutomationDraft() {
  const editor = S.automationEditor;
  if (!editor.draft || editor.saving) return;
  editor.saving = true;
  renderAutomationEditor();
  try {
    // Reserve the ID before the request. If the network drops after the
    // server commits, retrying can discover the same rule instead of creating
    // a second copy with another server-generated ID.
    if (!editor.draft.id) editor.draft.id = reserveAutomationId();
    const checked = await automationPost('/integrations/assistant-engine/api/automations/validate', { definition: editor.draft });
    const body = { definition: checked.rule };
    if (Number.isInteger(editor.revision)) body.expectedRevision = editor.revision;
    const result = await automationPost('/integrations/assistant-engine/api/automations/save', body);
    adoptSavedAutomation(editor, result.rule);
    await loadAutomations({ render: false });
    toast(result.rule.enabled ? 'Protocol saved and running' : 'Protocol saved paused');
  } catch (err) {
    // A 409 on a never-confirmed first save can mean the original response
    // was lost after commit. Recover that exact client-reserved ID rather than
    // inviting another save under a different ID.
    if (err.status === 409 && editor.revision === null && editor.draft?.id) {
      try {
        const existing = await automationPost('/integrations/assistant-engine/api/automations/get', { id: editor.draft.id });
        adoptSavedAutomation(editor, existing.rule);
        loadAutomations({ render: false }).catch(() => {});
        toast('Protocol was already saved; recovered the committed copy');
        return;
      } catch {
        // Fall through to the conflict message below.
      }
    }
    editor.validation = validationFromError(err);
    toast(err.status === 409 ? 'This protocol changed elsewhere. Reopen it before saving.' : err.message, true);
  } finally {
    editor.saving = false;
    renderAutomationEditor();
  }
}

async function testAutomationDraft() {
  const editor = S.automationEditor;
  if (!editor.draft) return;
  const button = $('#automationTestBtn');
  button.disabled = true;
  try {
    const fixture = JSON.parse($('#automationTestValues')?.value || '{}');
    if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
      throw new Error('Dry-run fixture must be one JSON object');
    }
    const unknown = Object.keys(fixture).filter((key) => !['values', 'event', 'change', 'at'].includes(key));
    if (unknown.length) throw new Error(`Unknown fixture field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    if (fixture.values !== undefined && (!fixture.values || typeof fixture.values !== 'object' || Array.isArray(fixture.values))) {
      throw new Error('fixture.values must be one JSON object');
    }
    editor.testValues = fixture;
    const testDefinition = { ...structuredClone(editor.draft), enabled: true };
    editor.testResult = await automationPost('/integrations/assistant-engine/api/automations/test', { definition: testDefinition, ...fixture });
    editor.validation = [];
  } catch (err) {
    editor.testResult = err.data?.dryRun ? err.data : null;
    editor.validation = err instanceof SyntaxError
      ? [{ path: '$.testValues', message: `Invalid fixture JSON: ${err.message}` }]
      : err.data?.actionValidationErrors || validationFromError(err);
  } finally {
    button.disabled = false;
    renderAutomationValidation();
    renderAutomationTest();
  }
}

async function duplicateAutomationDraft() {
  const id = S.automationEditor.id;
  if (!id) return;
  try {
    const result = await automationPost('/integrations/assistant-engine/api/automations/duplicate', { id });
    S.automationEditor.dirty = false;
    await loadAutomations({ render: false });
    openAutomationEditor(result.rule);
    toast('Paused copy created');
  } catch (err) {
    toast(err.message, true);
  }
}

async function archiveAutomationDraft() {
  const editor = S.automationEditor;
  if (!editor.id) return;
  if (!confirm(`Archive “${editor.draft.name}”?\n\nIts execution history stays in the database.`)) return;
  try {
    await automationPost('/integrations/assistant-engine/api/automations/archive', { id: editor.id });
    editor.dirty = false;
    await loadAutomations({ render: false });
    showAutomationList();
    toast('Protocol archived');
  } catch (err) {
    toast(err.message, true);
  }
}

function applyAutomationJson() {
  try {
    const parsed = JSON.parse($('#automationJson').value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The rule must be one JSON object');
    if (S.automationEditor.id && parsed.id && parsed.id !== S.automationEditor.id) {
      throw new Error('An existing protocol ID cannot be changed. Duplicate it instead.');
    }
    const next = structuredClone(parsed);
    for (const key of ['revision', 'archived', 'createdAt', 'updatedAt', 'createdBy', 'lastEvaluatedAt', 'lastFiredAt', 'fireCount', 'lastMatch', 'lastOutcome', 'lastError', 'summary']) {
      delete next[key];
    }
    if (S.automationEditor.id) next.id = S.automationEditor.id;
    S.automationEditor.draft = next;
    if (!Object.hasOwn(S.automationEditor.draft, 'version')) S.automationEditor.draft.version = S.automationCatalog?.version || 1;
    setAutomationDirty({ render: true });
    toast('JSON applied to blocks');
  } catch (err) {
    toast(`Invalid JSON: ${err.message}`, true);
  }
}

async function copyAutomationJson() {
  const text = $('#automationJson').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('#automationJson').select();
    document.execCommand('copy');
  }
  toast('Protocol JSON copied');
}

function renderAutomationValidation() {
  const el = $('#automationValidation');
  if (!el) return;
  const errors = S.automationEditor.validation || [];
  el.innerHTML = errors.length ? `<div class="automation-result bad">
    <strong>${errors.length} thing${errors.length === 1 ? '' : 's'} to fix</strong>
    <ul>${errors.map((error) => `<li><code>${escapeHtml(error.path || '$')}</code> ${escapeHtml(error.message || String(error))}</li>`).join('')}</ul>
  </div>` : '';
}

function renderAutomationTest() {
  const panel = $('#automationTestPanel');
  if (!panel) return;
  const result = S.automationEditor.testResult;
  panel.hidden = !result;
  if (!result) return;
  const verdict = result.fixtureRequired
    ? 'Add a change or event fixture'
    : result.triggered ? 'Would run THEN' : result.matched ? `Would run ${result.branch === 'else' ? 'ELSE' : 'no actions'}` : 'WHEN did not match';
  const actionPreview = (result.actions || []).length
    ? `<div class="automation-materialized-preview"><strong>Resolved action preview</strong><ol>${result.actions.map((action) => `<li><code>${escapeHtml(actionSummary(action))}</code><pre>${escapeHtml(JSON.stringify(action, null, 2))}</pre></li>`).join('')}</ol><small>The server resolved live references and validated the rule shape. The Tool Gateway repeats schema and safety checks at execution.</small></div>`
    : '';
  const actionErrors = result.actionValidationErrors || [];
  panel.innerHTML = `<div class="automation-result ${result.ok && !result.fixtureRequired ? 'ok' : 'bad'}">
    <div class="card-head"><strong>${escapeHtml(verdict)}</strong><span class="badge ${result.triggered ? 'live' : ''}">DRY RUN</span></div>
    <div class="automation-test-flow">
      ${['when', 'if', 'while'].map((key) => `<span><small>${key.toUpperCase()}</small><strong>${result.conditions?.[key] == null ? '—' : result.conditions[key] ? 'PASS' : 'STOP'}</strong></span>`).join('')}
      <span><small>ACTIONS</small><strong>${result.actions?.length || 0}</strong></span>
    </div>
    ${result.note ? `<p>${escapeHtml(result.note)}</p>` : ''}
    ${result.error?.message ? `<p>${escapeHtml(result.error.message)}</p>` : ''}
    ${actionErrors.length ? `<ul>${actionErrors.map((error) => `<li><code>${escapeHtml(error.path || '$.actions')}</code> ${escapeHtml(error.message || String(error))}</li>`).join('')}</ul>` : ''}
    ${actionPreview}
    <details><summary>Exact preview</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></details>
  </div>`;
}

async function loadAutomationHistory() {
  const id = S.automationEditor.id;
  if (!id) return;
  const result = await automationPost('/integrations/assistant-engine/api/automations/history', { id, limit: 50 });
  S.automationEditor.history = result.runs;
  renderAutomationHistory();
}

function renderAutomationHistory() {
  const el = $('#automationHistory');
  if (!el) return;
  const editor = S.automationEditor;
  if (!editor.id) {
    el.innerHTML = '<p class="empty">Save this protocol to record and view its runs.</p>';
    return;
  }
  if (editor.history === null) {
    el.innerHTML = '<p class="empty">Open this section to load execution history.</p>';
    return;
  }
  el.innerHTML = editor.history.length ? editor.history.map((run) => `<details class="automation-history-row ${run.outcome === 'ok' ? 'ok' : 'bad'}">
    <summary><span>${run.outcome === 'ok' ? '✓' : '!'}</span><strong>${escapeHtml(run.outcome || 'unknown')}</strong><time>${fmtTime(run.ts)}</time><small>${run.ms || 0}ms · ${run.actions?.length || 0} actions</small></summary>
    ${run.error ? `<p class="automation-card-error">${escapeHtml(run.error)}</p>` : ''}
    <pre>${escapeHtml(JSON.stringify({ trigger: run.trigger, actions: run.actions }, null, 2))}</pre>
  </details>`).join('') : '<p class="empty">This protocol has not run yet.</p>';
}

function renderAutomationDatalists() {
  if (!$('#automationRefOptions')) return;
  const refs = new Set();
  for (const source of S.automationCatalog?.values || []) {
    for (const ref of source.examples || []) if (!/[<>]/.test(ref)) refs.add(ref);
  }
  for (const entity of S.automationCatalog?.options?.entities || []) if (entity.ref) refs.add(entity.ref);
  for (const location of S.automationCatalog?.options?.locations || []) {
    if (location.entity_id) refs.add(`location.${location.entity_id.split('.').slice(1).join('.')}`);
  }
  for (const variable of S.automations?.variables || []) refs.add(`variable.${variable.name}`);
  for (const project of S.automationCatalog?.options?.atlasProjects || []) {
    const id = String(project?.id || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) continue;
    refs.add(`atlas.project.${id}.exists`);
    refs.add(`atlas.project.${id}.state`);
  }
  for (const task of S.automationCatalog?.options?.atlasTasks || []) {
    const id = String(task?.id || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) continue;
    refs.add(`atlas.task.${id}.state`);
  }
  for (const timer of [...(S.automations?.timers || []), ...(S.automations?.alarms || [])]) {
    const ids = [timer.id, timer.name].filter((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(value || '')));
    for (const id of ids) {
      refs.add(`${timer.kind}.${id}.status`);
      refs.add(`${timer.kind}.${id}.remaining_seconds`);
    }
  }
  $('#automationRefOptions').innerHTML = [...refs].sort().map((ref) => `<option value="${escapeHtml(ref)}"></option>`).join('');
  $('#automationEntityOptions').innerHTML = (S.automationCatalog?.options?.entities || [])
    .filter((entity) => entity.controllable === true)
    .map((entity) => `<option value="${escapeHtml(entity.entity_id)}">${escapeHtml(entity.name || entity.friendly_name || entity.entity_id)}</option>`).join('');
  $('#automationCameraOptions').innerHTML = (S.automationCatalog?.options?.entities || [])
    .filter((entity) => entity.domain === 'camera')
    .map((entity) => `<option value="${escapeHtml(entity.entity_id)}">${escapeHtml(entity.name || entity.entity_id)}</option>`).join('');
  $('#automationSpeakerOptions').innerHTML = (S.automationCatalog?.options?.mediaPlayers || [])
    .filter((entity) => entity.controllable === true)
    .map((entity) => `<option value="${escapeHtml(entity.entity_id)}">${escapeHtml(entity.name || entity.entity_id)}</option>`).join('');
}

/* ── carvis ────────────────────────────────────────────────── */

function wireTvPanel() {
  const panel=$('#tvPanel');let run=null,busy=false,refreshing=false,previewUrl=null;
  const controls=()=>{
    const running=run?.status==='running';
    $('#tvStart').disabled=busy || refreshing || !run || running;
    $('#tvUpdate').disabled=busy || refreshing || !running;
    $('#tvStop').disabled=busy || refreshing || !running;
    $('#tvContextText').disabled=busy || !running;
  };
  const refresh=async()=>{
    if(refreshing)return;refreshing=true;controls();
    try {
      run=await api('/integrations/assistant-engine/api/tv/status');
      $('#tvStatus').textContent=String(run.status || 'idle').replaceAll('_',' ');
      $('#tvGoal').textContent=run.goal || 'No task yet.';
      $('#tvProgress').textContent=run.message || 'Ready for a TV request.';
      $('#tvObservation').textContent=run.latest_observation?`Last observation: ${run.latest_observation}`:'';
      const revision=run.context_revision || 0;
      $('#tvContextState').textContent=revision?((run.applied_context_revision || 0)>=revision?'Latest context applied.':'Context received — waiting for the next decision.') : '';
    } catch(error) {
      run=null;$('#tvStatus').textContent='Unavailable';$('#tvProgress').textContent=error.message;
      $('#tvGoal').textContent='';$('#tvObservation').textContent='';$('#tvContextState').textContent='';
    } finally {refreshing=false;controls();}
  };
  const command=async(tool,args)=>{
    if(busy)return false;busy=true;controls();$('#tvActionNote').textContent='Sending…';
    try {
      const result=await api('/integrations/assistant-engine/api/carvis/tool',{method:'POST',body:JSON.stringify({tool,arguments:args})});
      if(!result.success)throw Error(result.error || result.message || 'The request was not accepted.');
      $('#tvActionNote').textContent=result.dry_run?'Dry run: no TV action was sent.':tool==='ha.apple_tv.context'?'Context received. The same task will use it on its next decision.':tool==='ha.apple_tv.stop'?'Task stopped.':'Task started. Progress will appear here.';
      await refresh();return true;
    } catch(error) {$('#tvActionNote').textContent=error.message;await refresh();return false;}
    finally {busy=false;controls();}
  };
  $('#tvTaskForm').addEventListener('submit',async e=>{e.preventDefault();if(!run || run.status==='running' || refreshing)return;const input=$('#tvTaskText');const text=input.value.trim();if(text && await command('ha.apple_tv.task',{goal:text}))input.value='';});
  $('#tvContextForm').addEventListener('submit',async e=>{e.preventDefault();if(run?.status!=='running' || refreshing)return;const input=$('#tvContextText');const text=input.value.trim();if(text && await command('ha.apple_tv.context',{id:run.id,context:text}))input.value='';});
  $('#tvStop').addEventListener('click',()=>{if(run?.status==='running')command('ha.apple_tv.stop',{id:run.id});});
  $('#tvRefresh').addEventListener('click',refresh);
  $('#tvPreviewRefresh').addEventListener('click',async()=>{
    const button=$('#tvPreviewRefresh'),img=$('#tvPreview'),note=$('#tvPreviewNote');button.disabled=true;note.hidden=false;note.textContent='Loading screen…';img.hidden=true;$('#tvPreviewTime').textContent='';
    if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}img.removeAttribute('src');
    try {const r=await fetch('/integrations/assistant-engine/api/tv/frame',{cache:'no-store'});if(!r.ok)throw Error('Screen preview unavailable. Try again.');previewUrl=URL.createObjectURL(await r.blob());img.src=previewUrl;await img.decode();img.hidden=false;note.hidden=true;$('#tvPreviewTime').textContent=`Snapshot ${new Date().toLocaleTimeString()}`;}
    catch(error){note.hidden=false;note.textContent=error.message;img.hidden=true;}
    finally {button.disabled=false;}
  });
  panel.addEventListener('toggle',()=>{if(panel.open)refresh();});
  setInterval(()=>{if(panel.open && !document.hidden && panel.getClientRects().length && !busy)refresh();},5000);
  controls();
}

function wireCarvis() {
  wireTvPanel();
  let attachedImage=null;
  const imageInput=$('#sayImage'),imageStatus=$('#sayImageStatus'),imageRemove=$('#sayImageRemove');
  imageInput.addEventListener('change',async()=>{
    const file=imageInput.files?.[0];if(!file)return;
    if(file.size>6*1024*1024){toast('Choose an image no larger than 6 MB.',true);imageInput.value='';return;}
    $('#saySend').disabled=true;imageInput.disabled=true;imageRemove.disabled=true;imageStatus.textContent='Attaching image…';
    try{
      const response=await fetch('/integrations/assistant-engine/api/vision/image',{method:'POST',headers:{'Content-Type':file.type || 'application/octet-stream'},body:file});
      const result=await response.json();if(!response.ok)throw Error(result.message || 'Could not attach image.');
      if(attachedImage)api('/integrations/assistant-engine/api/vision/remove',{method:'POST',body:JSON.stringify({id:attachedImage.id})}).catch(()=>{});
      attachedImage={...result,name:file.name};imageStatus.textContent=`Attached: ${file.name}`;imageRemove.hidden=false;
    }catch(error){imageStatus.textContent=attachedImage?`Attached: ${attachedImage.name}`:'No image attached.';toast(error.message,true);}
    finally{$('#saySend').disabled=false;imageInput.disabled=false;imageRemove.disabled=false;imageInput.value='';}
  });
  imageRemove.addEventListener('click',async()=>{
    if(attachedImage)await api('/integrations/assistant-engine/api/vision/remove',{method:'POST',body:JSON.stringify({id:attachedImage.id})}).catch(()=>{});
    attachedImage=null;imageRemove.hidden=true;imageStatus.textContent='No image attached.';
  });
  $('#sayForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('#sayText').value.trim() || (attachedImage?'Describe this image.':'');
    if (!text) return;
    $('#sayText').value = '';
    $('#saySend').disabled = true;
    imageInput.disabled=true;imageRemove.disabled=true;
    try {
      const r = await api('/integrations/assistant-engine/api/carvis/request', { method: 'POST', body: JSON.stringify({ text,image_ids:attachedImage?[attachedImage.id]:[] }) });
      if(attachedImage && r.outcome!=='error' && r.outcome!=='ignored'){
        attachedImage=null;imageRemove.hidden=true;imageStatus.textContent='Image sent. Available for follow-up questions for 15 minutes.';
      }
      if (r.outcome === 'ignored') toast(`Ignored — ${r.reason}`);
      else if (r.outcome === 'error') toast(r.error, true);
      else if (r.outcome === 'confirmation') toast('Confirm on your glasses or here');
    } catch (err) {
      toast(err.message, true);
    } finally {
      $('#saySend').disabled = false;
      imageInput.disabled=false;imageRemove.disabled=false;
    }
  });

  $('#macForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const command = $('#macText').value.trim();
    if (!command) return;
    $('#macText').value = '';
    const r = await api('/integrations/assistant-engine/api/mac/dispatch', { method: 'POST', body: JSON.stringify({ command }) });
    toast(r.ok ? `Queued: ${command}` : r.message, !r.ok);
  });

  $('#hudClearBtn').addEventListener('click', async () => {
    await api('/integrations/assistant-engine/api/hud/clear', { method: 'POST', body: '{}' });
    toast('HUD clear requested');
    applySnapshot(await api('/integrations/assistant-engine/api/state'));
  });

  $('#atlasRefreshBtn').addEventListener('click', async () => {
    const r = await api('/integrations/assistant-engine/api/atlas/refresh', { method: 'POST', body: '{}' });
    S.atlas = r.state;
    renderCarvis();
    scheduleAutomationCatalogRefresh(0);
    toast(r.ok ? 'Atlas refreshed' : r.error || 'Atlas unreachable', !r.ok);
  });
}

/* ── transcript ────────────────────────────────────────────── */

function wireTranscript() {
  $('#transcriptRefreshBtn').addEventListener('click', async () => {
    const button = $('#transcriptRefreshBtn');
    button.disabled = true;
    try {
      const snapshot = await api('/integrations/assistant-engine/api/state');
      S.transcript = snapshot.transcript || S.transcript;
      renderTranscript();
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('#transcriptClearBtn').addEventListener('click', async () => {
    const button = $('#transcriptClearBtn');
    button.disabled = true;
    try {
      const result = await api('/integrations/assistant-engine/api/voice/transcript/clear', { method: 'POST', body: '{}' });
      S.transcript = result.transcript;
      renderTranscript();
      toast(result.cleared ? `Cleared ${result.cleared} entr${result.cleared === 1 ? 'y' : 'ies'}` : 'Transcript already empty');
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function transcriptSource(entry) {
  if (entry.kind === 'typed' || entry.source === 'web') return 'WebUI';
  return entry.source === 'glasses' ? 'G2 voice' : String(entry.source || 'voice');
}

function transcriptLabel(entry) {
  const labels = {
    processing: 'Checking',
    working: 'Working',
    confirmation: 'Confirm',
    acted: 'Acted',
    filed: 'Filed',
    ignored: 'Ignored',
    declined: 'Declined',
    stale: 'Stale',
    error: 'Failed',
  };
  return labels[entry.outcome] || entry.outcome || 'Checking';
}

function renderTranscript() {
  const list = $('#transcriptList');
  if (!list) return;
  const transcript = S.transcript;
  const entries = transcript?.entries || [];
  $('#transcriptMeta').textContent = entries.length ? `${entries.length} recent · memory only` : 'memory only';
  list.innerHTML = entries.length
    ? entries
        .slice()
        .reverse()
        .map((entry) => {
          const outcome = String(entry.outcome || 'processing').replace(/[^a-z]/g, '') || 'processing';
          const tools = (entry.actions || []).length
            ? `<div class="transcript-tools">${entry.actions.map((tool) => `<code>${escapeHtml(tool)}</code>`).join('')}</div>`
            : '';
          return `<article class="transcript-row ${escapeHtml(outcome)}">
            <div class="transcript-head">
              <time>${fmtTime(entry.ts)}</time>
              <span class="transcript-source">${escapeHtml(transcriptSource(entry))}</span>
              <span class="transcript-outcome">${escapeHtml(transcriptLabel(entry))}</span>
            </div>
            <p class="transcript-text">${escapeHtml(entry.text)}</p>
            <p class="transcript-detail">${escapeHtml(entry.detail || '')}</p>
            ${entry.reply ? `<p class="transcript-reply">Carvis: ${escapeHtml(entry.reply)}</p>` : ''}
            ${tools}
          </article>`;
        })
        .join('')
    : '<p class="empty">Nothing heard yet this session.</p>';
}

/* ── execution trace ───────────────────────────────────────── */

function wireTrace() {
  $('#traceRefreshBtn').addEventListener('click', async () => {
    const button = $('#traceRefreshBtn');
    button.disabled = true;
    try {
      S.trace = await api('/integrations/assistant-engine/api/carvis/trace?limit=25');
      renderTrace();
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function traceJson(value) {
  return escapeHtml(JSON.stringify(value ?? null, null, 2));
}

function traceDuration(ms) {
  const value = Number(ms || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${value}ms`;
}

function traceModelLabel(step) {
  return [step.provider, step.model].filter(Boolean).join(' · ') || step.role || 'model';
}

function traceTriggerLabel(invocation) {
  const trigger = invocation.trigger || {};
  const source = trigger.source === 'web' ? 'typed in the WebUI' : trigger.source === 'glasses' ? 'heard through the G2' : '';
  const labels = {
    user_voice: source || 'heard from the owner',
    user_text: source || 'typed by the owner',
    // Historical rows only: watches and scheduled wakeups were replaced by
    // protocols, so nothing produces these trigger types anymore.
    watch: 'a watch fired',
    heartbeat: trigger.watch_id ? 'a watch fired' : 'a scheduled home check fired',
    scheduled_wakeup: 'a scheduled wakeup fired',
    home_event: trigger.event ? `a home event occurred: ${trigger.event}` : 'a home event occurred',
    overheard: 'an unaddressed project-related utterance was heard',
    internal: 'an internal Carvis task started',
  };
  return labels[invocation.triggerType] || labels[trigger.type] || 'Carvis was invoked';
}

function traceToolVerb(call) {
  const args = call.arguments || {};
  const result = call.result || {};
  const entity = args.entity_id || result.entity_id || '';
  const service = args.service || result.service || '';
  const tool = call.tool || 'tool';
  const entityText = entity ? ` ${entity}` : '';
  const serviceText = service ? ` · ${service.replace(/_/g, ' ')}` : '';
  const verbs = {
    'ha.get_state': 'Checked',
    'ha.find_entities': 'Looked up Home Assistant entities',
    'ha.get_area_state': 'Checked a room',
    'ha.light.set': 'Changed lights',
    'ha.light.list_effects': 'Looked up lamp effects',
    'ha.light.set_effect': 'Set a lamp effect',
    'ha.switch.set': 'Changed a switch or fan',
    'ha.media.control': 'Controlled media',
    'ha.entity.command': 'Sent a Home Assistant command to',
    'ha.secure.command': 'Sent a secure Home Assistant command to',
    'ha.scene.activate': 'Activated a scene',
    'ha.printer.get_status': 'Checked printer status',
    'hud.show_camera': 'Put a camera on the HUD',
    'hud.set_widget': 'Updated a HUD widget',
    'hud.bind_widget': 'Bound a live HUD widget',
    'hud.show_notification': 'Showed a HUD notification',
    'hud.clear_all': 'Cleared the HUD',
    'hud.get_state': 'Checked the HUD',
    'atlas.context.get': 'Checked Project Atlas',
    'atlas.search': 'Searched Project Atlas',
    'atlas.capture': 'Filed an Atlas capture',
    'atlas.task.create': 'Created an Atlas task',
    'atlas.task.complete': 'Completed an Atlas task',
    'watch.create': 'Created a watch',
    'watch.schedule': 'Created a scheduled wakeup',
    'watch.cancel': 'Cancelled a watch or wakeup',
    'automation.create': 'Saved a protocol',
    'automation.update': 'Updated a protocol',
    'automation.enable': 'Enabled a protocol',
    'automation.disable': 'Paused a protocol',
    'mac.command': 'Sent a command to the Mac',
    'mac.get_state': 'Checked the Mac bridge',
    'memory.recall': 'Looked up memory',
    'memory.remember': 'Saved memory',
    'memory.forget': 'Removed memory',
    'web.search': 'Searched the web',
  };
  const verb = verbs[tool] || (tool === 'speech.say' ? 'Requested speech output' : `Called ${tool}`);
  return `${verb}${entityText}${serviceText}`;
}

function traceResultLabel(call) {
  if (call.outcome === 'accepted' && call.tool !== 'speech.say') return 'Command accepted; device state unverified';
  if (call.outcome === 'succeeded' && call.result?.verified === true) return 'Device state confirmed';
  const labels = {
    failed: 'Failed or blocked', read: 'Read completed', succeeded: 'Tool reported success',
    queued: 'Queued for the Mac agent; execution unconfirmed',
    accepted: 'Speech request accepted; playback unconfirmed',
    deduplicated: 'Reused previous result; no new execution', dry_run: 'Dry run; no device command sent',
  };
  if (labels[call.outcome]) return labels[call.outcome];
  if (!call.ok) return call.authorization === 'denied_risk' ? 'Blocked by risk policy' : 'Blocked or failed';
  if (call.result?.deduplicated) return 'Already completed; skipped duplicate';
  if (call.result?.dry_run) return 'Dry run — nothing sent';
  if (call.authorization === 'deduplicated') return 'Already completed; skipped duplicate';
  return 'Done';
}

function traceActionCard(call) {
  const outcome = call.outcome === 'failed' || !call.ok ? 'failed' : 'ok';
  const risk = ['read', 'low', 'medium', 'sensitive', 'critical'][call.risk] || `risk ${call.risk}`;
  return `<details class="trace-flow-block action ${outcome}">
    <summary>
      <span class="trace-block-kicker">${call.risk === 0 ? 'Read' : outcome === 'failed' ? 'Attempted' : 'Tool'}</span>
      <strong>${escapeHtml(traceToolVerb(call))}</strong>
      <small>${escapeHtml(traceResultLabel(call))} · ${escapeHtml(risk)} · ${traceDuration(call.durationMs)} · +${traceDuration(call.offsetMs)}</small>
    <div class="trace-facts">${(call.facts || []).map((fact) => `<div><span>${escapeHtml(fact.label)}</span><strong>${escapeHtml(fact.value)}</strong></div>`).join('')}${call.diagnostic ? `<p class="trace-block-error">${escapeHtml(call.diagnostic)}</p>` : ''}</div>
    </summary>
    <div class="trace-action-details">
      <div><span>Tool</span><code>${escapeHtml(call.tool)}</code></div>
      <div><span>Gateway</span><code>${escapeHtml(call.authorization || 'unknown')}</code></div>
      <details class="trace-technical"><summary>Technical details</summary><div class="trace-data-grid">
        <div class="trace-data"><small>Arguments</small><pre>${traceJson(call.arguments)}</pre></div>
        <div class="trace-data"><small>Result</small><pre>${traceJson(call.result)}</pre></div>
        ${call.error ? `<div class="trace-data"><small>Error</small><pre>${escapeHtml(call.error)}</pre></div>` : ''}
      </div></details>
    </div>
  </details>`;
}

function traceToolCard(call) {
  return traceActionCard(call);
}

function traceModelPass(step, calls) {
  const round = Number(step.round || 0) + (Number(step.round || 0) === 0 ? 1 : 0);
  const label = step.kind === 'gateway' ? 'Tool audit; model step not recorded' : step.phase === 'acknowledgement'
    ? 'Carvis sent its immediate acknowledgement'
    : step.kind === 'escalation'
    ? 'Carvis asked for a stronger model'
    : step.outcome === 'error'
      ? `Model pass ${round} failed`
      : step.toolCount
        ? `Model pass ${round} requested ${step.toolCount} tool call${step.toolCount === 1 ? '' : 's'}`
        : `Model pass ${round} finished its response`;
  const status = step.outcome === 'error' ? 'failed' : step.kind === 'escalation' ? 'notice' : 'ok';
  return [
    `<details class="trace-flow-block model ${status}">
      <summary><span class="trace-block-kicker">${step.kind === 'gateway' ? 'Gateway' : 'Model'}</span>
      <strong>${escapeHtml(label)}</strong>
      <small>${step.kind === 'gateway' ? 'Tool calls recovered from the audit log' : `${escapeHtml(traceModelLabel(step))} · ${traceDuration(step.durationMs)} · +${traceDuration(step.offsetMs)}`}</small></summary>
      <div class="trace-block-details">
        ${step.kind !== 'gateway' ? `<span>Round <code>${round}</code></span>` : ''}
        <span>Type <code>${escapeHtml(step.kind || 'model')}</code></span>
        <span>Outcome <code>${escapeHtml(step.outcome || 'complete')}</code></span>
      </div>
      ${step.diagnostic ? `<p class="trace-step-error">${escapeHtml(step.diagnostic)}</p>` : ''}
    </details>`,
    ...calls.map(traceActionCard),
  ];
}

function traceFlow(blocks) {
  return blocks.filter(Boolean).map((block, index) => `${index ? '<span class="trace-flow-arrow" aria-hidden="true">→</span>' : ''}${block}`).join('');
}

function traceInvocationCard(invocation, index) {
  const callsByRound = new Map();
  const unassigned = [];
  for (const call of invocation.toolCalls || []) {
    if (call.round === null || call.round === undefined || !call.round) unassigned.push(call);
    else {
      const group = callsByRound.get(call.round) || [];
      group.push(call);
      callsByRound.set(call.round, group);
    }
  }
  const visibleBlocks = (invocation.steps || []).flatMap((step) =>
    traceModelPass(step, step.kind === 'model' ? callsByRound.get(step.round) || [] : []),
  );
  for (const [round, calls] of callsByRound) {
    if (!(invocation.steps || []).some((step) => step.round === round)) {
      visibleBlocks.push(...traceModelPass({ kind: 'gateway', round, toolCount: calls.length, outcome: 'gateway audit' }, calls));
    }
  }
  if (unassigned.length) visibleBlocks.push(...traceModelPass({ kind: 'gateway', toolCount: unassigned.length, outcome: 'gateway audit' }, unassigned));

  const model = [invocation.provider, invocation.model].filter(Boolean).join(' · ') || 'model pending';
  const rounds = invocation.modelRounds || invocation.declaredRounds || 0;
  const state = invocation.outcome === 'running' ? 'running' : invocation.outcome === 'error' || invocation.summary?.failed > 0 ? 'failed' : 'ok';
  const counts = invocation.summary || {};
  const parts = [
    [counts.read, 'read'], [counts.succeeded, 'successful tool call'], [counts.failed, 'failure'],
    [counts.queued, 'queued command'], [counts.accepted, 'accepted speech request'],
    [counts.deduplicated, 'reused result'], [counts.dry_run, 'dry run'],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`);
  const finalLabel = state === 'running' ? 'Carvis is still working'
    : parts.length ? parts.join(' · ') : state === 'failed' ? 'Carvis stopped with an error' : 'Turn ended without tool calls';

  const heard = invocation.trigger?.transcript;
  const heardDetails = heard
    ? `<blockquote class="trace-heard-text">${escapeHtml(heard)}</blockquote>`
    : '<span>No owner wording for this background turn.</span>';
  return `<article class="trace-invocation ${state}">
    <div class="trace-invocation-header">
      <span class="trace-outcome">${state === 'ok' ? '✓' : state === 'running' ? '…' : '×'}</span>
      <span class="trace-summary-main"><strong>${escapeHtml(traceTriggerLabel(invocation))}</strong><small>${escapeHtml(finalLabel)}</small></span>
      <span class="trace-summary-meta">${rounds} round${rounds === 1 ? '' : 's'} · ${traceDuration(invocation.durationMs)} · ${ago(invocation.startedAt)}</span>
    </div>
    <div class="trace-invocation-body">
      <div class="trace-flow" aria-label="Carvis execution flow">
        ${traceFlow([
          `<details class="trace-flow-block heard"><summary><span class="trace-block-kicker">Trigger</span><strong>${escapeHtml(traceTriggerLabel(invocation))}</strong><small>${heard ? 'Click for exact wording' : 'Click for source details'}</small></summary><div class="trace-block-details"><span>Source <code>${escapeHtml(invocation.triggerType || 'unknown')}</code></span>${heardDetails}
            ${invocation.trigger?.event_data?.entity_id ? `<span>Entity <code>${escapeHtml(invocation.trigger.event_data.entity_id)}</code></span>` : ''}
            ${invocation.trigger?.transition ? `<span>Change <strong>${escapeHtml(invocation.trigger.transition)}</strong></span>` : ''}
            ${typeof invocation.trigger?.importance === 'number' ? `<span>Classifier importance ${Math.round(invocation.trigger.importance * 100)}% (model estimate)</span>` : ''}
            ${typeof invocation.trigger?.confirmed === 'boolean' ? `<span>Owner confirmation: ${invocation.trigger.confirmed ? 'recorded' : 'not recorded'}</span>` : ''}
            ${typeof invocation.trigger?.wake_word === 'boolean' ? `<span>Wake word: ${invocation.trigger.wake_word ? 'detected' : 'not detected'}</span>` : ''}
            ${typeof invocation.trigger?.triage_ms === 'number' ? `<span>Speech routing ${traceDuration(invocation.trigger.triage_ms)}</span>` : ''}
            <span>Started ${escapeHtml(new Date(invocation.startedAt).toLocaleString())}</span>
          </div></details>`,
          ...visibleBlocks,
          `<details class="trace-flow-block outcome ${state}"><summary><span class="trace-block-kicker">Result</span><strong>${escapeHtml(finalLabel)}</strong><small>${state === 'running' ? 'Still in progress' : state === 'failed' ? 'Needs attention' : 'Click for model, time, and usage'}</small></summary><div class="trace-block-details"><span>Model <code>${escapeHtml(model)}</code></span><span>Role <code>${escapeHtml(invocation.role || 'carvis')}</code></span><span>Usage ${Number(invocation.usage?.inputTokens || 0).toLocaleString()} in / ${Number(invocation.usage?.outputTokens || 0).toLocaleString()} out</span><span>Cached input ${Number(invocation.usage?.cachedTokens || 0).toLocaleString()} tokens</span><span>Cost $${Number(invocation.costUsd || 0).toFixed(4)}</span><span>Invocation <code>${escapeHtml(invocation.id)}</code></span><span>Recorded outcome <code>${escapeHtml(invocation.outcome)}</code></span>${invocation.diagnostic ? `<span class="trace-block-error">${escapeHtml(invocation.diagnostic)}</span>` : ''}</div></details>`,
        ])}
      </div>
    </div>
  </article>`;
}

function renderTrace() {
  const list = $('#traceList');
  if (!list) return;
  const trace = S.trace;
  const invocations = trace?.invocations || [];
  $('#traceMeta').textContent = invocations.length ? `${invocations.length} recent invocation${invocations.length === 1 ? '' : 's'}` : '';

  const manual = trace?.unattachedToolCalls || [];
  list.innerHTML = invocations.length
    ? invocations.map(traceInvocationCard).join('') +
      (manual.length
        ? `<div class="trace-manual"><h2>Manual gateway checks</h2>${manual.map(traceToolCard).join('')}</div>`
        : '')
    : '<p class="empty">No Carvis invocations recorded yet.</p>';
}

const FEED_ICON = { action: '▸', reply: '◗', note: '✎', error: '✕', heard: '‹' };

function renderCarvis() {
  const list = $('#feedList');
  if (S.feed.length) {
    list.innerHTML = S.feed
      .slice()
      .reverse()
      .map(
        (e) =>
          `<div class="log-row ${e.kind === 'error' ? 'error' : e.kind === 'action' ? 'action' : 'think'}"><time>${fmtTime(e.ts)}</time><span class="msg">${FEED_ICON[e.kind] || '·'} ${escapeHtml(e.text)}${e.detail ? ` <small class="muted">— ${escapeHtml(e.detail)}</small>` : ''}</span></div>`,
      )
      .join('');
  }
  $('#feedMeta').textContent = S.feed.length ? `${S.feed.length} shown` : '';

  const v = S.voice;
  if (v) {
    // Mute lives on the G2 now — Carvis has no opinion on it, so the subtitle
    // describes what Carvis itself is doing, not something it cannot see.
    $('#carvisSub').textContent = v.enabled
      ? `Listening${v.requireWakeWord ? ` for "${v.wakeWords[0]}"` : ''}.`
      : 'Voice is switched off in Settings.';
    $('#voiceStats').textContent = `${v.stats.heard} heard`;
    $('#voiceExplain').textContent = v.stats.heard
      ? `Acted on ${v.stats.acted}, filed ${v.stats.filed} to Atlas, ignored ${v.stats.dropped}. Ignored is meant to be the big number — most of what the glasses hear is not for Carvis.`
      : 'Nothing heard yet this session.';
  }

  const a = S.atlas;
  if (a) {
    $('#atlasPanel').innerHTML = !a.enabled
      ? '<p class="empty">Switched off in Settings.</p>'
      : a.status !== 'ok'
        ? `<p class="empty bad">${escapeHtml(a.error || a.status)}</p>`
        : `<p class="muted">Atlas ${escapeHtml(a.version)} via <code>${escapeHtml(a.endpoint || '?')}</code> · ${a.projects} active projects · ${a.openTasks} open tasks${a.briefingDate ? ` · briefing ${escapeHtml(a.briefingDate)}` : ''}</p>
           <p class="muted">${a.canWrite ? '✓ Writes enabled.' : '✗ No API token — Carvis can read Atlas but cannot file anything. Run <code>atlas token set</code>.'}</p>`;
  }

  const m = S.mac;
  if (m) {
    $('#macMeta').textContent = m.enabled ? `${m.pending} queued` : 'off';
    $('#macPanel').innerHTML = !m.enabled
      ? '<p class="empty">Switched off in Settings.</p>'
      : (m.recent.length
          ? m.recent
              .slice(0, 6)
              .map(
                (i) =>
                  `<div class="log-row ${i.status === 'failed' ? 'error' : 'think'}"><time>${fmtTime(i.ts)}</time><span class="msg">${escapeHtml(i.command)} <small class="muted">— ${escapeHtml(i.status)}${i.result ? `: ${escapeHtml(i.result)}` : ''}</small></span></div>`,
              )
              .join('')
          : '<p class="empty">Nothing sent yet.</p>') +
        (m.agentSeen
          ? ''
          : '<p class="muted">Your Mac agent has never polled <code>/integrations/assistant-engine/api/mac/pending</code>, so anything sent will just queue.</p>');
  }

  renderGlassesDisplay();
  renderWatches();
  renderClassifier();
  renderCost();

  const warn = $('#bindWarning');
  warn.hidden = !S.bindWarning;
  warn.textContent = S.bindWarning || '';
}

/** Render only the last page positively acknowledged by the G2 bridge. */
function renderGlassesDisplay() {
  const state = S.glassesDisplay;
  const screen = $('#glassesScreen');
  const badge = $('#glassesStateBadge');
  if (!screen || !badge) return;

  const dot = $('#glassesDot');
  const text = $('#glassesStatusText');
  const line = $('#glassesStatline');

  if (!state?.display) {
    badge.textContent = 'UNKNOWN';
    badge.className = 'badge';
    screen.className = 'g2-screen';
    screen.innerHTML = '<div class="g2-empty-state">Waiting for a G2 to report what it actually rendered.</div>';
    $('#hudNote').textContent = 'Assigned HUD state is intentionally not shown here.';
    if (dot) dot.className = 'dot';
    if (text) text.textContent = 'Glasses never connected';
    if (line) line.title = 'No G2 has reported in since the server last started.';
    return;
  }

  const ageMs = state.lastSeen ? Math.max(0, Date.now() - state.lastSeen) : Infinity;
  const connection = !state.active
    ? 'inactive'
    : ageMs > (state.staleAfterMs || 35_000)
      ? 'stale'
      : 'live';
  const display = state.display;
  badge.textContent = connection === 'live' ? 'LIVE' : connection === 'inactive' ? 'INACTIVE' : 'STALE';
  badge.className = `badge ${connection === 'live' ? 'live' : connection === 'inactive' ? 'warn' : 'offline'}`;
  screen.className = `g2-screen ${connection === 'live' ? '' : 'offline'}`.trim();

  const status = `<div class="g2-status-line">${escapeHtml(display.status || ' ')}</div>`;
  const indicatorDot = display.indicator ? '<div class="g2-idle-display" aria-label="Microphone indicator">.</div>' : '';
  let body;
  if (display.mode === 'idle') {
    // Reflect the actual blank resting page and optional microphone dot.
    body = indicatorDot;
    screen.innerHTML = `<div class="g2-confirmed-view">${body}</div>`;
  } else if (display.mode === 'activity') {
    // Active hearing/thinking uses only the single physical status line, not
    // a made-up empty grid beneath it.
    body = `<div class="g2-activity-display">${status}</div>`;
    screen.innerHTML = `<div class="g2-confirmed-view">${body}${indicatorDot}</div>`;
  } else if (display.mode === 'grid') {
    body = `<div class="g2-grid-display">${display.slots
      .map((slot) => {
        if (!slot) return '<div class="g2-slot"></div>';
        if (slot.kind === 'camera') {
          const title = escapeHtml(slot.title || slot.entityId || 'Camera');
          return `<div class="g2-slot camera">${slot.frameId
            ? `<img class="g2-camera-frame" src="/integrations/assistant-engine/api/glasses/display/frame?id=${encodeURIComponent(slot.frameId)}&r=${encodeURIComponent(slot.imageRevision || 0)}" alt="${title}" title="${title}" />`
            : ''}</div>`;
        }
        return `<div class="g2-slot"><small>${escapeHtml(slot.title || '')}</small><strong>${escapeHtml(slot.value || '')}</strong></div>`;
      })
      .join('')}</div>`;
    screen.innerHTML = `<div class="g2-confirmed-view">${status}${body}${indicatorDot}</div>`;
  } else {
    body = `<div class="g2-full-display">${escapeHtml(display.body || ' ')}</div>`;
    screen.innerHTML = `<div class="g2-confirmed-view">${status}${body}${indicatorDot}</div>`;
  }
  const last = state.lastSeen ? ago(state.lastSeen) : 'at an unknown time';
  $('#hudNote').textContent = connection === 'live'
    ? `Bridge-confirmed ${last} · ${display.mode}${display.mode === 'grid' ? ` · HUD revision ${display.hudRevision}` : ''}.`
    : connection === 'inactive'
      ? `Carvis is not foregrounded — last confirmed ${last}. This frozen view is not the assigned HUD.`
      : `G2 reporting is stale — last confirmed ${last}. This frozen view is not the assigned HUD.`;

  if (dot) dot.className = `dot ${connection === 'live' ? 'ok' : connection === 'inactive' ? 'pending' : 'bad'}`;
  if (text) {
    text.textContent =
      connection === 'live' ? 'Glasses connected' : connection === 'inactive' ? 'Glasses backgrounded' : `Glasses stale · ${last}`;
  }
  if (line) {
    line.title =
      connection === 'live'
        ? `Bridge-confirmed ${last}.`
        : connection === 'inactive'
          ? `The G2 app is not foregrounded. Last confirmed ${last}.`
          : `No report from the G2 in over ${Math.round((state.staleAfterMs || 35_000) / 1000)}s. Last confirmed ${last}.`;
  }
}

function renderClassifier() {
  const c = S.classifier;
  if (!c) return;
  const s = c.stats;
  $('#classifierMeta').textContent = c.enabled ? `${s.woke} wake${s.woke === 1 ? '' : 's'}` : 'off';

  if (!c.enabled) {
    $('#classifierPanel').textContent =
      'Carvis only responds when spoken to. Raise proactivity in Settings to let it notice things on its own.';
    return;
  }
  // The ratio is the point: the cheap layers should absorb nearly everything.
  const free = s.seen ? Math.round((s.level0Dropped / s.seen) * 100) : 0;
  $('#classifierPanel').textContent =
    `${s.seen} events seen. ${free}% settled for free, ${s.classified} needed the cheap model, ${s.woke} were worth waking Carvis.` +
    (c.lastDecision ? ` Last call: ${c.lastDecision.reason}` : '');
}

/**
 * Everything currently pending. This used to list watches and scheduled
 * wakeups; protocols, timers and alarms are what defer work now, so it reads
 * from the same state the Protocols tab does rather than a parallel store.
 */
function renderWatches() {
  const state = S.automations;
  const panel = $('#watchPanel');
  if (!panel || !state) return;

  const rows = [
    ...(state.rules?.items || [])
      .filter((rule) => rule.enabled)
      .slice(0, 10)
      .map(
        (rule) =>
          `<div class="log-row think"><time>protocol</time><span class="msg">${escapeHtml(rule.name || rule.id)}${rule.lastOutcome ? ` <small class="muted">— last ${escapeHtml(rule.lastOutcome)}</small>` : ''}</span></div>`,
      ),
    ...(state.timers || [])
      .slice(0, 10)
      .map(
        (timer) =>
          `<div class="log-row think"><time>in ${fmtGap(Math.max(0, Math.ceil(timer.remainingMs / 1000)))}</time><span class="msg">${escapeHtml(timer.name || timer.id)}</span></div>`,
      ),
    ...(state.alarms || [])
      .slice(0, 10)
      .map(
        (alarm) =>
          `<div class="log-row think"><time>alarm</time><span class="msg">${escapeHtml(alarm.name || alarm.id)} <small class="muted">— due ${escapeHtml(String(alarm.dueAtIso || ''))}</small></span></div>`,
      ),
  ];

  $('#watchMeta').textContent = rows.length ? `${rows.length}` : '';
  panel.innerHTML = rows.length
    ? rows.join('')
    : '<p class="empty">Nothing pending. Ask Carvis to tell you when something happens, and it saves a protocol.</p>';
}

function fmtGap(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function renderCost() {
  const c = S.cost;
  if (!c) return;
  const usd = (n) => `$${(n || 0).toFixed(n >= 1 ? 2 : 4)}`;
  $('#costMeta').textContent = `${c.invocations} calls`;

  // Local roles cost nothing and would otherwise show as a confusing $0.0000
  // row; naming them as free is the more useful statement.
  const paid = (c.byRole || []).filter((r) => (r.cost || 0) > 0);
  const free = (c.byRole || []).filter((r) => (r.cost || 0) === 0);

  $('#costPanel').innerHTML =
    `<div class="field-grid" style="grid-template-columns:1fr auto;gap:4px 12px">
       <span class="muted">Today</span><strong>${usd(c.today)}</strong>
       <span class="muted">Last 30 days</span><span>${usd(c.month)}</span>
     </div>` +
    (paid.length
      ? `<div class="pad">${paid
          .map((r) => `<div class="log-row think"><time>${escapeHtml(r.role)}</time><span class="msg">${escapeHtml(r.model)} <small class="muted">— ${r.calls} calls, ${usd(r.cost)}</small></span></div>`)
          .join('')}</div>`
      : '') +
    (free.length
      ? `<p class="muted pad">Free (local): ${free.map((r) => escapeHtml(r.role)).join(', ')} — ${free.reduce((n, r) => n + r.calls, 0)} calls.</p>`
      : '');
}

/* ── shared save ───────────────────────────────────────────── */

async function saveConfig(patch) {
  const r = await api('/integrations/assistant-engine/api/config', { method: 'POST', body: JSON.stringify(patch) });
  S.config = r.config;
  S.observed = new Set(r.config.entities.observed);
  S.controlled = new Set(r.config.entities.controlled);
  fillSettingsForm();
  renderStatus();
  renderTools();
  scheduleAutomationCatalogRefresh(0);
  return r;
}

wireAuth();
boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<pre style="color:#ff9b93;padding:20px">Failed to start UI: ${escapeHtml(err.message)}</pre>`,
  );
});
