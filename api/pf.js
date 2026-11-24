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
