'use strict';
/*
 * Microsoft Dynamics 365 Business Central connector.
 * - Signs in with a Microsoft Entra app (OAuth 2.0 client credentials).
 * - Reads open customer ledger entries from the "Customer Ledger Entries" page
 *   published as an OData web service (it carries Due Date and Remaining Amount).
 * - Reads customer email / phone / city from the standard API v2.0 customers endpoint.
 * - Saves the result as a report, exactly like an uploaded file.
 */
const LOGIN = (process.env.BC_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const API = (process.env.BC_API_BASE || 'https://api.businesscentral.dynamics.com').replace(/\/+$/, '');
const SCOPE = process.env.BC_SCOPE || 'https://api.businesscentral.dynamics.com/.default';
const REPORT_TZ = process.env.REPORT_TZ || 'Asia/Kolkata';
const MAX_ROWS = 100000;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELDS = {
  d: ['postingdate'],
  cn: ['customerno', 'customernumber', 'custno'],
  c: ['customername', 'custname'],
  t: ['documenttype', 'doctype'],
  no: ['documentno', 'documentnumber', 'docno'],
  ex: ['externaldocumentno', 'externaldocumentnumber', 'extdocno'],
  du: ['duedate'],
  a: ['originalamount', 'originalamtlcy', 'amount', 'amountlcy'],
  r: ['remainingamount', 'remainingamtlcy', 'remainingamountlcy'],
  open: ['open']
};
function fieldMap(sample) {
  const keys = Object.keys(sample || {}), map = {};
  for (const [k, cands] of Object.entries(FIELDS)) {
    for (const c of cands) { const hit = keys.find(x => norm(x) === c); if (hit) { map[k] = hit; break; } }
  }
  return map;
}
const safeId = s => (String(s || '').replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').replace(/^\.+$/, '_').slice(0, 150)) || 'x';
const isoDate = v => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m && m[1] !== '0001' ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const round2 = n => Math.round((+n || 0) * 100) / 100;
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

module.exports = function createBC({ getConfig, store, persist }) {
  let tokenCache = null, running = false;

  function cfgOf() {
    const c = getConfig();
    return {
      tenant: (c.bcTenantId || '').trim(), env: (c.bcEnvironment || 'Production').trim(), company: (c.bcCompanyName || '').trim(),
      clientId: (c.bcClientId || '').trim(), secret: c.bcClientSecret || '', service: (c.bcLedgerService || 'CustomerLedgerEntries').trim(),
      filter: (c.bcFilter || '').trim(), syncCustomers: String(c.bcSyncCustomers ?? 'true') !== 'false', autoHours: +c.bcAutoSyncHours || 0
    };
  }
  const ready = c => !!(c.tenant && c.clientId && c.secret && c.company);

  async function token(c) {
    const key = c.tenant + '|' + c.clientId;
    if (tokenCache && tokenCache.key === key && tokenCache.exp > Date.now() + 60e3) return tokenCache.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.secret, scope: SCOPE });
    const r = await fetch(`${LOGIN}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw httpErr(502, 'Microsoft sign-in failed: ' + ((j.error_description || j.error || r.status) + '').split('\r\n')[0].replace(/\.+$/, '') + '. Check the tenant ID, client ID and client secret.');
    tokenCache = { key, token: j.access_token, exp: Date.now() + (+j.expires_in || 3600) * 1000 };
    return j.access_token;
  }
  async function get(c, url) {
    const t = await token(c);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = (j.error && (j.error.message || j.error.code)) || r.status;
      if (r.status === 401 || r.status === 403) throw httpErr(502, `Business Central refused access (${m}). Add the app in Business Central's "Microsoft Entra Applications" page and give it read permissions.`);
      if (r.status === 404) throw httpErr(502, `Not found in Business Central (${m}). Check the environment name, company name and web service name.`);
      throw httpErr(502, 'Business Central error: ' + m);
    }
    return j;
  }
  async function getAll(c, url) {
    const out = []; let next = url;
    while (next && out.length < MAX_ROWS) { const j = await get(c, next); out.push(...(j.value || [])); next = j['@odata.nextLink'] || null; }
    return out;
  }
  const base = c => `${API}/v2.0/${encodeURIComponent(c.tenant)}/${encodeURIComponent(c.env)}`;
  const odataCompany = name => `Company('${encodeURIComponent(name.replace(/'/g, "''"))}')`;
  function ledgerUrl(c, top) {
    const filters = ['Open eq true']; if (c.filter) filters.push(`(${c.filter})`);
    const q = [`$filter=${encodeURIComponent(filters.join(' and '))}`]; if (top) q.push('$top=' + top);
    return `${base(c)}/ODataV4/${odataCompany(c.company)}/${encodeURIComponent(c.service)}?${q.join('&')}`;
  }
  async function findCompany(c) {
    const list = (await get(c, `${base(c)}/api/v2.0/companies`)).value || [];
    const want = norm(c.company);
    const hit = list.find(x => norm(x.name) === want) || list.find(x => norm(x.displayName) === want) || (list.length === 1 ? list[0] : null);
    return { list, hit };
  }

  async function test() {
    const c = cfgOf();
    if (!ready(c)) throw httpErr(400, 'Fill in the tenant ID, company name, client ID and client secret first.');
    await token(c);
    const { list, hit } = await findCompany(c);
    if (!hit) throw httpErr(400, `Company "${c.company}" was not found. Companies in this environment: ${list.map(x => x.name).join(', ') || 'none'}.`);
    const sample = await get(c, ledgerUrl({ ...c, company: hit.name }, 1));
    const rec = (sample.value || [])[0];
    const map = rec ? fieldMap(rec) : {};
    const missing = rec ? ['cn', 'du', 'r'].filter(k => !map[k]) : [];
    return {
      ok: true, company: hit.displayName || hit.name, companies: list.map(x => x.name),
      ledger: rec ? 'Open customer ledger entries are readable.' : 'Connected, but no open ledger entries were returned for this filter.',
      fields: rec ? Object.keys(rec).filter(k => !k.startsWith('@')).slice(0, 40) : [],
      missing: missing.map(k => ({ cn: 'Customer No.', du: 'Due Date', r: 'Remaining Amount' })[k])
    };
  }

  function writeStatus(s) { store['settings/bcsync'] = { data: { ...s }, updatedAt: new Date().toISOString(), by: 'bc-sync' }; persist(); }
  function logUpload(e) {
    const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    store['uploads/' + id] = { data: { id, at: new Date().toISOString(), ...e }, updatedAt: new Date().toISOString(), by: 'bc-sync' }; persist();
  }

  async function sync(trigger = 'manual') {
    if (running) throw httpErr(409, 'A Business Central sync is already running. Try again in a minute.');
    const c = cfgOf();
    if (!ready(c)) throw httpErr(400, 'Business Central is not set up. Add the connection details in Settings → Business Central.');
    running = true; const t0 = Date.now();
    try {
      const { list, hit } = await findCompany(c);
      if (!hit) throw httpErr(400, `Company "${c.company}" was not found. Companies in this environment: ${list.map(x => x.name).join(', ') || 'none'}.`);
      const entries = await getAll(c, ledgerUrl({ ...c, company: hit.name }));
      let customers = [];
      if (c.syncCustomers) {
        try { customers = await getAll(c, `${base(c)}/api/v2.0/companies(${hit.id})/customers?$select=number,displayName,phoneNumber,email,city`); }
        catch (e) { customers = []; }
      }
      const custMap = new Map(customers.map(x => [String(x.number), x]));
      const map = entries.length ? fieldMap(entries[0]) : {};
      if (entries.length && (!map.cn || !map.r)) throw httpErr(400, 'The ledger web service does not include Customer No. and Remaining Amount. Publish page 25 "Customer Ledger Entries" as the web service.');
      const rows = [];
      for (const e of entries) {
        if (map.open && e[map.open] === false) continue;
        const cn = String(e[map.cn] || '').trim(); if (!cn) continue;
        const cu = custMap.get(cn) || {};
        const d = isoDate(e[map.d]), du = isoDate(map.du ? e[map.du] : '') || d;
        const r = round2(e[map.r]); if (!du || !r) continue;
        const a = map.a ? round2(e[map.a]) : r;
        rows.push({ d, cn, c: String((map.c && e[map.c]) || cu.displayName || cn).trim(), ci: String(cu.city || '').trim(), ct: '', ph: String(cu.phoneNumber || '').trim(),
          t: String((map.t && e[map.t]) || (r < 0 ? 'Payment' : 'Invoice')).replace(/_/g, ' ').trim(), no: String((map.no && e[map.no]) || '').trim(), ex: String((map.ex && e[map.ex]) || '').trim(), du, a, r });
      }
      const asOf = todayLocal(), cs = new Set(); let debit = 0, credit = 0;
      rows.forEach(r => { cs.add(r.cn); if (r.r > 0) debit += r.r; else credit += r.r; });
      const stats = { customers: cs.size, debit: round2(debit), credit: round2(credit), net: round2(debit + credit) };
      const id = 'r' + Date.now().toString(36), CH = 600, n = Math.max(1, Math.ceil(rows.length / CH)), now = new Date().toISOString();
      for (let i = 0; i < n; i++) store[`reports/${id}/rows/c${i}`] = { data: { i, rows: rows.slice(i * CH, (i + 1) * CH) }, updatedAt: now, by: 'bc-sync' };
      const meta = { company: hit.displayName || hit.name, file: 'Business Central sync', format: 'Business Central (live API)', asOf, uploadedAt: now, rowCount: rows.length, source: 'bc', size: 0, ...stats, chunks: n, ready: true };
      store[`reports/${id}`] = { data: meta, updatedAt: now, by: 'bc-sync' };
      for (const cu of customers) {
        if (!cu.number) continue;
        store['bccustomers/' + safeId(cu.number)] = { data: { cn: String(cu.number), name: cu.displayName || '', email: cu.email || '', phone: cu.phoneNumber || '', city: cu.city || '', syncedAt: now }, updatedAt: now, by: 'bc-sync' };
      }
      logUpload({ status: 'imported', file: 'Business Central sync', format: 'Business Central (live API)', asOf, rows: rows.length, ...stats, reportId: id, note: trigger === 'scheduled' ? 'Automatic sync' : 'Synced on request' });
      const res = { ok: true, lastAt: now, trigger, entries: rows.length, customers: customers.length, reportId: id, company: meta.company, durationMs: Date.now() - t0 };
      writeStatus(res);
      return res;
    } catch (e) {
      const msg = e.message || 'Business Central sync failed.';
      logUpload({ status: 'failed', file: 'Business Central sync', format: 'Business Central (live API)', error: msg, note: trigger === 'scheduled' ? 'Automatic sync' : 'Synced on request' });
      writeStatus({ ok: false, lastAt: new Date().toISOString(), trigger, error: msg });
      throw e;
    } finally { running = false; }
  }

  function status() {
    const c = cfgOf(), s = (store['settings/bcsync'] && store['settings/bcsync'].data) || null;
    let next = null;
    if (c.autoHours > 0 && ready(c)) next = new Date((s && s.lastAt ? new Date(s.lastAt).getTime() : Date.now()) + c.autoHours * 3600e3).toISOString();
    return { configured: ready(c), running, autoHours: c.autoHours, last: s, next };
  }

  function startScheduler() {
    setInterval(() => {
      const c = cfgOf(); if (!(c.autoHours > 0) || !ready(c) || running) return;
      const s = store['settings/bcsync'] && store['settings/bcsync'].data;
      const last = s && s.lastAt ? new Date(s.lastAt).getTime() : 0;
      if (Date.now() - last >= c.autoHours * 3600e3) sync('scheduled').catch(e => console.warn('[bc] scheduled sync failed:', e.message));
    }, 5 * 60e3).unref();
  }

  return { test, sync, status, startScheduler };
};
