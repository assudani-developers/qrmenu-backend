/**
 * Day-to-day restaurant operations for the owner app (mounted inside /api/owner after ownerAuth):
 * store open/closed + prep time + WiFi, order payments & bills, service calls, table bookings,
 * timed menu sections, customer list (CRM) and sales reports.
 */
const express = require('express');
const { inMemoryData, persistDb } = require('../db');
const S = require('../services/saas');
const RT = require('../services/realtime');

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const feat = (req) => S.subscriptionState(req.rest).features;
const mine = (req) => inMemoryData.orders.filter((o) => o.restaurantId === req.rest.id);

/* ---------- store controls ---------- */
router.patch('/store', (req, res) => {
  const r = req.rest;
  const b = req.body || {};
  if (typeof b.open === 'boolean') r.store.open = b.open;
  if (b.prepMinutes !== undefined) {
    const n = parseInt(b.prepMinutes, 10);
    if (!(n >= 0 && n <= 180)) return bad(res, 'Prep time should be 0 to 180 minutes');
    r.store.prepMinutes = n;
  }
  if (typeof b.takeaway === 'boolean') {
    if (b.takeaway) return bad(res, 'Takeaway orders are not available yet');
    r.store.takeaway = b.takeaway;
  }
  for (const k of ['wifiName', 'wifiPassword']) if (typeof b[k] === 'string') r.store[k] = b[k].trim().slice(0, 64);
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true, store: r.store });
});

/* ---------- order payment & bill ---------- */
router.patch('/orders/:oid/payment', (req, res) => {
  const o = inMemoryData.orders.find((x) => x.id === req.params.oid && x.restaurantId === req.rest.id);
  if (!o) return bad(res, 'Order not found', 404);
  const { status, method } = req.body || {};
  if (!['paid', 'unpaid'].includes(status)) return bad(res, 'Status must be paid or unpaid');
  if (status === 'paid' && !['cash', 'upi', 'card'].includes(method)) return bad(res, 'Choose cash, UPI or card');
  o.payment = { status, method: status === 'paid' ? method : null, at: status === 'paid' ? new Date().toISOString() : null };
  persistDb();
  RT.orderUpdate(o);
  res.json({ success: true, order: o });
});

/* ---------- service calls (waiter / bill / water) ---------- */
router.get('/service-calls', (req, res) => {
  const list = req.rest.serviceCalls.slice(0, 100);
  res.json({ success: true, calls: list, open: list.filter((c) => c.status === 'open').length });
});
router.patch('/service-calls/:id', (req, res) => {
  const c = req.rest.serviceCalls.find((x) => x.id === req.params.id);
  if (!c) return bad(res, 'Request not found', 404);
  c.status = 'done';
  c.doneAt = new Date().toISOString();
  persistDb();
  RT.toRestaurant(req.rest.id, 'service:update', { call: c });
  res.json({ success: true, call: c });
});
router.post('/service-calls/clear', (req, res) => {
  req.rest.serviceCalls.forEach((c) => { if (c.status === 'open') { c.status = 'done'; c.doneAt = new Date().toISOString(); } });
  persistDb();
  RT.toRestaurant(req.rest.id, 'service:update', {});
  res.json({ success: true });
});

/* ---------- table bookings ---------- */
router.get('/reservations', (req, res) => {
  if (!feat(req).reservations) return S.planBlocked(res, 'reservations', 'Table bookings from your menu are on the Ultra plan');
  res.json({ success: true, reservations: req.rest.reservations.slice(0, 300) });
});
router.patch('/reservations/:id', (req, res) => {
  if (!feat(req).reservations) return S.planBlocked(res, 'reservations');
  const b = req.rest.reservations.find((x) => x.id === req.params.id);
  if (!b) return bad(res, 'Booking not found', 404);
  const { status } = req.body || {};
  if (!['confirmed', 'declined', 'seated', 'no_show'].includes(status)) return bad(res, 'Unknown status');
  b.status = status;
  b.updatedAt = new Date().toISOString();
  persistDb();
  RT.toRestaurant(req.rest.id, 'reservation:update', { reservation: b });
  res.json({ success: true, reservation: b });
});

/* ---------- timed menu sections ---------- */
router.put('/menu/schedule', (req, res) => {
  if (!feat(req).menuScheduling) return S.planBlocked(res, 'menuScheduling', 'Timed sections (breakfast, lunch, late night) are on the Ultra plan');
  const r = req.rest;
  const sched = (req.body || {}).schedule || {};
  const next = {};
  for (const [cat, w] of Object.entries(sched)) {
    if (!r.categories.includes(cat)) continue;
    if (!w || (!w.from && !w.to)) continue; // cleared = always available
    if (S.toMin(w.from) == null || S.toMin(w.to) == null) return bad(res, `Times for ${cat} should look like 07:00`);
    next[cat] = { from: w.from, to: w.to };
  }
  r.categorySchedule = next;
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true, schedule: next });
});

