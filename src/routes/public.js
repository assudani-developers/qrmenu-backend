/** Public, unauthenticated customer API (hosted menus + website). Everything is validated against server data. */
const express = require('express');
const crypto = require('crypto');
const { inMemoryData, findRestaurantBySlug, findRestaurantByShortId, persistDb } = require('../db');
const S = require('../services/saas');
const { calculateOrderBill } = require('../utils/calculator');
const { idempotency } = require('../middleware/idempotency');
const { orderLimiter, authLimiter } = require('../middleware/rateLimiter');
const RT = require('../services/realtime');

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const resolve = (slug) => findRestaurantBySlug(slug) || findRestaurantByShortId(slug) || null;

router.get('/menu/:slug', (req, res) => {
  const r = resolve(req.params.slug);
  if (!r) return bad(res, 'Menu not found', 404);
  const sub = S.subscriptionState(r);
  const live = S.isMenuLive(r);

  if (req.query.track === '1' && live) {
    const day = new Date().toISOString().slice(0, 10);
    r.totalScans = (r.totalScans || 0) + 1;
    r.scanDaily = r.scanDaily || {};
    r.scanDaily[day] = (r.scanDaily[day] || 0) + 1;
    persistDb();
  }

  res.setHeader('Cache-Control', 'no-cache');
  const f0 = sub.features;
  const theme = { ...r.theme, coverUrl: f0.coverImage ? r.theme.coverUrl : '', announcement: f0.announcement ? r.theme.announcement : '' };
  const base = {
    id: r.id, name: r.name, tagline: r.tagline, slug: r.slug, shortId: r.shortId, city: r.city, phone: r.phone, theme, live, status: sub.status,
    cuisine: r.cuisine, address: r.address, openingHours: r.openingHours, about: r.about, fssai: r.fssai,
    social: f0.socialLinks ? r.social : {},
    store: { open: r.store.open !== false, prepMinutes: r.store.prepMinutes || 0, wifiName: r.store.wifiName || '', wifiPassword: r.store.wifiPassword || '', takeaway: !!(f0.takeaway && r.store.takeaway !== false) },
  };
  if (!live) return res.json({ success: true, restaurant: base, categories: [], items: [], features: {} });

  const f = sub.features;
  res.json({
    success: true,
    restaurant: { ...base, googleReviewUrl: f.reviewInterceptor ? r.googleReviewUrl : '', tables: f.ordering || f.tableQr ? r.tables : [], taxPercent: r.taxPercent || 0 },
    categories: r.categories,
    sections: r.categories.map((c) => ({ name: c, open: S.categoryOpen(r, c), window: f.menuScheduling ? r.categorySchedule[c] || null : null })),
    items: r.items.map((i) => ({
      ...i,
      imageUrl: f.dishImages ? i.imageUrl : '',
      tags: f.dishBadges ? i.tags || [] : (i.tags || []).filter((t) => !['bestseller', 'chef', 'new', 'spicy'].includes(t)),
      offerPrice: f.offers && i.offerPrice > 0 && i.offerPrice < i.price ? i.offerPrice : null,
      addons: f.addons ? i.addons || [] : [],
    })),
    features: { ordering: !!f.ordering, removeBranding: !!f.removeBranding, reviewInterceptor: !!f.reviewInterceptor, serviceCalls: !!f.serviceCalls, reservations: !!f.reservations, takeaway: false },
  });
});

