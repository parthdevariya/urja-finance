'use strict';
/*
 * Optional Supabase (PostgreSQL) storage for Credit Control Desk.
 *
 * The app keeps working from its in-memory document store (and the local
 * store.json copy). When Supabase is switched on, every change is also saved
 * to one Supabase table, and on start-up the data is loaded back from it, so
 * nothing is lost when the server's disk is wiped (for example on a Render
 * redeploy). Settings (config.json) and the session key are kept in the same
 * table under reserved rows that the browser can never read.
 */
const fs = require('fs');

const DEFAULT_TABLE = 'ccd_documents';
const ROW_CONFIG = '__config';
const ROW_SESSION = '__session';
const BATCH_BYTES = 1500000;

const SETUP_SQL = table => `-- Credit Control Desk: one table for all app data
create table if not exists public.${table} (
  path        text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- keep it private: with row level security on and no policies,
-- only the server's secret (service_role) key can read or write it
alter table public.${table} enable row level security;`;

function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
const normUrl = u => String(u || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const tableOk = t => /^[a-z_][a-z0-9_]{0,62}$/.test(t);

function client({ url, key, table }) {
  const base = `${normUrl(url)}/rest/v1/${table}`;
  const headers = extra => ({
    apikey: key,
    ...(String(key).startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
    'Content-Type': 'application/json',
    ...extra
  });
  async function call(method, qs, { body, prefer, timeout = 30000 } = {}) {
    let r;
    try {
      r = await fetch(base + (qs ? '?' + qs : ''), { method, headers: headers(prefer ? { Prefer: prefer } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw httpErr(502, `Could not reach Supabase at ${normUrl(url)}. Check the project URL and the server's internet access.`);
    }
    if (r.ok) return r;
    let j = {}; try { j = await r.json(); } catch (_) {}
    const msg = j.message || j.error || j.hint || r.statusText;
    if (r.status === 401 || r.status === 403 || /jwt|api key|apikey|permission denied/i.test(msg)) throw httpErr(401, 'Supabase did not accept the key. Use the secret (service_role) key from Project Settings → API keys, not the anon or publishable key.');
    if (j.code === 'PGRST205' || j.code === '42P01' || /does not exist|could not find the table/i.test(msg)) throw httpErr(404, `The table "${table}" does not exist in Supabase yet. Run the setup SQL in the Supabase SQL Editor, then test again.`);
    throw httpErr(502, 'Supabase error: ' + msg);
  }
  return {
    async count() {
      const r = await call('GET', 'select=path&limit=1&path=' + encodeURIComponent(`not.in.("${ROW_CONFIG}","${ROW_SESSION}")`), { prefer: 'count=exact' });
      const cr = r.headers.get('content-range') || ''; const n = +(cr.split('/')[1] || 0);
      return Number.isFinite(n) ? n : 0;
    },
    async all() {
      const out = [];
      for (let off = 0; ; off += 500) {
        const r = await call('GET', `select=path,data,updated_at,updated_by&order=path.asc&offset=${off}&limit=500`, { timeout: 60000 });
        const rows = await r.json(); out.push(...rows);
        if (rows.length < 500) break;
      }
      return out;
    },
    async upsert(rows) {
      let batch = [], size = 0;
      const send = async () => { if (batch.length) await call('POST', 'on_conflict=path', { body: batch, prefer: 'resolution=merge-duplicates,return=minimal', timeout: 60000 }); batch = []; size = 0; };
      for (const row of rows) {
        const s = JSON.stringify(row).length;
        if (size + s > BATCH_BYTES && batch.length) await send();
        batch.push(row); size += s;
      }
      await send();
    },
    async remove(paths) {
      for (let i = 0; i < paths.length; i += 80) {
        const list = paths.slice(i, i + 80).map(p => `"${String(p).replace(/"/g, '')}"`).join(',');
        await call('DELETE', 'path=in.(' + encodeURIComponent(list) + ')', { prefer: 'return=minimal' });
      }
    }
  };
}

module.exports = function createStorage({ store, storeFile, configFile, readJson, writeJsonAtomic, getConfig, getSessionSecret, setSessionSecret }) {
  const st = { backend: 'local', connected: false, loaded: false, lastSyncAt: null, lastError: '', remoteDocs: null, pending: 0 };
  let synced = new Map();        // path -> store entry object last saved to Supabase
  let bootEntries = null;        // entries present before the first successful load
  let flushTimer = null, retryTimer = null, flushing = null, retryDelay = 15000;

  const envLocked = !!process.env.DB_BACKEND;
  function creds(override) {
    const c = getConfig(), o = override || {};
    const url = normUrl(o.supabaseUrl || c.supabaseUrl), key = String(o.supabaseKey || c.supabaseKey || '').trim();
    const table = String(o.supabaseTable || c.supabaseTable || DEFAULT_TABLE).trim().toLowerCase();
    return { url, key, table, wanted: String(process.env.DB_BACKEND || c.dbBackend || 'local').toLowerCase() === 'supabase' };
  }
  function check(c) {
    if (!/^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)/i.test(c.url)) throw httpErr(400, 'Enter the Supabase project URL, for example https://abcd1234.supabase.co');
    if (!c.key) throw httpErr(400, 'Enter the Supabase secret (service_role) key.');
    if (!tableOk(c.table)) throw httpErr(400, 'The table name can only use lowercase letters, numbers and underscores.');
    return c;
  }
  const entryRow = (path, e) => ({ path, data: e.data, updated_at: e.updatedAt || new Date().toISOString(), updated_by: e.by || '' });
  const configRow = () => { const f = readJson(configFile, {}); return { path: ROW_CONFIG, data: { ...f, savedAt: f.savedAt || new Date().toISOString() }, updated_at: new Date().toISOString(), updated_by: 'server' }; };
  const sessionRow = () => ({ path: ROW_SESSION, data: { secret: getSessionSecret() }, updated_at: new Date().toISOString(), updated_by: 'server' });
  function pendingCount() {
    let n = 0; for (const [k, e] of Object.entries(store)) if (synced.get(k) !== e) n++;
    for (const k of synced.keys()) if (!(k in store)) n++;
    return n;
  }
  const saveLocal = () => { try { writeJsonAtomic(storeFile, store); } catch (_) {} };

  /* replace the in-memory store with Supabase rows (same object, so other modules keep their reference) */
  function applyRemote(rows, keepLocalChanges) {
    const remote = new Map(), special = {};
    for (const r of rows) {
      if (r.path === ROW_CONFIG || r.path === ROW_SESSION) { special[r.path] = r.data; continue; }
      remote.set(r.path, { data: r.data, updatedAt: r.updated_at, by: r.updated_by || '' });
    }
    const local = new Set();
    if (keepLocalChanges && bootEntries) for (const [k, e] of Object.entries(store)) if (bootEntries[k] !== e) local.add(k);
    for (const k of Object.keys(store)) if (!local.has(k) && !remote.has(k)) delete store[k];
    synced = new Map();
    for (const [k, e] of remote) { if (local.has(k)) continue; store[k] = e; synced.set(k, e); }
    // settings: whichever copy was saved last wins
    if (special[ROW_CONFIG]) {
      const f = readJson(configFile, {}), r = special[ROW_CONFIG];
      if (!Object.keys(f).length || String(r.savedAt || '') > String(f.savedAt || '')) { writeJsonAtomic(configFile, r); try { fs.chmodSync(configFile, 0o600); } catch (_) {} }
    }
    if (special[ROW_SESSION] && special[ROW_SESSION].secret && !process.env.SESSION_SECRET) setSessionSecret(special[ROW_SESSION].secret);
    saveLocal();
    return { docs: remote.size, hadConfig: !!special[ROW_CONFIG], hadSession: !!special[ROW_SESSION] };
  }

  async function load(keepLocalChanges) {
    const c = check(creds()), db = client(c);
    const rows = await db.all();
    if (!rows.length) {
      // a brand-new, empty table: start it from this app's data instead of emptying the app
      synced = new Map(); bootEntries = null;
      st.loaded = true; st.connected = true;
      await db.upsert([configRow(), ...(process.env.SESSION_SECRET ? [] : [sessionRow()])]);
      schedule(100);
      st.lastSyncAt = new Date().toISOString(); st.lastError = ''; st.remoteDocs = 0;
      return { docs: 0, seeded: Object.keys(store).length };
    }
    const info = applyRemote(rows, keepLocalChanges);
    const extra = [];
    if (!info.hadConfig) extra.push(configRow());
    if (!info.hadSession && !process.env.SESSION_SECRET) extra.push(sessionRow());
    if (extra.length) await db.upsert(extra);
    st.loaded = true; st.connected = true; st.lastError = ''; st.lastSyncAt = new Date().toISOString(); st.remoteDocs = info.docs;
    bootEntries = null; retryDelay = 15000;
    schedule(200);
    return info;
  }

  async function init() {
    const c = creds();
    if (!c.wanted || !c.url || !c.key) { st.backend = 'local'; return; }
    st.backend = 'supabase'; bootEntries = { ...store };
    try { const i = await load(true); console.log(i.seeded != null ? `[db] Supabase connected: empty table "${c.table}" filled with ${i.seeded} documents from this server` : `[db] Supabase connected: ${i.docs} documents loaded from "${c.table}"`); }
    catch (e) { st.connected = false; st.lastError = e.message; console.warn('[db] Supabase not reachable at start-up — using the local copy and retrying:', e.message); retryLater(); }
  }
  function retryLater() { clearTimeout(retryTimer); retryTimer = setTimeout(async () => { if (st.backend !== 'supabase') return; try { if (!st.loaded) await load(true); else await flush(); } catch (e) { st.lastError = e.message; retryDelay = Math.min(retryDelay * 2, 300000); retryLater(); } }, retryDelay); }

  async function flushNow() {
    if (st.backend !== 'supabase' || !st.loaded) return;
    const c = check(creds()), db = client(c);
    const ups = [], sent = [], dels = [];
    for (const [k, e] of Object.entries(store)) if (synced.get(k) !== e) { ups.push(entryRow(k, e)); sent.push([k, e]); }
    for (const k of synced.keys()) if (!(k in store)) dels.push(k);
    if (!ups.length && !dels.length) { st.pending = 0; return; }
    try {
      if (ups.length) await db.upsert(ups);
      if (dels.length) await db.remove(dels);
      for (const [k, e] of sent) synced.set(k, e);
      for (const k of dels) if (!(k in store)) synced.delete(k);
      st.connected = true; st.lastError = ''; st.lastSyncAt = new Date().toISOString(); retryDelay = 15000;
    } catch (e) {
      st.connected = false; st.lastError = e.message; retryLater(); throw e;
    } finally { st.pending = pendingCount(); }
    if (pendingCount()) schedule(300);
  }
  function flush() { if (!flushing) flushing = flushNow().finally(() => { flushing = null; }); return flushing; }
  function schedule(ms = 800) { if (st.backend !== 'supabase' || !st.loaded) return; clearTimeout(flushTimer); flushTimer = setTimeout(() => flush().catch(() => {}), ms); }

  async function pushConfig() { if (st.backend !== 'supabase' || !st.loaded) return; try { await client(check(creds())).upsert([configRow()]); } catch (e) { st.lastError = e.message; } }

  async function test(override) {
    const c = check(creds(override)), db = client(c);
    st.remoteDocs = await db.count();
    return { table: c.table, remoteDocs: st.remoteDocs, localDocs: Object.keys(store).length };
  }

  function saveCreds(override, backend) {
    const f = readJson(configFile, {});
    if (!process.env.SUPABASE_URL && override.supabaseUrl) f.supabaseUrl = normUrl(override.supabaseUrl);
    if (!process.env.SUPABASE_SERVICE_KEY && override.supabaseKey) f.supabaseKey = String(override.supabaseKey).trim();
    if (!process.env.SUPABASE_TABLE && override.supabaseTable) f.supabaseTable = String(override.supabaseTable).trim().toLowerCase();
    f.dbBackend = backend; f.savedAt = new Date().toISOString();
    writeJsonAtomic(configFile, f); try { fs.chmodSync(configFile, 0o600); } catch (_) {}
  }

  /* mode "copy": this app's data replaces what is in Supabase. mode "remote": Supabase data replaces this app's data. */
  async function connect(mode, override) {
    if (envLocked && String(process.env.DB_BACKEND).toLowerCase() !== 'supabase') throw httpErr(400, 'The database is fixed to the local file by the DB_BACKEND environment variable on the server.');
    const c = check(creds(override)), db = client(c);
    await db.count();
    saveCreds(override, 'supabase');
    if (mode === 'remote') {
      try { writeJsonAtomic(storeFile.replace(/\.json$/, `.backup-${Date.now()}.json`), store); } catch (_) {}
      st.backend = 'supabase'; bootEntries = null;
      const i = await load(false);
      return { docs: i.docs };
    }
    const remote = await db.all();
    await db.upsert([...Object.entries(store).map(([k, e]) => entryRow(k, e)), configRow(), ...(process.env.SESSION_SECRET ? [] : [sessionRow()])]);
    const stale = remote.map(r => r.path).filter(p => p !== ROW_CONFIG && p !== ROW_SESSION && !(p in store));
    if (stale.length) await db.remove(stale);
    synced = new Map(Object.entries(store));
    st.backend = 'supabase'; st.loaded = true; st.connected = true; st.lastError = ''; st.lastSyncAt = new Date().toISOString(); st.remoteDocs = Object.keys(store).length; st.pending = 0;
    return { docs: Object.keys(store).length };
  }
  async function useLocal() {
    if (envLocked) throw httpErr(400, 'The database is set by the DB_BACKEND environment variable on the server, so it can only be changed there.');
    try { await flush(); } catch (_) {}
    const f = readJson(configFile, {}); f.dbBackend = 'local'; f.savedAt = new Date().toISOString(); writeJsonAtomic(configFile, f);
    st.backend = 'local'; st.loaded = false; st.connected = false; clearTimeout(flushTimer); clearTimeout(retryTimer);
    saveLocal();
    return { docs: Object.keys(store).length };
  }

  function status() {
    const c = creds();
    st.pending = st.backend === 'supabase' ? pendingCount() : 0;
    return {
      backend: st.backend, connected: st.connected, loaded: st.loaded, lastSyncAt: st.lastSyncAt, lastError: st.lastError,
      pending: st.pending, localDocs: Object.keys(store).length, remoteDocs: st.remoteDocs, table: c.table,
      locked: envLocked, envCreds: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
      onRender: !!process.env.RENDER, sql: SETUP_SQL(tableOk(c.table) ? c.table : DEFAULT_TABLE)
    };
  }

  /* backup / restore (data only, never passwords or keys) */
  function exportAll() { return { app: 'credit-control-desk', version: 1, exportedAt: new Date().toISOString(), docs: Object.entries(store).map(([path, e]) => ({ path, data: e.data })) }; }
  function importAll(docs, mode, by, checkPath) {
    if (!Array.isArray(docs)) throw httpErr(400, 'This is not a Credit Control Desk backup file.');
    const valid = docs.filter(d => d && typeof d.path === 'string' && checkPath(d.path, true) && d.data && typeof d.data === 'object' && !Array.isArray(d.data));
    if (mode === 'replace') for (const k of Object.keys(store)) delete store[k];
    const now = new Date().toISOString();
    for (const d of valid) store[d.path] = { data: d.data, updatedAt: now, by };
    return { restored: valid.length, skipped: docs.length - valid.length };
  }

  return { init, schedule, flush, pushConfig, test, connect, useLocal, status, exportAll, importAll, sql: SETUP_SQL };
};
