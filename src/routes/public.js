/** Public, unauthenticated customer API (hosted menus + website). Everything is validated against server data. */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const { inMemoryData, findRestaurantBySlug, findRestaurantByShortId, persistDb, withTableLock } = require('../db');
const S = require('../services/saas');
const { calculateOrderBill } = require('../utils/calculator');
const { idempotency } = require('../middleware/idempotency');
const { orderLimiter, authLimiter } = require('../middleware/rateLimiter');
const RT = require('../services/realtime');
const ImageVault = require('../services/imageVault');

const uploadDir = path.join(__dirname, '../../uploads');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const resolve = (slug) => findRestaurantBySlug(slug) || findRestaurantByShortId(slug) || findRestaurantByShortId(String(slug).toUpperCase()) || null;

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
  const tpl = S.effectiveTemplate(r, sub.features); // a lower plan shows its own design; the saved choice comes back on upgrade
  const theme = { ...r.theme, template: tpl.id, qrTheme: S.effectiveQrTheme(r, sub.features), coverUrl: f0.coverImage ? r.theme.coverUrl : '', announcement: f0.announcement ? r.theme.announcement : '' };
  const brand = { name: inMemoryData.adminConfig.settings.brandName || 'QR Menu Pro', url: S.menuBaseUrl() };
  const base = {
    id: r.id, name: r.name, tagline: r.tagline, slug: r.slug, shortId: r.shortId, city: r.city, phone: r.phone, theme, live, status: sub.status,
    cuisine: r.cuisine, address: r.address, openingHours: r.openingHours, about: r.about, fssai: r.fssai, template: tpl, brand,
    social: f0.socialLinks ? r.social : {},
    store: { open: r.store.open !== false, prepMinutes: r.store.prepMinutes || 0, wifiName: r.store.wifiName || '', wifiPassword: r.store.wifiPassword || '', takeaway: false },
  };
  if (!live) return res.json({ success: true, restaurant: base, categories: [], items: [], features: {} });

  const f = sub.features;
  res.json({
    success: true,
    restaurant: { ...base, googleReviewUrl: f.reviewInterceptor ? r.googleReviewUrl : '', tables: f.ordering ? (r.tables || []).slice(0, f.maxTables || 0) : [], taxPercent: r.taxPercent || 0 },
    categories: r.categories,
    sections: r.categories.map((c) => ({ name: c, open: S.categoryOpen(r, c), window: f.menuScheduling ? r.categorySchedule[c] || null : null })),
    items: r.items.map((i) => ({
      ...i,
      images: (i.images || (i.imageUrl ? [i.imageUrl] : [])).slice(0, f.photosPerDish || 0),
      imageUrl: (f.photosPerDish || 0) > 0 ? (i.images || [])[0] || i.imageUrl || '' : '',
      tags: f.dishBadges ? i.tags || [] : (i.tags || []).filter((t) => !['bestseller', 'chef', 'new', 'spicy'].includes(t)),
      offerPrice: f.offers && i.offerPrice > 0 && i.offerPrice < i.price ? i.offerPrice : null,
      addons: f.addons ? i.addons || [] : [],
    })),
    features: { ordering: !!f.ordering, removeBranding: !!f.removeBranding, reviewInterceptor: !!f.reviewInterceptor, serviceCalls: !!f.serviceCalls, reservations: !!f.reservations, takeaway: false },
  });
});

/** Place an order. Prices come from the server menu — the client only says WHAT and HOW MANY. */
router.post('/orders', orderLimiter, idempotency(), async (req, res) => {
  const { slug, table, items, name, phone, notes, orderType = 'dine_in', guestId } = req.body || {};
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
  if (!tableName) return bad(res, 'Please choose or enter your table number');
  if (tableName.length > 30) return bad(res, 'Table name must be under 30 characters');

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

  const order = await withTableLock(`${r.id}_${tableName}`, async () => {
    r.orderSeq = (r.orderSeq || 0) + 1;
    const o = {
      id: `${r.shortId}-${r.orderSeq}`, token: r.orderSeq, trackKey: crypto.randomBytes(4).toString('hex'), restaurantId: r.id,
      guestId: String(guestId || '').slice(0, 80),
      tableNumber: tableName, customer: { name: String(name || '').trim().slice(0, 60) || 'Guest', phone: String(phone || '').trim().slice(0, 15) },
      status: 'pending', items: lines, billing, totalAmount: billing.grandTotal, customerNotes: notes ? String(notes).slice(0, 200) : null,
      orderType: 'dine_in', payment: { status: 'unpaid', method: null }, etaMinutes: r.store.prepMinutes || null,
      source: 'customer', createdAt: new Date().toISOString(),
    };
    inMemoryData.orders.unshift(o);
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
            reason: `Auto-deducted for Order #${o.token}`,
            at: new Date().toISOString(),
          });
        }
      }
    }
    S.notify(r, { type: 'order', title: `New order #${o.token} · ${tableName}`, body: `${lines.reduce((n, l) => n + l.qty, 0)} items · ₹${o.totalAmount}`, data: { orderId: o.id } });
    persistDb();
    RT.orderNew(r, o);
    return o;
  });

  res.status(201).json({ success: true, order: { id: order.id, token: order.token, trackKey: order.trackKey, status: order.status, totalAmount: order.totalAmount, billing } });
});

