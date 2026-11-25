// PublishFlow server function (Vercel). Handles: HackMD auto-publish, token save, token status.
// Needs 3 environment variables in Vercel: SUPABASE_URL, SUPABASE_SECRET_KEY, ENCRYPTION_KEY
const crypto = require('crypto');

const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Fwvj4Kdd2dZYdZztsTy8Yw_aZUtb8v-';
const HACKMD = 'https://api.hackmd.io/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function out(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function env() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const secret = process.env.SUPABASE_SECRET_KEY || '';
  const enc = process.env.ENCRYPTION_KEY || '';
  const missing = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!secret) missing.push('SUPABASE_SECRET_KEY');
  if (!enc) missing.push('ENCRYPTION_KEY');
  if (missing.length) throw new HttpError(500, 'Server not configured. Missing: ' + missing.join(', '));
  if (!/^[0-9a-f]{64}$/i.test(enc)) throw new HttpError(500, 'ENCRYPTION_KEY must be 64 hex characters');
  return { url, secret, key: Buffer.from(enc, 'hex') };
}

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function encrypt(text, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
}

function decrypt(blob, key) {
  const p = String(blob || '').split(':');
  if (p.length !== 4 || p[0] !== 'v1') throw new Error('bad format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p[1], 'base64'));
  d.setAuthTag(Buffer.from(p[2], 'base64'));
  return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
}

async function timed(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 20000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}

async function db(E, path, method, body, prefer) {
  const headers = { apikey: E.secret, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await timed(E.url + '/rest/v1/' + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  if (!r.ok) {
    let why = ''; try { why = JSON.parse(txt).message || ''; } catch (e) {}
    throw new HttpError(500, 'Database error (' + r.status + ')' + (why ? ': ' + String(why).slice(0, 120) : ''));
  }
  return txt ? JSON.parse(txt) : [];
}

async function whoIs(E, jwt) {
  const r = await timed(E.url + '/auth/v1/user', { headers: { apikey: PUB_KEY, Authorization: 'Bearer ' + jwt } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && UUID.test(u.id || '') ? u : null;
}

function noteContent(title, body) {
  const b = String(body || '').trim();
  return /^#\s/.test(b) ? b : '# ' + title + '\n\n' + b;
}

function makeSlug(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

async function postNote(token, content, permalink) {
  const payload = { content, readPermission: 'guest', writePermission: 'owner' };
  if (permalink) payload.permalink = permalink;
  const r = await timed(HACKMD + '/notes', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 20000);
  return { r, txt: await r.text() };
}

async function publishToHackmd(token, title, body) {
  const content = noteContent(title, body);
  const slug = makeSlug(title);
  // Try a title-based link first, then the same with a short random suffix, then HackMD's default link.
  const tries = slug ? [slug, slug + '-' + crypto.randomBytes(2).toString('hex'), ''] : [''];
  let last = null;
  for (const p of tries) {
    const { r, txt } = await postNote(token, content, p);
    if (r.ok) {
      let j = {};
      try { j = JSON.parse(txt); } catch (e) {}
      const link = j.publishLink || (j.id ? 'https://hackmd.io/' + j.id : '');
      if (!/^https:\/\//i.test(link)) throw new Error('HackMD did not return a link');
      return link;
    }
    last = { status: r.status, txt };
    if (![400, 409, 422].includes(r.status)) break;
  }
  const msg = last.status === 401 ? 'token rejected' : last.txt.replace(/\s+/g, ' ').slice(0, 120);
  throw new Error('HackMD ' + last.status + ': ' + msg);
}


// ---------- Telegra.ph ----------
const TELEGRAPH = 'https://api.telegra.ph';
const AUTO_KINDS = ['hackmd', 'telegraph'];

function inlineNodes(text) {
  const nodes = [];
  const re = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2]) nodes.push({ tag: 'img', attrs: { src: m[2] } });
    else if (m[4]) nodes.push({ tag: 'a', attrs: { href: m[4] }, children: [m[3]] });
    else if (m[5] !== undefined) nodes.push({ tag: 'strong', children: inlineNodes(m[5]) });
    else nodes.push({ tag: 'em', children: inlineNodes(m[6]) });
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function mdToNodes(md) {
  const out = [];
  let para = [], list = null;
  const flushPara = () => {
    if (!para.length) return;
    let cur = [];
    const pushP = () => { if (cur.length) { out.push({ tag: 'p', children: cur }); cur = []; } };
    para.forEach((line, i) => {
      if (i > 0 && cur.length) cur.push({ tag: 'br' });
      inlineNodes(line).forEach(n => {
        if (n && n.tag === 'img') { pushP(); out.push({ tag: 'figure', children: [n] }); }
        else cur.push(n);
      });
    });
    pushP();
    para = [];
  };
  const flushList = () => { if (list) { out.push(list); list = null; } };
  String(md || '').replace(/\r/g, '').split('\n').forEach(raw => {
    const l = raw.trim();
    let m;
    if (!l) { flushPara(); flushList(); return; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { flushPara(); flushList(); out.push({ tag: m[1].length >= 3 ? 'h4' : 'h3', children: inlineNodes(m[2]) }); return; }
    if ((m = /^[-*]\s+(.*)$/.exec(l))) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', children: [] }; } list.children.push({ tag: 'li', children: inlineNodes(m[1]) }); return; }
    if ((m = /^\d+\.\s+(.*)$/.exec(l))) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', children: [] }; } list.children.push({ tag: 'li', children: inlineNodes(m[1]) }); return; }
    if ((m = /^>\s?(.*)$/.exec(l))) { flushPara(); flushList(); out.push({ tag: 'blockquote', children: inlineNodes(m[1]) }); return; }
    if (/^(-{3,}|\*{3,})$/.test(l)) { flushPara(); flushList(); out.push({ tag: 'hr' }); return; }
    flushList(); para.push(l);
  });
  flushPara(); flushList();
  return out.length ? out : [{ tag: 'p', children: [''] }];
}

async function tgCall(method, payload) {
  const r = await timed(TELEGRAPH + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 20000);
  let j = {};
  try { j = JSON.parse(await r.text()); } catch (e) {}
  if (!j.ok) throw new Error('Telegraph: ' + String(j.error || ('status ' + r.status)).slice(0, 100));
  return j.result;
}

async function publishToTelegraph(E, siteId, blob, title, body) {
  let token = null;
  if (blob) { try { token = decrypt(blob, E.key); } catch (e) { token = null; } }
  if (!token) {
    const acc = await tgCall('createAccount', { short_name: 'PublishFlow' });
    token = acc.access_token;
    if (!token) throw new Error('Telegraph did not return an account');
    await db(E, 'site_secrets?on_conflict=site_id', 'POST', { site_id: siteId, secret: encrypt(token, E.key) }, 'resolution=merge-duplicates');
  }
  const text = String(body || '').trim().replace(/^#\s+[^\n]*\n+/, '');
  const content = mdToNodes(text);
  if (JSON.stringify(content).length > 60000) throw new Error('Article is too long for Telegra.ph (limit about 60 KB)');
  const page = await tgCall('createPage', { access_token: token, title: String(title || 'Untitled').slice(0, 250), content, return_content: false });
  if (!/^https:\/\//i.test(page.url || '')) throw new Error('Telegraph did not return a link');
  return page.url;
}

// ---------- Google Sheet import ----------
function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  t = String(t || '').replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

function sheetCsvUrl(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const gid = (u.searchParams.get('gid') || (/gid=(\d+)/.exec(u.hash) || [])[1] || '');
  let m = /^\/spreadsheets\/d\/e\/([\w-]+)/.exec(u.pathname);
  if (m) return 'https://docs.google.com/spreadsheets/d/e/' + m[1] + '/pub?output=csv' + (gid ? '&gid=' + gid : '');
  m = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
  if (m) return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/export?format=csv' + (gid ? '&gid=' + gid : '');
  return null;
}

const KIND_SET = ['hackmd', 'telegraph', 'wordpress', 'webhook', 'browser', 'manual'];
const COLS = {
  name: ['name', 'site', 'website', 'url', 'domain'],
  kind: ['kind', 'type', 'connector'],
  da: ['da'], dr: ['dr'],
  link: ['link_type', 'linktype', 'link', 'follow'],
  images: ['images', 'image', 'images_allowed', 'imagesallowed'],
  indexed: ['indexed', 'index', 'indexing']
};

function sheetRows(rows) {
  if (rows.length < 2) return { error: 'The sheet needs a header row and at least one site.' };
  const head = rows[0].map(h => String(h).trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const idx = {};
  Object.keys(COLS).forEach(k => { idx[k] = head.findIndex(h => COLS[k].includes(h)); });
  if (idx.name < 0) return { error: 'No "name" column found in the first row.' };
  const no = v => /^(no|n|false|0|not|off)/i.test(v);
  const num = v => { const n = parseInt(v, 10); return isNaN(n) ? undefined : Math.max(0, Math.min(100, n)); };
  const seen = new Set(), list = []; let skipped = 0;
  rows.slice(1, 501).forEach(r => {
    const cell = k => (idx[k] >= 0 && r[idx[k]] != null) ? String(r[idx[k]]).trim() : '';
    const name = cell('name').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    if (!name || name.length > 100 || seen.has(name)) { skipped++; return; }
    seen.add(name);
    const o = { name };
    let kind = cell('kind').toLowerCase().replace(/[^a-z]/g, '');
    if (kind === 'wp') kind = 'wordpress';
    if (kind === 'telegra' || kind === 'telegraphph') kind = 'telegraph';
    if (kind) o.kind = KIND_SET.includes(kind) ? kind : 'manual';
    const da = num(cell('da')); if (da !== undefined) o.da = da;
    const dr = num(cell('dr')); if (dr !== undefined) o.dr = dr;
    const lk = cell('link'); if (lk) o.link_type = /^no/i.test(lk) ? 'nofollow' : 'dofollow';
    const im = cell('images'); if (im) o.images_allowed = !no(im);
    const ix = cell('indexed'); if (ix) o.indexed = !no(ix);
    list.push(o);
  });
  return { list, skipped };
}

async function importSheet(E, body) {
  let text = '';
  if (body.csv) {
    text = String(body.csv).slice(0, 300000);
  } else {
    const url = sheetCsvUrl(body.url);
    if (!url) throw new HttpError(400, 'Paste a Google Sheets link (docs.google.com/spreadsheets/...)');
    const r = await timed(url, { redirect: 'follow' }, 15000);
    text = (await r.text()).slice(0, 300000);
    const ct = String(r.headers && r.headers.get ? r.headers.get('content-type') || '' : '');
    if (!r.ok || /html/i.test(ct) || /^\s*</.test(text)) throw new HttpError(400, 'Could not read the sheet. Make it public: Share > Anyone with the link > Viewer, or File > Share > Publish to web.');
  }
  const parsed = sheetRows(parseCSV(text));
  if (parsed.error) throw new HttpError(400, parsed.error);
  const existing = await db(E, 'sites?select=id,name');
  const byName = {};
  existing.forEach(x => { byName[String(x.name).toLowerCase()] = x.id; });
  const toAdd = [], toUpd = [];
  parsed.list.forEach(o => { if (byName[o.name]) toUpd.push({ id: byName[o.name], o }); else toAdd.push(o); });
  // Every row must carry the same columns: PostgREST turns missing keys into NULL, which breaks NOT NULL columns.
  const added = toAdd.map(o => Object.assign({ kind: 'manual', da: null, dr: null, link_type: 'dofollow', images_allowed: true, indexed: true }, o));
  for (let i = 0; i < added.length; i += 100) await db(E, 'sites', 'POST', added.slice(i, i + 100), 'return=minimal');
  let updated = 0;
  for (let i = 0; i < toUpd.length; i += 10) {
    await Promise.all(toUpd.slice(i, i + 10).map(async u => {
      const patch = Object.assign({}, u.o); delete patch.name;
      if (Object.keys(patch).length) { await db(E, 'sites?id=eq.' + u.id, 'PATCH', patch, 'return=minimal'); updated++; }
    }));
  }
  return { ok: true, added: added.length, updated, skipped: parsed.skipped + (toUpd.length - updated) };
}

async function handle(req, res) {
  if (req.method === 'GET') {
    // Health check: open /api/pf in the browser. Shows only yes/no, never any secret value.
    const enc = process.env.ENCRYPTION_KEY || '';
    return out(res, 200, { ok: true, service: 'publishflow', version: 4, has_url: !!process.env.SUPABASE_URL, has_secret_key: !!process.env.SUPABASE_SECRET_KEY, has_encryption_key: /^[0-9a-f]{64}$/i.test(enc) });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  const E = env();
  const jwt = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'Please sign in again');
  const user = await whoIs(E, jwt);
  if (!user) throw new HttpError(401, 'Please sign in again');
  const profs = await db(E, 'profiles?id=eq.' + user.id + '&select=is_admin,active');
  const prof = profs[0];
  if (!prof || !prof.active) throw new HttpError(403, 'Account is off');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const action = body.action;

  if (action === 'secrets') {
    if (!prof.is_admin) throw new HttpError(403, 'Admins only');
    const rows = await db(E, 'site_secrets?select=site_id,secret');
    return out(res, 200, { sites: rows.filter(r => r.secret).map(r => r.site_id) });
  }

  if (action === 'save-secret') {
    if (!prof.is_admin) throw new HttpError(403, 'Admins only');
    const siteId = String(body.site_id || '');
    const token = String(body.token || '').trim();
    if (!UUID.test(siteId)) throw new HttpError(400, 'Bad site');
    if (token.length < 10 || token.length > 500) throw new HttpError(400, 'Token looks wrong');
    const sites = await db(E, 'sites?id=eq.' + siteId + '&select=id,kind');
    if (!sites[0]) throw new HttpError(404, 'Site not found');
    if (sites[0].kind !== 'hackmd') throw new HttpError(400, 'This site is not a HackMD site');
    await db(E, 'site_secrets?on_conflict=site_id', 'POST', { site_id: siteId, secret: encrypt(token, E.key) }, 'resolution=merge-duplicates');
    return out(res, 200, { ok: true });
  }

  if (action === 'import-sheet') {
    if (!prof.is_admin) throw new HttpError(403, 'Admins only');
    return out(res, 200, await importSheet(E, body));
  }

  if (action === 'publish') {
    const subId = String(body.submission_id || '');
    if (!UUID.test(subId)) throw new HttpError(400, 'Bad submission');
    const subs = await db(E, 'submissions?id=eq.' + subId + '&select=id,user_id,site_id,title,body,status');
    const sub = subs[0];
    if (!sub) throw new HttpError(404, 'Article not found');
    if (sub.user_id !== user.id && !prof.is_admin) throw new HttpError(403, 'Not your article');
    if (!sub.site_id) throw new HttpError(400, 'Site was removed');
    const sites = await db(E, 'sites?id=eq.' + sub.site_id + '&select=id,kind');
    if (!sites[0] || !AUTO_KINDS.includes(sites[0].kind)) throw new HttpError(400, 'This site is not set for auto-publish');
    const kind = sites[0].kind;
    const secs = await db(E, 'site_secrets?site_id=eq.' + sub.site_id + '&select=secret');
    if (kind === 'hackmd' && (!secs[0] || !secs[0].secret)) throw new HttpError(400, 'Token is not set for this site yet. The article stays in the queue.');

    const allowed = prof.is_admin ? 'in.(queued,failed,publishing)' : 'eq.queued';
    const claimed = await db(E, 'submissions?id=eq.' + subId + '&status=' + allowed, 'PATCH', { status: 'publishing', error: null }, 'return=representation');
    if (!claimed.length) throw new HttpError(409, 'This article was already processed');

    try {
      let link;
      if (kind === 'hackmd') link = await publishToHackmd(decrypt(secs[0].secret, E.key), sub.title, sub.body);
      else link = await publishToTelegraph(E, sub.site_id, secs[0] && secs[0].secret, sub.title, sub.body);
      await db(E, 'submissions?id=eq.' + subId, 'PATCH', { status: 'live', live_url: link, error: null });
      return out(res, 200, { ok: true, live_url: link });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).slice(0, 200);
      await db(E, 'submissions?id=eq.' + subId, 'PATCH', { status: 'failed', error: msg });
      return out(res, 502, { error: msg });
    }
  }

  throw new HttpError(400, 'Unknown action');
}

module.exports = async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    if (e instanceof HttpError) return out(res, e.code, { error: e.message });
    return out(res, 500, { error: 'Server error: ' + String(e && e.message ? e.message : e).slice(0, 120) });
  }
};

module.exports._test = { encrypt, decrypt, noteContent, makeSlug, mdToNodes, parseCSV, sheetRows, sheetCsvUrl };
