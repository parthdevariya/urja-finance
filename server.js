'use strict';
/*
 * Credit Control Desk — self-hosted server
 * Serves the dashboard, stores data on disk, and sends reminders through
 * SMTP email, the WhatsApp Business (Meta Cloud) API and OmniDim voice AI,
 * and pulls customer ledger data from Microsoft Dynamics 365 Business Central.
 */
const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try { require('dotenv').config(); } catch (_) { /* optional */ }

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@123';
const SESSION_HOURS = +process.env.SESSION_HOURS || 12;
const WA_GRAPH_BASE = (process.env.WA_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');
const OMNIDIM_BASE = (process.env.OMNIDIM_BASE || 'https://omnidim.io/api/v1').replace(/\/+$/, '');

fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.log');

if (!process.env.ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD is not set — using the default password. Set it in .env before going live.');

/* ---------- small helpers ---------- */
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function writeJsonAtomic(file, obj) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); }
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
function outbox(entry) { try { fs.appendFileSync(OUTBOX_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch (_) {} }

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, 'utf8').trim() : '';
  if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 }); }
}

/* ---------- document store (same shape the dashboard uses) ---------- */
let store = readJson(STORE_FILE, {});
let saveTimer = null;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeJsonAtomic(STORE_FILE, store), 150); }
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function checkPath(p, even) {
  if (typeof p !== 'string' || p.length > 1000) return false;
  const parts = p.split('/');
  if (parts.length > 16 || parts.some(x => !SEG.test(x) || x === '.' || x === '..')) return false;
  return even ? parts.length % 2 === 0 : parts.length % 2 === 1;
}

/* ---------- provider configuration ---------- */
const ENV_MAP = {
  smtpHost: 'SMTP_HOST', smtpPort: 'SMTP_PORT', smtpSecure: 'SMTP_SECURE', smtpUser: 'SMTP_USER', smtpPass: 'SMTP_PASS',
  waPhoneNumberId: 'WA_PHONE_NUMBER_ID', waApiVersion: 'WA_API_VERSION', waToken: 'WA_TOKEN',
  omniApiKey: 'OMNIDIM_API_KEY',
  bcTenantId: 'BC_TENANT_ID', bcEnvironment: 'BC_ENVIRONMENT', bcCompanyName: 'BC_COMPANY', bcClientId: 'BC_CLIENT_ID', bcClientSecret: 'BC_CLIENT_SECRET',
  bcLedgerService: 'BC_LEDGER_SERVICE', bcFilter: 'BC_FILTER', bcSyncCustomers: 'BC_SYNC_CUSTOMERS', bcAutoSyncHours: 'BC_AUTO_SYNC_HOURS'
};
const SECRET_KEYS = ['smtpPass', 'waToken', 'omniApiKey', 'bcClientSecret'];
function getConfig() {
  const file = readJson(CONFIG_FILE, {});
  const cfg = { ...file };
  for (const [k, env] of Object.entries(ENV_MAP)) if (process.env[env]) cfg[k] = process.env[env];
  return cfg;
}
const envLocked = () => Object.entries(ENV_MAP).filter(([, env]) => process.env[env]).map(([k]) => k);
function comms() {
  const d = (store['settings/comms'] && store['settings/comms'].data) || {};
  return { email: d.email || {}, wa: d.wa || {}, voice: d.voice || {} };
}

/* ---------- sessions ---------- */
function sign(payload) { return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'); }
function makeToken(user) { const p = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url'); return p + '.' + sign(p); }
function readToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [p, s] = tok.split('.');
  const expect = sign(p);
  if (s.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch (_) { return null; }
}
function cookies(req) { const out = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return out; }
function setSession(req, res, value, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ccd_sess=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < 10 * 60e3);
  attempts.set(ip, a); return a.length >= 10;
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); next(); });
app.use(express.json({ limit: '20mb' }));

