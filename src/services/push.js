/**
 * Browser push for the admin panel and the owner web app (iPhone home-screen app included) using the open Web Push standard (VAPID).
 * No Firebase or other third-party account: the keys are generated once and stored in our own database,
 * and the browser's built-in push channel delivers the message.
 */
const webpush = require('web-push');
const { inMemoryData, persistDb } = require('../db');

function keys() {
  const c = inMemoryData.adminConfig;
  if (!c.vapid || !c.vapid.publicKey) {
    c.vapid = webpush.generateVAPIDKeys();
    persistDb();
  }
  return c.vapid;
}

function setup() {
  const k = keys();
  const contact = inMemoryData.adminConfig.supportEmail ? `mailto:${inMemoryData.adminConfig.supportEmail}` : 'mailto:admin@localhost';
  webpush.setVapidDetails(contact, k.publicKey, k.privateKey);
}

const publicKey = () => keys().publicKey;

function subscribe(sub, who = 'admin') {
  if (!sub || !sub.endpoint || !sub.keys) return false;
  inMemoryData.pushSubs = (inMemoryData.pushSubs || []).filter((s) => s.endpoint !== sub.endpoint);
  inMemoryData.pushSubs.push({ ...sub, who, createdAt: new Date().toISOString() });
  persistDb();
  return true;
}

function unsubscribe(endpoint) {
  inMemoryData.pushSubs = (inMemoryData.pushSubs || []).filter((s) => s.endpoint !== endpoint);
  persistDb();
}

/** Fire-and-forget; dead subscriptions (410/404) are removed. */
function toAdmins(payload) { send((s) => s.who === 'admin', payload); }
/** Every browser/phone where this restaurant's owner switched alerts on. */
function toRestaurant(rid, payload) { send((s) => s.who === `rest:${rid}`, payload); }

function send(match, payload) {
  const subs = (inMemoryData.pushSubs || []).filter(match);
  if (!subs.length) return;
  try { setup(); } catch (_) { return; }
  for (const s of subs) {
    webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 }).catch((e) => {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) unsubscribe(s.endpoint);
    });
  }
}

module.exports = { publicKey, subscribe, unsubscribe, toAdmins, toRestaurant };
