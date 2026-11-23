/**
 * One-time email codes: verify an email at sign-up, reset a forgotten password, two-step sign-in and email change.
 * Codes are 6 digits, stored hashed in memory, valid 10 minutes, 5 tries, one resend every 45 seconds.
 * Mail goes through our own SMTP (free Gmail app password) — no SMS or third-party OTP service.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const mailer = require('./mailer');

const TTL = 10 * 60 * 1000, RESEND = 45 * 1000, TRIES = 5;
const codes = new Map(); // `${purpose}:${key}` -> { hash, exp, tries, sentAt }

const hash = (c) => crypto.createHash('sha256').update(String(c)).digest('hex');
const k = (purpose, key) => `${purpose}:${String(key).toLowerCase()}`;
const cleanEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail(e));

function mask(email) {
  const [u, d] = cleanEmail(email).split('@');
  if (!d) return '';
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(2, u.length - 2))}@${d}`;
}

function sweep() { const now = Date.now(); for (const [x, v] of codes) if (v.exp < now) codes.delete(x); }

/** Sends a code. Returns { ok, wait?, simulated?, devCode? }. devCode only when mail is not set up and not in production. */
async function send(purpose, key, email, name) {
  sweep();
  const id = k(purpose, key);
  const old = codes.get(id);
  if (old && Date.now() - old.sentAt < RESEND) return { ok: false, wait: Math.ceil((RESEND - (Date.now() - old.sentAt)) / 1000) };
  const code = String(crypto.randomInt(100000, 1000000));
  codes.set(id, { hash: hash(code), exp: Date.now() + TTL, tries: 0, sentAt: Date.now() });
  const r = await mailer.sendOtpEmail({ to: cleanEmail(email), code, name: name || 'there', purpose });
  if (!r.success) { codes.delete(id); return { ok: false, error: 'Could not send the email. Check the address and try again.' }; }
  const dev = r.simulated && process.env.NODE_ENV !== 'production';
  if (r.simulated) console.log(`[OTP] ${purpose} code for ${cleanEmail(email)}: ${dev ? code : '(hidden)'}`);
  return { ok: true, simulated: !!r.simulated, ...(dev ? { devCode: code } : {}) };
}

/** Checks a code once. Returns { ok } or { ok:false, error }. A correct code is used up. */
function check(purpose, key, code) {
  const id = k(purpose, key);
  const v = codes.get(id);
  if (!v || v.exp < Date.now()) { codes.delete(id); return { ok: false, error: 'This code has expired. Ask for a new one.' }; }
  if (v.tries >= TRIES) { codes.delete(id); return { ok: false, error: 'Too many wrong tries. Ask for a new code.' }; }
  if (hash(String(code || '').trim()) !== v.hash) { v.tries += 1; return { ok: false, error: `Wrong code. ${TRIES - v.tries} tries left.` }; }
  codes.delete(id);
  return { ok: true };
}

/** Short-lived proof that an email was verified, handed back at sign-up (so the code is not re-sent). */
const emailProof = (email) => jwt.sign({ kind: 'email-proof', email: cleanEmail(email) }, JWT_SECRET, { expiresIn: '30m' });
function proofOk(token, email) {
  try { const p = jwt.verify(String(token || ''), JWT_SECRET); return p.kind === 'email-proof' && p.email === cleanEmail(email); } catch (_) { return false; }
}

/** Two-step sign-in: password was right, now a code is needed. The challenge carries the restaurant id. */
const challenge = (rid) => jwt.sign({ kind: '2fa', rid }, JWT_SECRET, { expiresIn: '10m' });
function challengeRid(token) {
  try { const p = jwt.verify(String(token || ''), JWT_SECRET); return p.kind === '2fa' ? p.rid : null; } catch (_) { return null; }
}

module.exports = { send, check, mask, cleanEmail, validEmail, emailProof, proofOk, challenge, challengeRid };