/** Place an order. Prices come from the server menu — the client only says WHAT and HOW MANY. */
router.post('/orders', orderLimiter, idempotency(), (req, res) => {
  const { slug, table, items, name, phone, notes, orderType = 'dine_in' } = req.body || {};
  const r = resolve(String(slug || ''));
  if (!r) return bad(res, 'Restaurant not found', 404);
  if (!S.isMenuLive(r)) return bad(res, 'This restaurant is not taking orders right now', 403);
  if (!S.subscriptionState(r).features.ordering) return bad(res, 'Online ordering is not available at this restaurant', 403);
  if (r.store.open === false) return bad(res, 'The kitchen is not taking orders right now. Please ask the staff.', 409);
  if (!Array.isArray(items) || !items.length || items.length > 40) return bad(res, 'Add at least one dish');
  const feats = S.subscriptionState(r).features;
  if (orderType === 'takeaway') return bad(res, 'This menu accepts dine-in table orders only', 403);
  const takeaway = false;
  const tableName = String(table || '').trim();
  if (!tableName) return bad(res, 'Please choose your table');
  if (!takeaway && r.tables.length && !r.tables.includes(tableName)) return bad(res, 'Unknown table');

  const lines = [];
  for (const it of items) {
    const d = r.items.find((x) => x.id === it.dishId);
    if (!d) return bad(res, 'A dish in your order no longer exists. Please refresh the menu.', 409);
    if (!d.isAvailable) return bad(res, `${d.name} just sold out`, 409);
    const v = it.variantId ? (d.variants || []).find((x) => x.id === it.variantId) : null;
    if (it.variantId && !v) return bad(res, 'Invalid portion size', 409);
    const qty = parseInt(it.qty, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) return bad(res, 'Invalid quantity');
    if (!S.categoryOpen(r, d.category)) return bad(res, `${d.category} is not being served right now`, 409);
    const mods = [];
    for (const aid of Array.isArray(it.addonIds) ? it.addonIds.slice(0, 10) : []) {
      const a = feats.addons ? (d.addons || []).find((x) => x.id === aid) : null;
      if (!a) return bad(res, 'An add-on you picked is no longer available. Please refresh.', 409);
      mods.push({ name: a.name, price: a.price });
    }
    lines.push({ dishId: d.id, name: v ? `${d.name} (${v.name})` : d.name, qty, price: S.effectivePrice(r, d, v), modifiers: mods, addons: mods.map((m) => m.name), notes: it.note ? String(it.note).slice(0, 120) : null });
  }
  const billing = calculateOrderBill({ items: lines, taxRatePercent: r.taxPercent || 0, discountPercent: 0 });

  r.orderSeq = (r.orderSeq || 0) + 1;
  const order = {
    id: `${r.shortId}-${r.orderSeq}`, token: r.orderSeq, trackKey: crypto.randomBytes(4).toString('hex'), restaurantId: r.id,
    tableNumber: tableName, customer: { name: String(name || '').trim().slice(0, 60) || 'Guest', phone: String(phone || '').trim().slice(0, 15) },
    status: 'pending', items: lines, billing, totalAmount: billing.grandTotal, customerNotes: notes ? String(notes).slice(0, 200) : null,
    orderType: 'dine_in', payment: { status: 'unpaid', method: null }, etaMinutes: r.store.prepMinutes || null,
    source: 'customer', createdAt: new Date().toISOString(),
  };
  inMemoryData.orders.unshift(order);
  // Auto-deplete inventory if restaurant has matching stock items
  if (Array.isArray(r.inventory) && r.inventory.length > 0) {
    for (const l of lines) {
      const match = r.inventory.find((inv) => inv.name.toLowerCase() === l.name.toLowerCase());
      if (match) {
        const oldStock = Number(match.stock || 0);
        match.stock = Math.max(0, oldStock - (l.qty || 1));
        r.inventoryLogs = r.inventoryLogs || [];
        r.inventoryLogs.unshift({
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          itemId: match.id,
          itemName: match.name,
          change: -(l.qty || 1),
          oldStock,
          newStock: match.stock,
          reason: `Auto-deducted for Order #${order.token}`,
          at: new Date().toISOString(),
        });
      }
    }
  }
  S.notify(r, { type: 'order', title: `New order #${order.token} · ${tableName}`, body: `${lines.reduce((n, l) => n + l.qty, 0)} items · ₹${order.totalAmount}`, data: { orderId: order.id } });
  persistDb();
  RT.orderNew(r, order);
  res.status(201).json({ success: true, order: { id: order.id, token: order.token, trackKey: order.trackKey, status: order.status, totalAmount: order.totalAmount, billing } });
});

/** Customer order tracker. */
router.get('/orders/:id/track', (req, res) => {
  const o = inMemoryData.orders.find((x) => x.id === req.params.id && x.trackKey === String(req.query.key || ''));
  if (!o) return bad(res, 'Order not found', 404);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ success: true, order: { id: o.id, token: o.token, status: o.status, tableNumber: o.tableNumber, orderType: o.orderType || 'dine_in', etaMinutes: o.etaMinutes || null, totalAmount: o.totalAmount, createdAt: o.createdAt, items: o.items.map((i) => ({ name: i.name, qty: i.qty, addons: i.addons || [] })) } });
});

/** Rating. Every guest can leave private feedback and optionally review the restaurant publicly. */
router.post('/feedback', orderLimiter, (req, res) => {
  const { slug, rating, message, tableNumber, name, phone } = req.body || {};
  const r = resolve(String(slug || ''));
  if (!r) return bad(res, 'Restaurant not found', 404);
  if (!S.subscriptionState(r).features.reviewInterceptor) return bad(res, 'Feedback is not enabled', 403);
  const n = parseInt(rating, 10);
  if (!(n >= 1 && n <= 5)) return bad(res, 'Rating must be 1 to 5');
  const fb = { id: `fb_${Date.now().toString(36)}`, restaurantId: r.id, customerName: String(name || '').trim().slice(0, 60) || 'Guest', phone: String(phone || '').slice(0, 15), tableNumber: tableNumber || '', rating: n, message: String(message || '').slice(0, 500), createdAt: new Date().toISOString() };
  inMemoryData.feedbacks.unshift(fb);
  if (n <= 3) S.notify(r, { type: 'feedback', title: `${n}★ private feedback`, body: fb.message || 'No comment left', data: { feedbackId: fb.id } });
  persistDb();
  res.status(201).json({ success: true, googleReviewUrl: r.googleReviewUrl || null });
});

