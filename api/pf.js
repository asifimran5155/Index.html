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
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function encryptText(plainText, keyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

function decryptText(payload, keyBuf) {
  const parts = String(payload || '').split(':');
  if (parts.length !== 3) throw new HttpError(500, 'Stored token format is invalid.');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const data = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, 'Invalid JSON request body.');
  }
}

function extractBearerToken(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

async function getAuthedUser(req, cfg) {
  const bearer = extractBearerToken(req);
  if (!bearer) throw new HttpError(401, 'Missing authorization token.');

  const resp = await fetch(`${cfg.url}/auth/v1/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearer}`,
      apikey: PUB_KEY
    }
  });

  if (!resp.ok) {
    throw new HttpError(401, 'Invalid or expired session token.');
  }
  const data = await resp.json();
  if (!data || !data.id || !UUID.test(data.id)) {
    throw new HttpError(401, 'Could not verify authenticated user.');
  }
  return data;
}

async function sbRest(cfg, path, options = {}) {
  const method = options.method || 'GET';
  const headers = Object.assign(
    {
      apikey: cfg.secret,
      Authorization: `Bearer ${cfg.secret}`,
      'Content-Type': 'application/json'
    },
    options.headers || {}
  );

  const resp = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });

  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }

  if (!resp.ok) {
    const msg = (json && (json.message || json.error_description || json.hint)) || text || `Supabase REST error (${resp.status})`;
    throw new HttpError(500, `Database error: ${msg}`);
  }
  return json;
}

function slugify(str) {
  return String(str || 'untitled-article')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'untitled-article';
}

function buildHackmdUrl(noteData, title) {
  if (noteData && typeof noteData.publishLink === 'string' && /^https?:\/\//i.test(noteData.publishLink)) {
    return noteData.publishLink.trim();
  }
  if (noteData && typeof noteData.shortPath === 'string' && noteData.shortPath.trim()) {
    return `https://hackmd.io/s/${noteData.shortPath.replace(/^\/+/, '')}`;
  }
  const noteId = noteData && (noteData.id || noteData.noteId);
  if (noteId) {
    return `https://hackmd.io/${encodeURIComponent(noteId)}/${slugify(title)}`;
  }
  throw new HttpError(502, 'HackMD response did not include a note URL or ID.');
}

async function getSavedHackmdToken(cfg, userId) {
  // Expects table `provider_tokens` with columns: user_id, provider, encrypted_token, updated_at
  const rows = await sbRest(
    cfg,
    `provider_tokens?user_id=eq.${encodeURIComponent(userId)}&provider=eq.hackmd&select=encrypted_token,updated_at&limit=1`
  );
  if (!Array.isArray(rows) || !rows.length || !rows[0].encrypted_token) {
    return null;
  }
  return {
    token: decryptText(rows[0].encrypted_token, cfg.key),
    updated_at: rows[0].updated_at || null
  };
}

async function saveHackmdToken(cfg, userId, plainToken) {
  const clean = String(plainToken || '').trim();
  if (!clean || clean.length < 10) {
    throw new HttpError(400, 'Please enter a valid HackMD API token.');
  }

  // Verify token against HackMD API before saving
  const checkResp = await fetch(`${HACKMD}/me`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${clean}` }
  });
  if (!checkResp.ok) {
    throw new HttpError(400, 'HackMD rejected this API token. Check that it is valid and active.');
  }

  const encrypted = encryptText(clean, cfg.key);
  const now = new Date().toISOString();

  await sbRest(cfg, 'provider_tokens?on_conflict=user_id,provider', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: {
      user_id: userId,
      provider: 'hackmd',
      encrypted_token: encrypted,
      updated_at: now
    }
  });

  return { connected: true, updated_at: now };
}

async function publishToHackmd(hackmdToken, title, bodyText) {
  const cleanTitle = String(title || '').trim() || 'Untitled Article';
  const cleanBody = String(bodyText || '').trim();
  if (!cleanBody) {
    throw new HttpError(400, 'Article content cannot be empty.');
  }

  const markdownContent = cleanBody.startsWith('#')
    ? cleanBody
    : `# ${cleanTitle}\n\n${cleanBody}`;

  const resp = await fetch(`${HACKMD}/notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${hackmdToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: cleanTitle,
      content: markdownContent,
      readPermission: 'guest',
      writePermission: 'owner',
      commentPermission: 'everyone'
    })
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }

  if (!resp.ok) {
    const errMsg = (data && (data.message || data.error)) || text || `HackMD error (${resp.status})`;
    throw new HttpError(resp.status >= 400 && resp.status < 600 ? resp.status : 502, `HackMD publish failed: ${errMsg}`);
  }

  return buildHackmdUrl(data, cleanTitle);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.end();
  }

  if (req.method !== 'POST') {
    return out(res, 405, { error: 'Method not allowed. Use POST.' });
  }

  let submissionId = '';
  let cfg = null;

  try {
    cfg = env();
    const user = await getAuthedUser(req, cfg);
    const input = await readJsonBody(req);
    const action = String(input.action || (input.submission_id || input.submissionId ? 'publish' : 'status')).trim();

    if (action === 'status') {
      const saved = await getSavedHackmdToken(cfg, user.id);
      return out(res, 200, {
        ok: true,
        connected: !!saved,
        updated_at: saved ? saved.updated_at : null
      });
    }

    if (action === 'save_token') {
      const tokenVal = input.token || input.api_token || input.hackmd_token || '';
      const result = await saveHackmdToken(cfg, user.id, tokenVal);
      return out(res, 200, Object.assign({ ok: true }, result));
    }

    if (action === 'publish') {
      submissionId = String(input.submission_id || input.submissionId || '').trim();
      let title = String(input.title || '').trim();
      let body = String(input.body || input.content || '').trim();

      if (submissionId) {
        if (!UUID.test(submissionId)) {
          throw new HttpError(400, 'Invalid submission ID.');
        }
        const rows = await sbRest(
          cfg,
          `submissions?id=eq.${encodeURIComponent(submissionId)}&limit=1`
        );
        if (!Array.isArray(rows) || !rows.length) {
          throw new HttpError(404, 'Submission not found.');
        }
        const sub = rows[0];
        if (!title) title = sub.title || '';
        if (!body) body = sub.body || sub.content || '';
      }

      const saved = await getSavedHackmdToken(cfg, user.id);
      const tokenToUse = saved ? saved.token : (process.env.HACKMD_API_TOKEN || '').trim();
      if (!tokenToUse) {
        throw new HttpError(400, 'HackMD API token is not saved yet.');
      }

      const liveUrl = await publishToHackmd(tokenToUse, title, body);

      if (submissionId && UUID.test(submissionId)) {
        await sbRest(cfg, `submissions?id=eq.${encodeURIComponent(submissionId)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: {
            status: 'live',
            live_url: liveUrl
          }
        });
      }

      return out(res, 200, {
        ok: true,
        status: 'live',
        live_url: liveUrl
      });
    }

    throw new HttpError(400, `Unknown action: ${action}`);
  } catch (err) {
    const code = err && typeof err.code === 'number' ? err.code : 500;
    const message = (err && err.message) || 'Internal server error';

    if (cfg && submissionId && UUID.test(submissionId)) {
      try {
        await sbRest(cfg, `submissions?id=eq.${encodeURIComponent(submissionId)}`, {
          method: 'PATCH',
          body: { status: 'failed' }
        });
      } catch (_) {
        // Ignore secondary status update error
      }
    }

    return out(res, code, { error: message });
  }
};
