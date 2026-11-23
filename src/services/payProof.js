/**
 * Reads a UPI payment screenshot and decides whether it can be approved on the spot.
 * Approve only when ALL of these are on the screenshot: our payee (name or UPI ID), the exact amount,
 * a success word, and today's date or a time within the last 3 hours — and the screenshot / UTR were never used before.
 * Anything else waits for the admin. Nothing leaves our server (OCR runs locally).
 */
const crypto = require('crypto');
const fs = require('fs');
const lite = require('./ocrLite');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function nowIST() { return new Date(Date.now() + 5.5 * 3600 * 1000); }

function dateSeen(text) {
  const d = nowIST();
  const day = d.getUTCDate(), m = d.getUTCMonth(), mon = MONTHS[m];
  const t = text.toLowerCase();
  const dd = String(day).padStart(2, '0'), mm = String(m + 1).padStart(2, '0');
  return [`${day} ${mon}`, `${dd} ${mon}`, `${mon} ${day}`, `${mon} ${dd}`, `${dd}/${mm}`, `${day}/${m + 1}`, `${dd}-${mm}`, `${dd}.${mm}`, 'today'].some((x) => t.includes(x));
}

function timeSeen(text) {
  const n = nowIST(), mins = n.getUTCHours() * 60 + n.getUTCMinutes();
  for (const m of text.matchAll(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/gi)) {
    let h = Number(m[1]); const mi = Number(m[2]); const ap = (m[3] || '').toLowerCase();
    if (h > 23 || mi > 59) continue;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const diff = mins - (h * 60 + mi);
    if (diff >= -10 && diff <= 180) return true;
  }
  return false;
}

/**
 * @returns {Promise<{ ok:boolean, reasons:string[], hash:string, utr?:string, text?:string }>}
 */
async function check(file, { amount, payeeName, upiId, usedHashes, usedUtrs }) {
  const buf = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const reasons = [];
  if (usedHashes.has(hash)) return { ok: false, reasons: ['This screenshot was already used'], hash };
  let text = '';
  try { text = await lite.readText(buf); } catch (e) { return { ok: false, reasons: ['Could not read the screenshot'], hash }; }
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  const flat = t.replace(/[\s,]/g, '');

  const nameParts = String(payeeName || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const nameHits = nameParts.filter((w) => t.includes(w)).length;
  const upi = String(upiId || '').toLowerCase();
  const upiHit = !!upi && (flat.includes(upi) || flat.includes(upi.split('@')[0]));
  const payee = (nameParts.length && nameHits >= Math.min(2, nameParts.length)) || upiHit;
  if (!payee) reasons.push('Payee name / UPI ID not found');

  const amt = Math.round(Number(amount) || 0);
  // the ₹ sign is often read as 3, 2, %, f or z — allow one such character right before the amount
  const amountHit = amt > 0 && new RegExp(`(?:^|[^0-9])(?:₹|rs\\.?|inr|[23%fz])?\\s?${amt.toLocaleString('en-IN').replace(/,/g, ',?')}(?:\\.00)?(?![0-9])`, 'i').test(t);
  if (!amountHit) reasons.push(`Amount ₹${amt} not found`);

  const success = /success|successful|paid|completed|sent|debited|done/.test(t);
  if (!success) reasons.push('No “successful” status found');

  const when = dateSeen(t) || timeSeen(t);
  if (!when) reasons.push('Today’s date or time not found');

  const utr = (t.match(/\b(\d{12})\b/) || [])[1];
  if (utr && usedUtrs.has(utr)) reasons.push('This UPI reference was already used');

  return { ok: !reasons.length, reasons, hash, utr, text: text.slice(0, 1500) };
}

module.exports = { check };
