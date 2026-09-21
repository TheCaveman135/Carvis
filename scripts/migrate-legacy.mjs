import { mkdirSync, readFileSync, readdirSync, existsSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../server/store.js';

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function within(child, parent) { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); }
function privateError(message) { return Object.assign(new Error(message), { migrationSafe: true }); }

/** Parse values as data; never interpolate variables or execute shell syntax. */
export function parseEnvironment(contents) {
  const result = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || ['__proto__', 'constructor', 'prototype'].includes(match[1])) throw privateError('An environment entry could not be parsed. No migration was committed.');
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}
function readJSON(path, required = false) {
  if (!existsSync(path)) {
    if (required) throw privateError('The source configuration is missing.');
    return null;
  }
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw privateError('A source JSON file is unreadable or invalid. No migration was committed.'); }
}
function resolvedDestination(path) {
  const absolute = resolve(path);
  let ancestor = absolute;
  const suffix = [];
  while (!existsSync(ancestor)) { suffix.unshift(ancestor.slice(dirname(ancestor).length + (dirname(ancestor) === sep ? 0 : 1))); ancestor = dirname(ancestor); }
  return join(realpathSync(ancestor), ...suffix);
}
export function projectPrimaryModel(config, environment) {
  const role = config.models?.roles?.carvis;
  const provider = config.models?.providers?.find(item => item.id === role?.provider);
  if (!role?.model || !provider) return null;
  const apiKey = (provider.apiKeyEnv && environment[provider.apiKeyEnv]) || provider.apiKey || '';
  if (provider.kind === 'ollama') return { provider: 'ollama', model: role.model, baseUrl: `${String(provider.baseUrl || config.ollama?.url || '').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`, apiKey };
  if (provider.kind !== 'openai') return null;
  let official = false;
  try { official = new URL(provider.baseUrl).hostname === 'api.openai.com'; } catch {}
  return { provider: official && provider.api !== 'chat' ? 'openai' : 'compatible', model: role.model, baseUrl: provider.baseUrl, apiKey };
}
export function normalizeProviderCredentials(original, originalEnvironment) {
  const config = structuredClone(original), environment = { ...originalEnvironment };
  let credentialBindings = 0;
  for (const [index, provider] of (config.models?.providers || []).entries()) {
    for (const property of ['apiKey', 'token']) {
      if (!Object.hasOwn(provider, property)) continue;
      const value = provider[property];
      if (value !== null && value !== undefined && typeof value !== 'string')
        throw privateError('A model provider credential has an unsupported format. No migration was committed.');
      delete provider[property];
      if (!value?.trim()) continue;
      const name = String(provider.id || index).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0,80);
      const base = `CARVIS_PROVIDER_${name}_${property === 'token' ? 'TOKEN' : 'KEY'}`;
      let key = base, suffix = 2;
      while (environment[key] && environment[key] !== value) key = `${base}_${suffix++}`;
      environment[key] = value;
      // Existing environment bindings take precedence in the former model
      // resolver too. Keep that behavior while retaining unused inline values.
      if (!provider.apiKeyEnv || !environment[provider.apiKeyEnv]) provider.apiKeyEnv = key;
      credentialBindings++;
    }
  }
  return { config, environment, credentialBindings };
}
/** A deliberately small literal parser: source code is never evaluated. */
function staticStrings(value) {
  const text = value.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const result = [], body = text.slice(1, -1);
  let index = 0;
  const skip = () => { while (/\s/.test(body[index] || '') && index < body.length) index++; };
  while (index < body.length) {
    skip(); if (index === body.length) break;
    const quote = body[index++];
    if (quote !== "'" && quote !== '"') return null;
    let part = '', closed = false;
    while (index < body.length) {
      const character = body[index++];
      if (character === quote) { closed = true; break; }
      if (character !== '\\') { part += character; continue; }
      const escape = body[index++];
      const simple = { n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', "'":"'", '"':'"', '\\':'\\' };
      if (Object.hasOwn(simple, escape)) part += simple[escape];
      else if (escape === 'u' || escape === 'x') {
        const length = escape === 'u' ? 4 : 2, digits = body.slice(index, index + length);
        if (digits.length !== length || !/^[a-f0-9]+$/i.test(digits)) return null;
        part += String.fromCharCode(parseInt(digits, 16)); index += length;
      } else return null;
    }
    if (!closed) return null;
    result.push(part); skip();
    if (index < body.length && body[index++] !== ',') return null;
  }
  return result;
}
export function recoverCodeDefaults(original, files = {}) {
  const config = structuredClone(original);
  let recoveredDefaults = 0, unmappedDefaults = 0;
  // The former installation kept some settings in source rather than config.json.
  // Recover only recognisable literals, leaving all resource selections unchanged.
  if (files.stt && !Array.isArray(config.stt?.keyterms)) {
    const match = /function\s+deepgramUrl\s*\(\s*model\s*,\s*keyterms\s*=\s*(\[[^\n]*?\])\s*\)/.exec(files.stt);
    const values = match && staticStrings(match[1]);
    if (values) { (config.stt ??= {}).keyterms = values; recoveredDefaults++; }
    else unmappedDefaults++;
  }
  if (files.liveVoice) {
    const endpoint = /this\.fetch\(\s*['"](https?:\/\/[^'"\s]+\/live\/sessions)['"]/.exec(files.liveVoice)?.[1];
    const model = /session\s*:\s*\{\s*model\s*:\s*['"]([^'"\r\n]+)['"]/.exec(files.liveVoice)?.[1];
    const voice = /\bvoice\s*:\s*['"]([^'"\r\n]+)['"]/.exec(files.liveVoice)?.[1];
    config.liveVoice ??= {};
    for (const [key, value] of Object.entries({ baseUrl:endpoint?.replace(/\/live\/sessions$/, ''), model, voice })) {
      if (config.liveVoice[key]) continue;
      if (value) { config.liveVoice[key] = value; recoveredDefaults++; }
      else if (key !== 'voice') unmappedDefaults++;
    }
  }
  if (files.appleTv) {
    const literal = /APPLE_TV_ENTITIES\s*=\s*new\s+Set\s*\(\s*(\[[^\n]*?\])\s*\)/.exec(files.appleTv)?.[1];
    const entities = literal && staticStrings(literal);
    const selected = [...(config.entities?.observed || []), ...(config.entities?.controlled || [])];
    const mediaPlayer = entities?.find(id => id.startsWith('media_player.') && selected.includes(id));
    const remoteEntity = entities?.find(id => id.startsWith('remote.'));
    const addonSlug = /endpoint\s*:\s*['"]\/addons\/([a-zA-Z0-9_-]+)\/info['"]/.exec(files.appleTv)?.[1];
    if (mediaPlayer || config.appleTv?.mediaPlayer || config.appleTv?.remoteEntity) {
      config.appleTv ??= {};
      for (const [key, value] of Object.entries({ mediaPlayer, remoteEntity, addonSlug })) {
        if (config.appleTv[key]) continue;
        if (value) { config.appleTv[key] = value; recoveredDefaults++; }
        else unmappedDefaults++;
      }
    } else if (!entities) unmappedDefaults++;
  }
  return { config, recoveredDefaults, unmappedDefaults };
}
function importConversation(store, value) {
  const messages = (Array.isArray(value?.history) ? value.history : [])
    .filter(message => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .slice(-32)
    .map(message => ({ id: randomUUID(), role: message.role, content: message.content, createdAt: Number.isFinite(message.at) ? message.at : Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(), imported: true }));
  if (!messages.length) return null;
  const conversation = {
    id: randomUUID(), title: 'Imported conversation', createdAt: messages[0].createdAt,
    updatedAt: messages.at(-1).createdAt, messages,
  };
  store.data.conversations.push(conversation);
  return conversation;
}
async function copyDatabase(source, destination) {
  if (!existsSync(source)) return { tables: {}, memories: [] };
  try {
    // Isolate SQLite's native backup lifecycle from any open databases in the
    // caller, including repeated migration/test runs. No shell is involved.
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync, backup } from 'node:sqlite';
      const source = new DatabaseSync(process.argv[1], { readOnly:true });
      try {
        if (Object.values(source.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw Error('Integrity check failed');
        await backup(source, process.argv[2]);
      } finally { source.close(); }
    `, source, destination], { timeout:30000, maxBuffer:1024 * 1024 });
  } catch { throw privateError('The source database could not be copied consistently. No migration was committed.'); }
  chmodSync(destination, 0o600);
  const db = new DatabaseSync(destination, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    const tables = Object.fromEntries(names.map(name => [name, db.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count]));
    const memories = names.includes('memories') ? db.prepare('SELECT id, text, kind, source, ts, updated_at FROM memories ORDER BY updated_at').all() : [];
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (Object.values(integrity)[0] !== 'ok') throw privateError('The copied database did not pass its integrity check. No migration was committed.');
    return { tables, memories };
  } finally { db.close(); }
}

/** Offline migration only. It never launches a runtime or contacts a service. */
export async function migrateLegacy({ source, data, publicUrl, importCoreMemory = false, projectIntegrations } = {}) {
  if (!source || !data) throw privateError('Provide both --source and --data paths explicitly.');
  let sourcePath;
  try { sourcePath = realpathSync(resolve(source)); } catch { throw privateError('The source directory is unavailable.'); }
  if (!statSync(sourcePath).isDirectory()) throw privateError('The source must be a directory.');
  const target = resolvedDestination(data);
  if (within(target, sourcePath) || within(sourcePath, target) || within(target, realpathSync(PUBLIC_ROOT))) throw privateError('Choose a separate private data directory outside both source repositories.');
  if (/(?:^|\/)Library\/(?:Mobile Documents|CloudStorage)(?:\/|$)/i.test(target)) throw privateError('Choose a data directory outside cloud-synced storage.');
  if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length)) throw privateError('The destination is not empty. Existing installation data will not be overwritten.');
  const originalConfig = readJSON(join(sourcePath, 'config.json'), true);
  if (!object(originalConfig)) throw privateError('The source configuration must be an object.');
  const codeFiles = Object.fromEntries(Object.entries({ stt:'stt.js', liveVoice:'live-voice.js', appleTv:'apple-tv.js' }).map(([key, name]) => {
    const file = join(sourcePath, 'server', name);
    return [key, existsSync(file) ? readFileSync(file, 'utf8') : ''];
  }));
  const recovered = recoverCodeDefaults(originalConfig, codeFiles);
  const originalEnvironment = existsSync(join(sourcePath, '.env')) ? parseEnvironment(readFileSync(join(sourcePath, '.env'), 'utf8')) : {};
  const { config, environment, credentialBindings } = normalizeProviderCredentials(recovered.config, originalEnvironment);
  const { recoveredDefaults, unmappedDefaults } = recovered;
  const conversationData = readJSON(join(sourcePath, 'conversation.json'));
  readJSON(join(sourcePath, 'patterns.json'));
  const project = projectIntegrations || (await import('../server/assistant-config.js')).integrationConfigFromLegacy;
  if (typeof project !== 'function') throw privateError('The integration configuration projector is unavailable.');
  const integrations = await project(config, environment);
  if (!object(integrations)) throw privateError('The integration configuration projector returned invalid settings.');
  if (publicUrl) {
    let url; try { url = new URL(publicUrl); } catch { throw privateError('The public URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw privateError('Use a public URL without embedded credentials or query parameters.');
    if (integrations['even-realities']) integrations['even-realities'].config.publicBaseUrl = url.toString().replace(/\/+$/, '');
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = join(dirname(target), `.carvis-migration-${randomUUID()}`);
  try {
    const store = new Store(staging);
    const runtime = join(staging, 'assistant-runtime');
    mkdirSync(runtime, { mode: 0o700 });
    const database = await copyDatabase(join(sourcePath, 'carvis.db'), join(runtime, 'carvis.db'));
    const copied = [];
    for (const name of ['conversation.json', 'patterns.json']) {
      const path = join(sourcePath, name);
      if (!existsSync(path)) continue;
      writeFileSync(join(runtime, name), readFileSync(path), { mode: 0o600, flag: 'wx' });
      copied.push(name);
    }
    store.config.auth = structuredClone(config.auth || {});
    store.config.profile = {
      displayName: config.profile?.displayName || '',
      assistantName: config.profile?.assistantName || config.carvis?.name || 'Carvis',
      personality: config.carvis?.personality ?? config.profile?.personality ?? store.config.profile.personality,
    };
    const model = projectPrimaryModel(config, environment);
    if (model) store.config.model = model;
    store.config.integrations = structuredClone(integrations);
    const imported = importConversation(store, conversationData);
    if (importCoreMemory) {
      const texts = new Set(store.data.memory.map(memory => memory.text));
      for (const memory of database.memories) {
        if (typeof memory.text !== 'string' || !memory.text.trim() || texts.has(memory.text)) continue;
        texts.add(memory.text);
        store.data.memory.push({ id: randomUUID(), text: memory.text, createdAt: memory.ts, updatedAt: memory.updated_at, legacyId: memory.id, kind: memory.kind, source: memory.source, imported: true });
      }
    }
    const engine = store.plugin('assistant-engine');
    engine.set('originalLegacyConfig', originalConfig);
    engine.set('originalEnvironment', originalEnvironment);
    engine.set('legacyConfig', config);
    engine.set('environment', environment);
    if (imported) engine.set('primaryConversationId', imported.id);
    const report = {
      version: 1, migratedAt: Date.now(), stateFiles: copied.length + Number(existsSync(join(runtime, 'carvis.db'))),
      databaseTables: Object.keys(database.tables).length,
      databaseRows: Object.values(database.tables).reduce((sum, count) => sum + Number(count), 0),
      learnedMemoriesPreserved: database.memories.length, coreMemoriesImported: store.data.memory.length,
      conversationMessagesImported: imported?.messages.length || 0,
      integrationSettings: Object.keys(integrations).length, environmentEntries: Object.keys(environment).length,
      recoveredDefaults, unmappedDefaults, credentialBindings,
      coreModelImported: Boolean(model), runtimeStarted: false,
    };
    engine.set('migration', { ...report, tableCounts: database.tables, coreMemoryImportRequested: importCoreMemory });
    store.saveConfig(); store.saveData();
    if (existsSync(target)) rmdirSync(target);
    renameSync(staging, target);
    return report;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error.migrationSafe) throw error;
    throw privateError('Migration could not finish. No destination installation was committed; the source was not changed.');
  }
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--source' || arg === '--data' || arg === '--public-url') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw privateError('Provide a path after each migration option.');
      options[arg === '--public-url' ? 'publicUrl' : arg.slice(2)] = argv[++index];
    } else if (arg === '--import-core-memory') options.importCoreMemory = true;
    else throw privateError('Usage: node scripts/migrate-legacy.mjs --source <existing-installation> --data <private-new-directory> [--public-url <url>] [--import-core-memory]');
  }
  console.log(JSON.stringify(await migrateLegacy(options), null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.migrationSafe ? error.message : 'Migration failed before committing installation data.');
    process.exitCode = 1;
  });
}