/* ---------- customers (CRM) ---------- */
function customers(req) {
  const map = new Map();
  for (const o of mine(req)) {
    const phone = String(o.customer?.phone || '').replace(/\D/g, '').slice(-10);
    if (phone.length < 10 || o.status === 'cancelled') continue;
    const c = map.get(phone) || { phone, name: o.customer.name || 'Guest', visits: 0, spend: 0, firstAt: o.createdAt, lastAt: o.createdAt, favourites: {} };
    c.visits += 1;
    c.spend += o.totalAmount || 0;
    if (o.customer.name && o.customer.name !== 'Guest') c.name = o.customer.name;
    if (o.createdAt < c.firstAt) c.firstAt = o.createdAt;
    if (o.createdAt > c.lastAt) c.lastAt = o.createdAt;
    for (const l of o.items) c.favourites[l.name] = (c.favourites[l.name] || 0) + l.qty;
    map.set(phone, c);
  }
  return [...map.values()]
    .map((c) => ({ ...c, spend: Math.round(c.spend), favourite: Object.entries(c.favourites).sort((a, b) => b[1] - a[1])[0]?.[0] || '', favourites: undefined }))
    .sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));
}
router.get('/customers', (req, res) => {
  if (!feat(req).customers) return S.planBlocked(res, 'customers', 'Your customer list is on Growth and Ultra');
  const list = customers(req);
  res.json({ success: true, customers: list, total: list.length, repeat: list.filter((c) => c.visits > 1).length });
});
router.get('/customers.csv', (req, res) => {
  if (!feat(req).customers) return S.planBlocked(res, 'customers');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Name', 'Phone', 'Visits', 'Total spend', 'Favourite dish', 'First visit', 'Last visit'], ...customers(req).map((c) => [c.name, c.phone, c.visits, c.spend, c.favourite, c.firstAt.slice(0, 10), c.lastAt.slice(0, 10)])];
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.send(rows.map((r) => r.map(esc).join(',')).join('\n'));
});

/* ---------- sales reports ---------- */
const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
const istHour = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).getUTCHours();
router.get('/reports', (req, res) => {
  if (!feat(req).analytics) return S.planBlocked(res, 'analytics', 'Sales reports are on Growth and Ultra');
  const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
  const since = Date.now() - days * S.DAY;
  const all = mine(req).filter((o) => new Date(o.createdAt).getTime() >= since);
  const done = all.filter((o) => o.status !== 'cancelled');
  const revenue = done.reduce((n, o) => n + (o.totalAmount || 0), 0);
  const daily = {};
  for (let i = days - 1; i >= 0; i--) daily[istDay(new Date(Date.now() - i * S.DAY).toISOString())] = { revenue: 0, orders: 0 };
  const hours = Array.from({ length: 24 }, () => 0);
  const dishes = {};
  const pay = { cash: 0, upi: 0, card: 0, unpaid: 0 };
  const types = { dine_in: 0, takeaway: 0 };
  for (const o of done) {
    const d = daily[istDay(o.createdAt)];
    if (d) { d.revenue += o.totalAmount || 0; d.orders += 1; }
    hours[istHour(o.createdAt)] += 1;
    for (const l of o.items) {
      const k = l.name;
      dishes[k] = dishes[k] || { name: k, qty: 0, revenue: 0 };
      dishes[k].qty += l.qty;
      dishes[k].revenue += l.qty * ((l.price || 0) + (l.modifiers || []).reduce((n, m) => n + (m.price || 0), 0));
    }
    const p = o.payment?.status === 'paid' ? o.payment.method : 'unpaid';
    pay[p] = (pay[p] || 0) + (o.totalAmount || 0);
    types[o.orderType === 'takeaway' ? 'takeaway' : 'dine_in'] += 1;
  }
  const peak = hours.indexOf(Math.max(...hours));
  res.json({
    success: true,
    range: days,
    revenue: Math.round(revenue),
    orders: done.length,
    cancelled: all.length - done.length,
    avgOrder: done.length ? Math.round(revenue / done.length) : 0,
    daily: Object.entries(daily).map(([date, v]) => ({ date, revenue: Math.round(v.revenue), orders: v.orders })),
    hours,
    peakHour: done.length ? peak : null,
    topDishes: Object.values(dishes).sort((a, b) => b.qty - a.qty).slice(0, 8).map((d) => ({ ...d, revenue: Math.round(d.revenue) })),
    payments: Object.fromEntries(Object.entries(pay).map(([k, v]) => [k, Math.round(v)])),
    orderTypes: types,
    serviceCalls: req.rest.serviceCalls.filter((c) => new Date(c.createdAt).getTime() >= since).length,
  });
});
router.get('/reports.csv', (req, res) => {
  if (!feat(req).analytics) return S.planBlocked(res, 'analytics');
  const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
  const since = Date.now() - days * S.DAY;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Order', 'Token', 'Date', 'Type', 'Table', 'Customer', 'Phone', 'Items', 'Total', 'Status', 'Payment']];
  for (const o of mine(req).filter((x) => new Date(x.createdAt).getTime() >= since)) {
    rows.push([o.id, o.token, new Date(o.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), o.orderType || 'dine_in', o.tableNumber, o.customer?.name, o.customer?.phone, o.items.map((l) => `${l.qty}x ${l.name}`).join('; '), o.totalAmount, o.status, o.payment?.status === 'paid' ? o.payment.method : 'unpaid']);
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.send(rows.map((r) => r.map(esc).join(',')).join('\n'));
});

module.exports = router;