/** Customer order tracker. */
router.get('/orders/:id/track', (req, res) => {
  const o = inMemoryData.orders.find((x) => x.id === req.params.id && x.trackKey === String(req.query.key || ''));
  if (!o) return bad(res, 'Order not found', 404);
  const r = inMemoryData.restaurants.find((x) => x.id === o.restaurantId);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    success: true,
    order: {
      id: o.id,
      token: o.token,
      status: o.status,
      tableNumber: o.tableNumber,
      orderType: o.orderType || 'dine_in',
      etaMinutes: o.etaMinutes || null,
      totalAmount: o.totalAmount,
      billing: o.billing,
      payment: o.payment || { status: 'unpaid', method: null },
      restaurantName: r?.name || '',
      restaurantAddress: r?.address || '',
      gstin: r?.gstin || '',
      createdAt: o.createdAt,
      items: o.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price, addons: i.addons || [] })),
    },
  });
});

/** Guest device past orders for this restaurant. */
router.get('/orders/guest/:guestId', (req, res) => {
  const gid = String(req.params.guestId || '').trim();
  const slug = String(req.query.slug || '').trim();
  const r = resolve(slug);
  if (!gid || !r) return res.json({ success: true, orders: [] });
  const mine = inMemoryData.orders
    .filter((o) => o.restaurantId === r.id && o.guestId === gid)
    .slice(0, 50)
    .map((o) => ({
      id: o.id,
      token: o.token,
      trackKey: o.trackKey,
      status: o.status,
      tableNumber: o.tableNumber,
      totalAmount: o.totalAmount,
      payment: o.payment || { status: 'unpaid', method: null },
      createdAt: o.createdAt,
      items: o.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
    }));
  res.json({ success: true, orders: mine });
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

/* =================== website checkout (no gateway: UPI + reference, admin verifies) =================== */
const checkout = (id) => (inMemoryData.checkouts || []).find((c) => c.id === id && new Date(c.expiresAt).getTime() > Date.now());
const maskPhone = (p) => String(p || '').replace(/\s/g, '').replace(/^(.*)(\d{4})$/, (m, a, b) => a.replace(/\d/g, '•') + b);
function payView(co) {
  const r = inMemoryData.restaurants.find((x) => x.id === co.restaurantId);
  if (!r) return null;
  const sub = S.subscriptionState(r);
  const c = inMemoryData.adminConfig;
  const pay = inMemoryData.payments.find((p) => p.checkoutId === co.id) || null;
  return {
    id: co.id, plan: co.plan, expiresAt: co.expiresAt,
    restaurant: { name: r.name, ownerName: r.ownerName, phone: maskPhone(r.phone), shortId: r.shortId, city: r.city },
    subscription: { status: sub.status, plan: sub.plan, planName: sub.planName, daysLeft: sub.daysLeft, endsAt: sub.endsAt, trialEndsAt: r.subscription.trialEndsAt },
    plans: S.planOrder().map((id) => { const p = S.getPlans()[id]; return { id, name: p.name, price: p.price, tagline: p.tagline, popular: !!p.popular, badge: p.badge || '' }; }),
    payee: {
      upiId: c.adminUpiId || '9413879444@yespop',
      name: c.payeeName || 'PIYUSH ASSUDANI',
      qrImage: '/images/payment_qr.png',
      cardImage: '/images/payment_card.png',
    },
    brandName: c.settings.brandName || 'QR Menu Pro', trialDays: c.settings.trialDays,
    payment: pay && { id: pay.id, status: pay.status, amount: pay.amount, listPrice: pay.listPrice, coupon: pay.coupon, discount: pay.discount || 0, planId: pay.planId, utrRef: pay.utrRef, screenshotUrl: pay.screenshotUrl || null, date: pay.date, verifiedAt: pay.verifiedAt || null, paidUntil: pay.expiryExtendedTo || null, credit: pay.credit || 0, creditPlan: pay.creditPlan || null, autoApproved: pay.verifiedBy === 'auto' },
    current: { plan: r.subscription.plan, paidUntil: r.subscription.paidUntil || null },
  };
}

/** Upload payment confirmation screenshot */
router.post('/pay/upload-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return bad(res, 'No screenshot image provided', 400);
  try {
    const filename = `pay_ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.webp`;
    await sharp(req.file.buffer)
      .rotate()
      .resize(1400, 2000, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(path.join(uploadDir, filename));
    ImageVault.preserveFile(filename);
    const origin = process.env.PUBLIC_API_URL || 'https://qrmenu.piyushassudani.in';
    const url = `${origin.replace(/\/$/, '')}/uploads/${filename}`;
    res.json({ success: true, url, filename });
  } catch (err) {
    bad(res, 'Could not process screenshot: ' + err.message, 422);
  }
});

router.get('/pay/:id', (req, res) => {
  const co = checkout(req.params.id);
  if (!co) return bad(res, 'This payment link has expired. Open the app and tap Renew again.', 404);
  const v = payView(co);
  if (!v) return bad(res, 'Restaurant not found', 404);
  if (v.payment && v.payment.status === 'verified') {
    return res.status(404).json({
      success: false,
      settled: true,
      message: 'This bill has already been settled and your plan is active. Please open the app to continue.',
      redirectUrl: '/app/',
      restaurant: v.restaurant,
      payment: v.payment,
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, ...v });
});
router.post('/pay/:id/quote', orderLimiter, (req, res) => {
  const co = checkout(req.params.id);
  if (!co) return bad(res, 'This payment link has expired', 404);
  const { plan, coupon } = req.body || {};
  const q = S.quoteFor(inMemoryData.restaurants.find((x) => x.id === co.restaurantId), plan || co.plan, coupon);
  if (!q.ok) return bad(res, q.error);
  res.json({ success: true, ...q });
});
/** Trial-extension coupons apply instantly — no payment needed. */
router.post('/pay/:id/trial-coupon', orderLimiter, (req, res) => {
  const co = checkout(req.params.id);
  if (!co) return bad(res, 'This payment link has expired', 404);
  const r = inMemoryData.restaurants.find((x) => x.id === co.restaurantId);
  const { plan, coupon } = req.body || {};
  const q = S.priceWithCoupon(plan || co.plan, coupon);
  if (!q.ok) return bad(res, q.error);
  if (!q.coupon || q.coupon.type !== 'trial_days') return bad(res, 'This coupon is a discount — apply it to your payment instead');
  if (S.subscriptionState(r).status === 'active') return bad(res, 'Bonus trial days apply only before your first payment');
  S.findCoupon(coupon).used += 1;
  const base = Math.max(Date.now(), new Date(r.subscription.trialEndsAt || Date.now()).getTime());
  Object.assign(r.subscription, { status: 'trial', plan: plan || co.plan, trialEndsAt: new Date(base + q.extraTrialDays * S.DAY).toISOString() });
  r.currentPlan = r.plan = r.subscription.plan;
  S.notify(r, { type: 'payment', title: `${q.extraTrialDays} bonus trial days added`, body: `Coupon ${q.coupon.code} applied. Your trial now ends ${new Date(r.subscription.trialEndsAt).toLocaleDateString('en-IN')}.` });
  persistDb();
  RT.subscription(r, { event: 'trial_extended' });
  res.json({ success: true, ...payView(co) });
});
/**
 * "I have paid". UTR and screenshot are both optional. A screenshot that clearly shows our payee, the exact amount,
 * success and today's date/time is approved on the spot; everything else waits for the admin.
 */
router.post('/pay/:id/submit', orderLimiter, async (req, res) => {
  const co = checkout(req.params.id);
  if (!co) return bad(res, 'This payment link has expired', 404);
  const r = inMemoryData.restaurants.find((x) => x.id === co.restaurantId);
  if (!r) return bad(res, 'Restaurant not found', 404);
  const { plan, coupon, utr, screenshotUrl, fraudAck } = req.body || {};
  if (!fraudAck) return bad(res, 'Please confirm the fraud notice first');
  const ref = String(utr || '').replace(/\s/g, '');
  if (ref && !/^[A-Za-z0-9]{10,24}$/.test(ref)) return bad(res, 'That UPI reference looks wrong. It is usually 12 digits. You can also leave it empty.');
  const q = S.quoteFor(r, plan || co.plan, coupon);
  if (!q.ok) return bad(res, q.error);
  if (q.coupon && q.coupon.type === 'trial_days') return bad(res, 'Trial coupons do not need a payment — tap Apply instead');
  if (ref && inMemoryData.payments.some((p) => p.utrRef === ref)) return bad(res, 'This reference was already submitted', 409);
  const existing = inMemoryData.payments.find((p) => p.checkoutId === co.id && p.status === 'pending');
  if (existing) return bad(res, 'Your payment is already waiting for verification', 409);
  // screenshot must be one we stored for this kind of upload
  const ssName = screenshotUrl ? path.basename(String(screenshotUrl)) : '';
  const ssFile = /^pay_ss_[a-z0-9_]+\.webp$/.test(ssName) ? path.join(uploadDir, ssName) : '';
  const couponObj = q.coupon ? S.findCoupon(coupon) : null;
  if (couponObj) couponObj.used += 1;
  const cfg = inMemoryData.adminConfig;
  const tx = {
    id: `TXN-${Date.now().toString(36).toUpperCase()}`, checkoutId: co.id, restaurantId: r.id, restaurantName: r.name, ownerName: r.ownerName,
    phone: r.phone, planId: plan || co.plan, amount: q.final, listPrice: q.original, discount: q.discount, coupon: q.coupon ? q.coupon.code : null,
    credit: q.credit || 0, creditPlan: q.creditPlan || null, upgrade: !!q.upgrade,
    referredBySubAdmin: couponObj?.createdBy && couponObj.createdBy !== 'superadmin' ? couponObj.createdBy : null,
    subAdminName: couponObj?.createdByName && couponObj.createdByName !== 'Super Admin' ? couponObj.createdByName : null,
    method: 'UPI', utrRef: ref || '', screenshotUrl: ssFile ? screenshotUrl : null, payeeUpi: cfg.adminUpiId || '', status: 'pending', source: 'website', date: new Date().toISOString(), fraudAckAt: new Date().toISOString(),
  };
  // instant check of the screenshot
  if (ssFile && require('fs').existsSync(ssFile)) {
    try {
      const proof = await require('../services/payProof').check(ssFile, {
        amount: tx.amount, payeeName: cfg.payeeName || '', upiId: cfg.adminUpiId || '',
        usedHashes: new Set(inMemoryData.payments.map((p) => p.screenshotHash).filter(Boolean)),
        usedUtrs: new Set(inMemoryData.payments.map((p) => p.utrRef).filter(Boolean)),
      });
      tx.screenshotHash = proof.hash;
      tx.autoCheck = { ok: proof.ok, reasons: proof.reasons, at: new Date().toISOString() };
      if (!tx.utrRef && proof.utr && !inMemoryData.payments.some((p) => p.utrRef === proof.utr)) tx.utrRef = proof.utr;
      if (proof.ok && tx.amount > 0) S.activatePayment(tx, r, { auto: true });
    } catch (e) { tx.autoCheck = { ok: false, reasons: [`Check failed: ${e.message}`] }; }
  }
  inMemoryData.payments.unshift(tx);
  const auto = tx.status === 'verified';
  if (!auto && r.subscription.status !== 'active') r.subscription.pendingPaymentId = tx.id;
  const planName = (S.getPlans()[tx.planId] || { name: tx.planId }).name;
  require('../db').recordActivity('payment', auto ? 'Payment auto-approved' : 'Payment submitted', `${r.name} paid ₹${tx.amount} for ${planName}.${auto ? ' Screenshot matched, approved instantly.' : ' Awaiting verification.'}`);
  S.notify(r, auto
    ? { type: 'payment', title: `${planName} is active`, body: `₹${tx.amount} received. Active till ${new Date(r.subscription.paidUntil).toLocaleDateString('en-IN')}.` }
    : { type: 'payment', title: 'Payment received · verifying', body: `₹${tx.amount}${tx.utrRef ? ` with reference ${tx.utrRef}` : ''}. Your plan activates once we confirm it.` });
  persistDb();
  RT.toAdmin('payment:new', { payment: tx });
  RT.subscription(r, { event: auto ? 'payment_verified' : 'payment_submitted', payment: tx });
  require('../services/push').toAdmins({ title: `${auto ? 'Auto-approved' : 'New payment'} ₹${tx.amount}`, body: `${r.name} · ${planName}${tx.utrRef ? ` · UTR ${tx.utrRef}` : ''}${auto ? ' · check later' : ''}`, url: '/dashboard/payments' });
  if (r.email) {
    const mailer = require('../services/mailer');
    (auto
      ? mailer.sendPaymentReceiptEmail({ to: r.email, restaurantName: r.name, amount: tx.amount, originalPrice: tx.listPrice, discount: (tx.discount || 0) + (tx.credit || 0), couponCode: tx.coupon, planName, utrRef: tx.utrRef || '—', validUntil: r.subscription.paidUntil, invoiceId: tx.id, websiteUrl: S.menuBaseUrl() })
      : mailer.sendPaymentSubmittedEmail({ to: r.email, restaurantName: r.name, amount: tx.amount, planName, utrRef: tx.utrRef || '—' })
    ).catch((err) => console.error('[Mailer:PayErr]', err.message));
  }
  res.json({ success: true, autoApproved: auto, ...payView(co) });
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
