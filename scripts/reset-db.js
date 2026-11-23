/**
 * Empty the database for a fresh start, keeping the platform setup.
 * Keeps: plans, menu designs, QR designs, feature list, settings, admin login, push keys, UPI ID.
 * Clears: restaurants, orders, payments, feedback, leads, coupons, activity log, checkout links, push subscriptions.
 * A full backup is written to data/backups/ first. Stop the backend before running (it would write the old data back).
 *
 *   node scripts/reset-db.js            # asks the server; refuses while it is running
 *   UPI_ID=name@bank node scripts/reset-db.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '../data/db.json');
const PORT = process.env.PORT || 5001;

(async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      console.error(`The backend is running on port ${PORT}. Stop it first (Ctrl+C in its terminal), then run this again.`);
      process.exit(1);
    }
  } catch (_) { /* not running: good */ }

  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const backups = path.join(path.dirname(DB_FILE), 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const backup = path.join(backups, `before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, JSON.stringify(db, null, 2));

  const before = Object.fromEntries(Object.entries(db).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  for (const k of ['restaurants', 'orders', 'feedbacks', 'payments', 'activities', 'leads', 'coupons', 'checkouts', 'pushSubs']) db[k] = [];
  db.adminConfig = db.adminConfig || {};
  if (process.env.UPI_ID) db.adminConfig.adminUpiId = process.env.UPI_ID;

  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  console.log('Backup saved to', backup);
  console.log('Cleared:', before);
  console.log('UPI ID:', db.adminConfig.adminUpiId || '(not set — add it in Admin → Settings)');
})();
