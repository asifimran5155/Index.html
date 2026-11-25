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
  if (!r.ok) throw new HttpError(500, 'Database error (' + r.status + ')');
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

async function handle(req, res) {
  if (req.method === 'GET') {
    // Health check: open /api/pf in the browser. Shows only yes/no, never any secret value.
    const enc = process.env.ENCRYPTION_KEY || '';
    return out(res, 200, { ok: true, service: 'publishflow', version: 3, has_url: !!process.env.SUPABASE_URL, has_secret_key: !!process.env.SUPABASE_SECRET_KEY, has_encryption_key: /^[0-9a-f]{64}$/i.test(enc) });
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

  if (action === 'publish') {
    const subId = String(body.submission_id || '');
    if (!UUID.test(subId)) throw new HttpError(400, 'Bad submission');
    const subs = await db(E, 'submissions?id=eq.' + subId + '&select=id,user_id,site_id,title,body,status');
    const sub = subs[0];
    if (!sub) throw new HttpError(404, 'Article not found');
    if (sub.user_id !== user.id && !prof.is_admin) throw new HttpError(403, 'Not your article');
    if (!sub.site_id) throw new HttpError(400, 'Site was removed');
    const sites = await db(E, 'sites?id=eq.' + sub.site_id + '&select=id,kind');
    if (!sites[0] || sites[0].kind !== 'hackmd') throw new HttpError(400, 'This site is not set for auto-publish');
    const secs = await db(E, 'site_secrets?site_id=eq.' + sub.site_id + '&select=secret');
    if (!secs[0] || !secs[0].secret) throw new HttpError(400, 'Token is not set for this site yet. The article stays in the queue.');

    const allowed = prof.is_admin ? 'in.(queued,failed,publishing)' : 'eq.queued';
    const claimed = await db(E, 'submissions?id=eq.' + subId + '&status=' + allowed, 'PATCH', { status: 'publishing', error: null }, 'return=representation');
    if (!claimed.length) throw new HttpError(409, 'This article was already processed');

    try {
      const token = decrypt(secs[0].secret, E.key);
      const link = await publishToHackmd(token, sub.title, sub.body);
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

module.exports._test = { encrypt, decrypt, noteContent, makeSlug };