/** Guest at a table: call a waiter, ask for the bill, or ask for water. Arrives on the owner's phone instantly. */
const CALL_TYPES = { waiter: 'Calling a waiter', bill: 'Asking for the bill', water: 'Asking for water', cleaning: 'Table needs cleaning' };
router.post('/service-calls', orderLimiter, (req, res) => {
  const { slug, table, type = 'waiter', note } = req.body || {};
  const r = resolve(String(slug || ''));
  if (!r) return bad(res, 'Restaurant not found', 404);
  if (!S.isMenuLive(r) || !S.subscriptionState(r).features.serviceCalls) return bad(res, 'This restaurant does not take table requests', 403);
  if (!CALL_TYPES[type]) return bad(res, 'Unknown request');
  const t = String(table || '').trim();
  if (!t || (r.tables.length && !r.tables.includes(t))) return bad(res, 'Scan the QR on your table to call the staff');
  // de-duplicate: same table + type within 2 minutes just refreshes the existing call
  const dup = r.serviceCalls.find((c) => c.status === 'open' && c.table === t && c.type === type && Date.now() - new Date(c.createdAt).getTime() < 120000);
  if (dup) return res.json({ success: true, call: { id: dup.id, status: dup.status } });
  const call = { id: `sc_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, table: t, type, label: CALL_TYPES[type], note: String(note || '').slice(0, 120), status: 'open', createdAt: new Date().toISOString() };
  r.serviceCalls.unshift(call);
  if (r.serviceCalls.length > 200) r.serviceCalls.length = 200;
  S.notify(r, { type: 'service', title: `${t} · ${call.label}`, body: call.note || 'Tap to mark as attended', data: { callId: call.id } });
  persistDb();
  RT.toRestaurant(r.id, 'service:new', { call });
  res.status(201).json({ success: true, call: { id: call.id, status: call.status } });
});

/** Table booking request from the hosted menu (Elite). */
router.post('/reservations', orderLimiter, (req, res) => {
  const { slug, name, phone, date, time, guests, notes } = req.body || {};
  const r = resolve(String(slug || ''));
  if (!r) return bad(res, 'Restaurant not found', 404);
  if (!S.isMenuLive(r) || !S.subscriptionState(r).features.reservations) return bad(res, 'Bookings are not available here', 403);
  if (!String(name || '').trim()) return bad(res, 'Please add your name');
  if (!/^\+?[0-9 ]{10,15}$/.test(String(phone || ''))) return bad(res, 'Please add a valid mobile number');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || S.toMin(time) == null) return bad(res, 'Please pick a date and time');
  const when = new Date(`${date}T${time}:00+05:30`);
  if (isNaN(when) || when.getTime() < Date.now() - 15 * 60000) return bad(res, 'Please pick a time in the future');
  const n = parseInt(guests, 10);
  if (!(n >= 1 && n <= 50)) return bad(res, 'Number of guests should be 1 to 50');
  const b = { id: `rv_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, name: String(name).trim().slice(0, 60), phone: String(phone).trim(), date, time, guests: n, notes: String(notes || '').slice(0, 200), status: 'pending', createdAt: new Date().toISOString() };
  r.reservations.unshift(b);
  if (r.reservations.length > 500) r.reservations.length = 500;
  S.notify(r, { type: 'reservation', title: `Booking request · ${n} guests`, body: `${b.name} · ${date} ${time}`, data: { reservationId: b.id } });
  persistDb();
  RT.toRestaurant(r.id, 'reservation:new', { reservation: b });
  res.status(201).json({ success: true, reservation: { id: b.id, status: b.status } });
});

/** Website "Request a demo" form. */
router.post('/leads', authLimiter, (req, res) => {
  const { restaurantName, ownerName, phone, city, planPreference, notes } = req.body || {};
  if (!restaurantName || !/^\+?[0-9 ]{10,15}$/.test(String(phone || ''))) return bad(res, 'Restaurant name and a valid phone number are required');
  const lead = {
    id: `lead_${Date.now().toString(36)}`, restaurantName: String(restaurantName).trim().slice(0, 80), ownerName: String(ownerName || '').trim().slice(0, 60),
    phone: String(phone).trim(), city: String(city || '').trim().slice(0, 60), planPreference: S.getPlans()[planPreference] ? planPreference : '', notes: String(notes || '').slice(0, 400),
    status: 'new', createdAt: new Date().toISOString(),
  };
  inMemoryData.leads.unshift(lead);
  persistDb();
  res.status(201).json({ success: true, message: 'Thanks! We will contact you shortly.' });
});

router.get('/health', (req, res) => res.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()), time: new Date().toISOString() }));

module.exports = router;