const DASHBOARD = path.join(__dirname, 'public', 'dashboard.html');
const SHARE_DIR = path.join(__dirname, 'public', 'share');
const escAttr = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Link previews (WhatsApp, LinkedIn, Slack, Teams, X, Facebook) and icons */
function shareHead(req) {
  const b = (store['settings/branding'] && store['settings/branding'].data) || {};
  const app = process.env.SHARE_TITLE || b.appName || 'Credit Control Desk';
  const company = b.company || 'Urja Products Private Limited';
  const title = `${app} | ${company}`;
  const desc = process.env.SHARE_DESCRIPTION || `Receivables tracking, pending-due alerts and reminders by email, WhatsApp and voice AI for ${company}. Sign in to continue.`;
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const url = base + '/';
  const img = `${base}/share/og-image.jpg?v=${process.env.SHARE_IMAGE_VERSION || '1'}`;
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#E96B17';
  const alt = `${app} – receivables dashboard for ${company}`;
  const m = (k, v, attr = 'name') => `<meta ${attr}="${k}" content="${escAttr(v)}">`;
  return [
    `<title>${escAttr(title)}</title>`,
    m('description', desc), m('robots', 'noindex, nofollow'), m('theme-color', color),
    `<link rel="canonical" href="${escAttr(url)}">`,
    m('og:type', 'website', 'property'), m('og:site_name', app, 'property'), m('og:title', title, 'property'), m('og:description', desc, 'property'),
    m('og:url', url, 'property'), m('og:locale', 'en_IN', 'property'),
    m('og:image', img, 'property'), m('og:image:secure_url', img, 'property'), m('og:image:type', 'image/jpeg', 'property'),
    m('og:image:width', '1200', 'property'), m('og:image:height', '630', 'property'), m('og:image:alt', alt, 'property'),
    m('twitter:card', 'summary_large_image'), m('twitter:title', title), m('twitter:description', desc), m('twitter:image', img), m('twitter:image:alt', alt),
    `<link rel="icon" href="/favicon.ico" sizes="any">`, `<link rel="icon" type="image/png" sizes="32x32" href="/share/favicon-32.png">`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`, `<link rel="manifest" href="/site.webmanifest">`,
    m('apple-mobile-web-app-title', app), m('application-name', app),
    m('apple-mobile-web-app-capable', 'yes'), m('mobile-web-app-capable', 'yes'), m('apple-mobile-web-app-status-bar-style', 'default')
  ].join('');
}
app.use('/share', express.static(SHARE_DIR, { maxAge: '7d' }));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(SHARE_DIR, 'favicon.ico'), { maxAge: '7d' }));
app.get('/apple-touch-icon.png', (req, res) => res.sendFile(path.join(SHARE_DIR, 'apple-touch-icon.png'), { maxAge: '7d' }));
app.get('/site.webmanifest', (req, res) => {
  const b = (store['settings/branding'] && store['settings/branding'].data) || {};
  res.type('application/manifest+json').send(JSON.stringify({
    name: `${b.appName || 'Credit Control Desk'} – ${b.company || 'Urja Products Private Limited'}`, short_name: b.appName || 'Credit Desk',
    id: '/', start_url: '/', scope: '/', display: 'standalone', orientation: 'any', background_color: '#F3F4F1', theme_color: b.color || '#E96B17',
    description: `Receivables, pending-due alerts and reminders for ${b.company || 'Urja Products Private Limited'}`,
    icons: [{ src: '/share/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/share/icon-512.png', sizes: '512x512', type: 'image/png' }]
  }));
});

/* service worker: lets phones install the app; pages always come from the network, with an offline notice */
const SW_JS = `const V='ccd-sw-1';
const OFFLINE='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F3F4F1;color:#1A2320;text-align:center;padding:24px}b{display:block;font-size:19px;margin-bottom:6px}button{margin-top:16px;border:0;border-radius:8px;padding:10px 18px;background:#E96B17;color:#fff;font:inherit;font-weight:600}</style></head><body><div><b>You are offline</b>Credit Control Desk needs an internet connection.<br><button onclick="location.reload()">Try again</button></div></body></html>';
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method==='GET'&&r.mode==='navigate'){e.respondWith(fetch(r).catch(()=>new Response(OFFLINE,{headers:{'Content-Type':'text/html; charset=utf-8'}})));}});`;
app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.set('Service-Worker-Allowed', '/'); res.type('application/javascript').send(SW_JS); });

app.get('/', (req, res) => {
  const page = fs.readFileSync(DASHBOARD, 'utf8');
  res.type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + shareHead(req)
    + '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
    + '<script>window.__CCD_SERVER__=true</script></head><body>' + page + '</body></html>');
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
// public: company name, colours and logo for the login screen (no receivables data)
app.get('/api/branding', (req, res) => {
  const d = (store['settings/branding'] && store['settings/branding'].data) || null;
  if (!d) return res.json({ data: null });
  const { company, appName, tagline, loginText, color, logoBadge, logo } = d;
  res.json({ data: { company, appName, tagline, loginText, color, logoBadge, logo } });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username = '', password = '' } = req.body || {};
  const ok = safeEqual(String(username).trim().toLowerCase(), ADMIN_USER.toLowerCase()) & safeEqual(String(password), ADMIN_PASSWORD);
  if (!ok) { attempts.get(ip).push(Date.now()); return res.status(401).json({ error: 'The username or password is incorrect.' }); }
  attempts.delete(ip);
  setSession(req, res, makeToken(ADMIN_USER), SESSION_HOURS * 3600);
  res.json({ ok: true, user: ADMIN_USER });
});
app.post('/api/logout', (req, res) => { setSession(req, res, '', 0); res.json({ ok: true }); });

function auth(req, res, next) {
  const s = readToken(cookies(req).ccd_sess);
  if (!s) return res.status(401).json({ error: 'Sign in required.' });
  req.user = s.u; next();
}
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

/* document store API */
app.get('/api/doc', auth, (req, res) => {
  const p = req.query.path; if (!checkPath(p, true)) return res.status(400).json({ error: 'Invalid document path.' });
  res.json({ data: store[p] ? store[p].data : null });
});
app.put('/api/doc', auth, (req, res) => {
  const p = req.query.path; if (!checkPath(p, true)) return res.status(400).json({ error: 'Invalid document path.' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Document must be a JSON object.' });
  store[p] = { data: req.body, updatedAt: new Date().toISOString(), by: req.user }; persist();
  res.json({ ok: true });
});
app.delete('/api/doc', auth, (req, res) => {
  const p = req.query.path; if (!checkPath(p, true)) return res.status(400).json({ error: 'Invalid document path.' });
  delete store[p]; persist(); res.json({ ok: true });
});
app.get('/api/col', auth, (req, res) => {
  const p = req.query.path; if (!checkPath(p, false)) return res.status(400).json({ error: 'Invalid collection path.' });
  const depth = p.split('/').length + 1;
  let docs = Object.keys(store).filter(k => k.startsWith(p + '/') && k.split('/').length === depth).map(k => ({ id: k.split('/').pop(), data: store[k].data }));
  const ob = req.query.orderBy, dir = req.query.dir === 'desc' ? -1 : 1;
  if (ob) docs.sort((a, b) => { const x = a.data[ob], y = b.data[ob]; if (x === y) return 0; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : -1) * dir; });
  else docs.sort((a, b) => a.id < b.id ? -1 : 1);
  const lim = Math.min(1000, +req.query.limit || 1000);
  res.json({ docs: docs.slice(0, lim) });
});

/* provider configuration API */
app.get('/api/config', auth, (req, res) => {
  const c = getConfig(), out = { envLocked: envLocked() };
  for (const k of Object.keys(ENV_MAP)) {
    if (SECRET_KEYS.includes(k)) out[k + 'Set'] = !!c[k]; else out[k] = c[k] ?? '';
  }
  out.emailReady = !!(c.smtpHost && c.smtpUser && c.smtpPass);
  out.waReady = !!(c.waPhoneNumberId && c.waToken);
  out.omniReady = !!c.omniApiKey;
  out.bcReady = !!(c.bcTenantId && c.bcClientId && c.bcClientSecret && c.bcCompanyName);
  res.json(out);
});
app.put('/api/config', auth, (req, res) => {
  const file = readJson(CONFIG_FILE, {}), locked = envLocked();
  for (const k of Object.keys(ENV_MAP)) {
    if (locked.includes(k) || !(k in (req.body || {}))) continue;
    const v = String(req.body[k] ?? '').trim();
    if (SECRET_KEYS.includes(k) && !v) continue; // blank secret = keep existing
    file[k] = v;
  }
  writeJsonAtomic(CONFIG_FILE, file);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
  res.json({ ok: true });
});

/* ---------- senders ---------- */
const isEmail = s => /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(s);
const splitList = s => String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
function mailer() {
  const c = getConfig();
  if (!c.smtpHost || !c.smtpUser || !c.smtpPass) throw httpErr(400, 'Email is not set up. Add your SMTP details in Settings → Server & API keys.');
  return { c, t: nodemailer.createTransport({ host: c.smtpHost, port: +c.smtpPort || 587, secure: String(c.smtpSecure) === 'true', auth: { user: c.smtpUser, pass: c.smtpPass } }) };
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
const escHtml = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

async function sendEmail({ to, cc, subject, body }) {
  const tos = splitList(to), ccs = splitList(cc);
  if (!tos.length || !tos.every(isEmail) || !ccs.every(isEmail)) throw httpErr(400, 'Check the To and CC email addresses.');
  if (!subject || !body) throw httpErr(400, 'Subject and message are required.');
  const { c, t } = mailer(), e = comms().email;
  const fromAddr = e.fromEmail || c.smtpUser;
  const info = await t.sendMail({
    from: e.fromName ? { name: e.fromName, address: fromAddr } : fromAddr,
    to: tos, cc: ccs.length ? ccs : undefined, replyTo: e.replyTo || undefined,
    subject, text: body,
    html: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' + escHtml(body).replace(/\n/g, '<br>') + '</div>'
  });
  return { id: info.messageId };
}

async function sendWhatsApp({ to, text, params }) {
  const c = getConfig(), w = comms().wa;
  if (!c.waPhoneNumberId || !c.waToken) throw httpErr(400, 'WhatsApp is not set up. Add your phone number ID and access token in Settings → Server & API keys.');
  const num = String(to || '').replace(/\D/g, '');
  if (num.length < 10 || num.length > 15) throw httpErr(400, 'Enter the WhatsApp number with country code, e.g. 919876543210.');
  let payload;
  if ((w.mode || 'template') === 'text') {
    if (!text) throw httpErr(400, 'The message is empty.');
    payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: num, type: 'text', text: { preview_url: false, body: String(text).slice(0, 4096) } };
  } else {
    if (!w.templateName) throw httpErr(400, 'Set the approved template name in Settings → WhatsApp.');
    const ps = (Array.isArray(params) ? params : []).map(p => String(p).replace(/\s*\n\s*/g, ' ').slice(0, 1024));
    payload = { messaging_product: 'whatsapp', to: num, type: 'template', template: { name: w.templateName, language: { code: w.templateLang || 'en' }, components: ps.length ? [{ type: 'body', parameters: ps.map(t => ({ type: 'text', text: t })) }] : [] } };
  }
  const r = await fetch(`${WA_GRAPH_BASE}/${c.waApiVersion || 'v21.0'}/${encodeURIComponent(c.waPhoneNumberId)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${c.waToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(502, 'WhatsApp rejected the message: ' + ((j.error && (j.error.error_user_msg || j.error.message)) || r.status));
  return { id: j.messages && j.messages[0] && j.messages[0].id };
}

async function placeCall({ to, context }) {
  const c = getConfig(), v = comms().voice;
  if (!c.omniApiKey) throw httpErr(400, 'OmniDim is not set up. Add your OmniDim API key in Settings → Server & API keys.');
  if (!v.agentId) throw httpErr(400, 'Set your OmniDim agent ID in Settings → Voice AI.');
  const num = '+' + String(to || '').replace(/\D/g, '');
  if (num.length < 11 || num.length > 16) throw httpErr(400, 'Enter the number to call with country code, e.g. +919876543210.');
  const asId = x => /^\d+$/.test(String(x)) ? Number(x) : x;
  const body = { agent_id: asId(v.agentId), to_number: num, call_context: context && typeof context === 'object' ? context : {} };
  if (v.fromNumberId) body.from_number_id = asId(v.fromNumberId);
  const r = await fetch(`${OMNIDIM_BASE}/calls/dispatchCall`, {
    method: 'POST', headers: { Authorization: `Bearer ${c.omniApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw httpErr(502, 'OmniDim could not place the call: ' + (j.error || j.message || j.detail || r.status));
  return { id: j.requestId || j.request_id || j.call_id || j.id || (j.data && (j.data.requestId || j.data.id)) || '', raw: j };
}

function route(kind, fn) {
  return async (req, res) => {
    const b = req.body || {};
    try {
      const out = await fn(b);
      outbox({ kind, by: req.user, cn: b.cn, to: b.to, ok: true, id: out.id });
      res.json({ ok: true, id: out.id || '' });
    } catch (e) {
      outbox({ kind, by: req.user, cn: b.cn, to: b.to, ok: false, error: e.message });
      res.status(e.status || 500).json({ error: e.message || 'Sending failed.' });
    }
  };
}
app.post('/api/send/email', auth, route('email', sendEmail));
app.post('/api/send/whatsapp', auth, route('whatsapp', sendWhatsApp));
app.post('/api/call', auth, route('call', placeCall));
app.post('/api/test/email', auth, route('test-email', b => sendEmail({ to: b.to, subject: 'Credit Control Desk – test email', body: 'This is a test email from your Credit Control Desk server. Email sending is working.' })));

/* Microsoft Dynamics 365 Business Central */
const bc = require('./bc')({ getConfig, store, persist });
const bcRoute = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Business Central request failed.' }); }
};
app.post('/api/bc/test', auth, bcRoute(() => bc.test()));
app.post('/api/bc/sync', auth, bcRoute(() => bc.sync('manual')));
app.get('/api/bc/status', auth, bcRoute(async () => bc.status()));
bc.startScheduler();

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => console.log(`Credit Control Desk running on http://localhost:${PORT}`));
