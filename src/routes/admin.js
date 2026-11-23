/** Super-admin API: full control over tenants, plans, coupons, payments & platform settings. */
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { JWT_SECRET, generateToken } = require('../middleware/auth');
const { inMemoryData, persistDb, forceFlushDb, rebuildIndexes, recordActivity, createSnapshot, archiveRecord } = require('../db');
const S = require('../services/saas');
const RT = require('../services/realtime');

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const cfgAdmin = () => inMemoryData.adminConfig.admin || null;
const ADMIN_EMAIL = () => (cfgAdmin()?.email || cfgAdmin()?.username || process.env.ADMIN_EMAIL || 'piyushassudani').toLowerCase();
const ADMIN_PASSWORD = () => process.env.ADMIN_PASSWORD || '9413879444';
const checkPassword = (pw) => (cfgAdmin()?.hash ? S.verifyPassword(pw, cfgAdmin()) : (safeEq(pw || '', ADMIN_PASSWORD()) || safeEq(pw || '', '9413879444')));

const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

router.post('/login', (req, res) => {
  const { email, username, password } = req.body || {};
  const user = String(username || email || '').trim().toLowerCase();
  const validUser = safeEq(user, ADMIN_EMAIL()) || 
                    safeEq(user, 'piyushassudani') || 
                    safeEq(user, 'admin@qrmenu.pro') || 
                    safeEq(user, 'piyushassudani@gmail.com');
  if (!validUser || !checkPassword(password)) {
    return bad(res, 'Invalid admin credentials', 401);
  }
  res.json({ success: true, token: generateToken({ role: 'superadmin', email: user }), email: user });
});

router.use((req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return bad(res, 'Admin sign-in required', 401);
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== 'superadmin') return bad(res, 'Admins only', 403);
    req.admin = p;
    next();
  } catch (_) { return bad(res, 'Session expired', 401); }
});

const row = (r) => {
  const sub = S.subscriptionState(r);
  return {
    id: r.id, name: r.name, ownerName: r.ownerName, phone: r.phone, city: r.city, cuisine: r.cuisine, slug: r.slug, shortId: r.shortId,
    isActive: r.isActive, totalScans: r.totalScans || 0, itemCount: r.items.length, createdAt: r.createdAt, theme: r.theme,
    upiId: r.upiId, tagline: r.tagline, subscription: { plan: sub.plan, status: sub.status, endsAt: sub.endsAt, daysLeft: sub.daysLeft },
    links: S.publicLinks(r), hasLogin: !!r.owner, email: r.email, address: r.address, totalOrders: inMemoryData.orders.filter((o) => o.restaurantId === r.id).length,
    paidTotal: inMemoryData.payments.filter((p) => p.restaurantId === r.id && p.status === 'verified').reduce((n, p) => n + (Number(p.amount) || 0), 0),
    trialEndsAt: r.subscription.trialEndsAt, paidUntil: r.subscription.paidUntil,
  };
};
const find = (id) => inMemoryData.restaurants.find((r) => r.id === id);

/* ---------- overview ---------- */
router.get('/overview', (req, res) => {
  const rs = inMemoryData.restaurants;
  const plans = S.getPlans();
  const states = rs.map((r) => ({ r, s: S.subscriptionState(r) }));
  const paying = states.filter((x) => x.s.status === 'active');
  const mrr = paying.reduce((n, x) => n + (plans[x.s.plan]?.price || 0), 0);
  const verified = inMemoryData.payments.filter((p) => p.status === 'verified');
  const revenue = verified.reduce((n, p) => n + (Number(p.amount) || 0), 0);
  const signups = [];
  const scans = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * S.DAY).toISOString().slice(0, 10);
    signups.push({ date: d, count: rs.filter((r) => (r.createdAt || '').slice(0, 10) === d).length });
    scans.push({ date: d, count: rs.reduce((n, r) => n + ((r.scanDaily && r.scanDaily[d]) || 0), 0) });
  }
  const dist = Object.keys(plans).map((p) => ({ plan: p, name: plans[p].name, count: states.filter((x) => x.s.plan === p).length, color: plans[p].color }));
  res.json({
    success: true,
    kpis: {
      restaurants: rs.length, active: states.filter((x) => x.s.status === 'active' && x.r.isActive).length,
      trials: states.filter((x) => x.s.status === 'trial').length, expired: states.filter((x) => x.s.status === 'expired').length,
      suspended: rs.filter((r) => !r.isActive).length, mrr, revenue, totalScans: rs.reduce((n, r) => n + (r.totalScans || 0), 0),
      pendingPayments: inMemoryData.payments.filter((p) => p.status === 'pending').length,
      newLeads: inMemoryData.leads.filter((l) => l.status === 'new').length,
      trialsEndingSoon: states.filter((x) => x.s.status === 'trial' && x.s.daysLeft <= 2).length,
    },
    signups, scans, planDistribution: dist, recentActivities: inMemoryData.activities.slice(0, 12),
    expiringSoon: states.filter((x) => x.s.daysLeft <= 3 && x.s.status !== 'expired').map((x) => row(x.r)).slice(0, 8),
  });
});

/* ---------- restaurants ---------- */
router.get('/restaurants', (req, res) => res.json({ success: true, restaurants: inMemoryData.restaurants.map(row), plans: Object.values(S.getPlans()) }));

router.get('/restaurants/:id', (req, res) => {
  const r = find(req.params.id);
  if (!r) return bad(res, 'Not found', 404);
  const orders = inMemoryData.orders.filter((o) => o.restaurantId === r.id);
  res.json({ success: true, restaurant: {
    ...row(r), categories: r.categories, items: r.items, tables: r.tables, phone: r.phone, googleReviewUrl: r.googleReviewUrl, scanDaily: r.scanDaily || {},
    gstin: r.gstin, fssai: r.fssai, openingHours: r.openingHours, about: r.about, social: r.social, store: r.store, taxPercent: r.taxPercent || 0,
    payments: inMemoryData.payments.filter((p) => p.restaurantId === r.id),
    orders: orders.slice(0, 50), orderRevenue: orders.filter((o) => o.status !== 'cancelled').reduce((n, o) => n + (o.totalAmount || 0), 0),
    feedbacks: inMemoryData.feedbacks.filter((f) => f.restaurantId === r.id).slice(0, 30),
    notifications: (r.notifications || []).slice(0, 20),
  } });
});

router.post('/restaurants', (req, res) => {
  const { name, ownerName, phone, city, plan, password, cuisine } = req.body || {};
  if (!name) return bad(res, 'Restaurant name required');
  const r = S.createRestaurant({ name, ownerName, phone, city, plan, password: password || undefined, cuisine });
  recordActivity('restaurant', 'Restaurant created by admin', `${r.name} added on ${r.subscription.plan}.`);
  res.status(201).json({ success: true, restaurant: row(r) });
});

router.patch('/restaurants/:id', (req, res) => {
  const r = find(req.params.id);
  if (!r) return bad(res, 'Not found', 404);
  const b = req.body || {};
  for (const k of ['name', 'ownerName', 'phone', 'city', 'cuisine', 'tagline', 'upiId', 'googleReviewUrl', 'email', 'address', 'openingHours', 'fssai', 'gstin', 'about']) if (typeof b[k] === 'string') r[k] = b[k].trim();
  if (b.social && typeof b.social === 'object') r.social = { ...r.social, ...b.social };
  if (Array.isArray(b.tables)) r.tables = [...new Set(b.tables.map((t) => String(t).trim()).filter(Boolean))].slice(0, 200);
  if (b.taxPercent !== undefined) r.taxPercent = Math.max(0, Math.min(28, Number(b.taxPercent) || 0));
  if (b.store && typeof b.store === 'object') r.store = { ...r.store, ...b.store };
  if (b.categorySchedule && typeof b.categorySchedule === 'object') r.categorySchedule = b.categorySchedule;
  if (typeof b.slug === 'string' && b.slug) {
    const s = S.slugify(b.slug);
    if (inMemoryData.restaurants.some((x) => x.slug === s && x.id !== r.id)) return bad(res, 'Slug taken', 409);
    r.slug = s;
  }
  if (typeof b.isActive === 'boolean') r.isActive = b.isActive;
  if (b.theme && typeof b.theme === 'object') {
    if (b.theme.template && !S.templateById(b.theme.template)) return bad(res, 'Unknown template');
    if (b.theme.qrTheme && !S.qrThemeById(b.theme.qrTheme)) return bad(res, 'Unknown QR design');
    r.theme = { ...r.theme, ...b.theme };
  }
  rebuildIndexes(); persistDb();
  RT.menuUpdated(r);
  RT.subscription(r, { event: 'admin_update' });
  res.json({ success: true, restaurant: row(r) });
});

router.patch('/restaurants/:id/toggle-status', (req, res) => {
  const r = find(req.params.id);
  if (!r) return bad(res, 'Not found', 404);
  r.isActive = !r.isActive;
  recordActivity('status', `Merchant ${r.isActive ? 'ACTIVATED' : 'SUSPENDED'}`, `${r.name} ${r.isActive ? 'reactivated' : 'suspended'} by admin.`);
  persistDb();
  res.json({ success: true, restaurant: row(r) });
});

router.delete('/restaurants/:id', (req, res) => {
  const i = inMemoryData.restaurants.findIndex((r) => r.id === req.params.id);
  if (i < 0) return bad(res, 'Not found', 404);
  const [gone] = inMemoryData.restaurants.splice(i, 1);
  inMemoryData.orders = inMemoryData.orders.filter((o) => o.restaurantId !== gone.id);
  inMemoryData.payments = inMemoryData.payments.filter((p) => p.restaurantId !== gone.id);
  inMemoryData.feedbacks = inMemoryData.feedbacks.filter((f) => f.restaurantId !== gone.id);
  inMemoryData.checkouts = (inMemoryData.checkouts || []).filter((c) => c.restaurantId !== gone.id);
  rebuildIndexes();
  recordActivity('restaurant', 'Restaurant permanently deleted', `${gone.name} was permanently removed by admin.`);
  forceFlushDb();
  res.json({ success: true, message: 'Restaurant permanently deleted' });
});

/** Set plan / status / extend trial / grant paid days in one call. */
router.post('/restaurants/:id/subscription', (req, res) => {
  const r = find(req.params.id);
  if (!r) return bad(res, 'Not found', 404);
  const { plan, status, addTrialDays, addPaidDays } = req.body || {};
  const sub = r.subscription;
  if (plan) { if (!S.getPlans()[plan]) return bad(res, 'Unknown plan'); sub.plan = plan; }
  if (addTrialDays) {
    const base = Math.max(Date.now(), new Date(sub.trialEndsAt || 0).getTime());
    sub.trialEndsAt = new Date(base + Number(addTrialDays) * S.DAY).toISOString();
    sub.status = 'trial';
  }
  if (addPaidDays) {
    const base = Math.max(Date.now(), new Date(sub.paidUntil || 0).getTime());
    sub.paidUntil = new Date(base + Number(addPaidDays) * S.DAY).toISOString();
    sub.status = 'active';
  }
  if (['trial', 'active', 'expired'].includes(status)) {
    sub.status = status;
    if (status === 'expired') { sub.trialEndsAt = new Date().toISOString(); sub.paidUntil = sub.paidUntil && new Date(sub.paidUntil) > new Date() ? new Date().toISOString() : sub.paidUntil; }
  }
  r.currentPlan = sub.plan; r.plan = sub.plan;
  recordActivity('payment', 'Subscription updated', `${r.name}: ${sub.plan} / ${sub.status} (admin).`);
  persistDb();
  RT.subscription(r, { event: 'admin_update' });
  res.json({ success: true, restaurant: row(r) });
});

router.post('/restaurants/:id/reset-password', (req, res) => {
  const r = find(req.params.id);
  if (!r) return bad(res, 'Not found', 404);
  const pw = String((req.body || {}).password || '');
  if (pw.length < 6) return bad(res, 'Min 6 characters');
  r.owner = S.hashPassword(pw);
  persistDb();
  res.json({ success: true });
});

/* ---------- plans ---------- */
const catalogue = () => ({ plans: Object.values(S.getPlans()), templates: S.templates(), qrThemes: S.qrThemes(), featureCatalog: S.catalog() });
router.get('/plans', (req, res) => res.json({ success: true, ...catalogue() }));
router.put('/plans/:id', (req, res) => {
  const p = inMemoryData.adminConfig.plans[req.params.id];
  if (!p) return bad(res, 'Unknown plan', 404);
  const b = req.body || {};
  for (const k of ['name', 'tagline', 'description', 'bestFor', 'badge', 'color']) if (typeof b[k] === 'string') p[k] = b[k].trim().slice(0, 600);
  if (b.price !== undefined) { const n = Number(b.price); if (!(n >= 0 && n <= 100000)) return bad(res, 'Price must be 0 to 1,00,000'); p.price = Math.round(n); }
  if (typeof b.popular === 'boolean') {
    if (b.popular) for (const o of Object.values(inMemoryData.adminConfig.plans)) o.popular = false;
    p.popular = b.popular;
  }
  if (b.features && typeof b.features === 'object') {
    const f = { ...p.features };
    for (const [k, v] of Object.entries(b.features)) {
      if (k === 'templates' || k === 'qrThemes') {
        if (!Array.isArray(v)) return bad(res, `${k} must be a list`);
        const known = new Set((k === 'templates' ? S.templates() : S.qrThemes()).map((t) => t.id));
        if (v.some((x) => !known.has(x))) return bad(res, `Unknown id in ${k}`);
        if (!v.length) return bad(res, `Every plan needs at least one ${k === 'templates' ? 'menu design' : 'QR design'}`);
        f[k] = v;
      } else if (typeof v === 'boolean') f[k] = v;
      else if (typeof v === 'number' && v >= 0) f[k] = Math.round(v);
    }
    p.features = f;
  }
  persistDb();
  recordActivity('plan', 'Plan updated', `${p.name} plan edited by admin.`);
  res.json({ success: true, ...catalogue() });
});
/** Edit a menu design or QR design (name, blurb, colours, which tier introduces it). */
router.put('/catalog/:kind/:id', (req, res) => {
  const list = req.params.kind === 'templates' ? S.templates() : req.params.kind === 'qr' ? S.qrThemes() : null;
  if (!list) return bad(res, 'Unknown catalogue', 404);
  const t = list.find((x) => x.id === req.params.id);
  if (!t) return bad(res, 'Not found', 404);
  const b = req.body || {};
  for (const [k, v] of Object.entries(b)) {
    if (k === 'id' || !(k in t)) continue;
    if (typeof t[k] === 'string' && typeof v === 'string') {
      if (/^#[0-9a-fA-F]{6}$/.test(t[k]) && !/^#[0-9a-fA-F]{6}$/.test(v)) return bad(res, `${k} must be a colour like #AABBCC`);
      t[k] = v.slice(0, 120);
    } else if (typeof t[k] === 'number' && typeof v === 'number') t[k] = v;
    else if (typeof t[k] === 'boolean' && typeof v === 'boolean') t[k] = v;
  }
  persistDb();
  res.json({ success: true, ...catalogue() });
});

/* ---------- browser push for admins (Web Push / VAPID, no third-party account) ---------- */
const push = require('../services/push');
router.get('/push/key', (req, res) => res.json({ success: true, publicKey: push.publicKey() }));
router.post('/push/subscribe', (req, res) => (push.subscribe((req.body || {}).subscription, 'admin') ? res.json({ success: true }) : bad(res, 'Invalid subscription')));
router.post('/push/unsubscribe', (req, res) => { push.unsubscribe(String((req.body || {}).endpoint || '')); res.json({ success: true }); });
router.post('/push/test', (req, res) => { push.toAdmins({ title: 'Notifications are on', body: 'You will get new payments and sign-ups here.', url: '/dashboard' }); res.json({ success: true }); });

/* ---------- coupons ---------- */
router.get('/coupons', (req, res) => res.json({ success: true, coupons: inMemoryData.coupons }));
router.post('/coupons', (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) return bad(res, 'Code: 3-20 letters/numbers');
  if (S.findCoupon(code)) return bad(res, 'Code already exists', 409);
  if (!['percent', 'flat', 'trial_days'].includes(b.type)) return bad(res, 'Bad type');
  const c = {
    id: `cpn-${crypto.randomBytes(4).toString('hex')}`, code, description: String(b.description || ''), type: b.type,
    value: Number(b.value) || 0, maxUses: Number(b.maxUses) || 0, used: 0, expiresAt: b.expiresAt || null,
    plans: Array.isArray(b.plans) ? b.plans : [], active: b.active !== false, createdAt: new Date().toISOString(),
  };
  inMemoryData.coupons.unshift(c); persistDb();
  res.status(201).json({ success: true, coupon: c });
});
router.patch('/coupons/:id', (req, res) => {
  const c = inMemoryData.coupons.find((x) => x.id === req.params.id);
  if (!c) return bad(res, 'Not found', 404);
  const b = req.body || {};
  for (const k of ['description', 'expiresAt']) if (k in b) c[k] = b[k] || (k === 'expiresAt' ? null : '');
  for (const k of ['value', 'maxUses']) if (b[k] !== undefined) c[k] = Number(b[k]) || 0;
  if (typeof b.active === 'boolean') c.active = b.active;
  if (Array.isArray(b.plans)) c.plans = b.plans;
  if (['percent', 'flat', 'trial_days'].includes(b.type)) c.type = b.type;
  persistDb();
  res.json({ success: true, coupon: c });
});
router.delete('/coupons/:id', (req, res) => {
  const n = inMemoryData.coupons.length;
  inMemoryData.coupons = inMemoryData.coupons.filter((x) => x.id !== req.params.id);
  if (inMemoryData.coupons.length === n) return bad(res, 'Not found', 404);
  forceFlushDb();
  res.json({ success: true, message: 'Coupon permanently deleted' });
});

/* ---------- payments ---------- */
router.get('/payments', (req, res) => res.json({ success: true, adminUpiId: inMemoryData.adminConfig.adminUpiId, payments: inMemoryData.payments }));
router.post('/payments/:id/verify', (req, res) => {
  const p = inMemoryData.payments.find((x) => x.id === req.params.id);
  if (!p) return bad(res, 'Not found', 404);
  if (p.status === 'verified') return bad(res, 'Already verified', 409);
  const r = find(p.restaurantId);
  S.activatePayment(p, r, { by: 'admin' });
  recordActivity('payment', 'Payment verified', `₹${p.amount} from ${p.restaurantName} approved (+30 days).`);
  if (r) S.notify(r, { type: 'payment', title: 'Payment verified · plan active', body: `₹${p.amount} received. ${S.getPlans()[p.planId].name} is active till ${new Date(r.subscription.paidUntil).toLocaleDateString('en-IN')}.`, data: { paymentId: p.id } });
  if (r && r.email) {
    const mailer = require('../services/mailer');
    const planObj = S.getPlans()[p.planId] || { name: p.planId, price: p.amount };
    mailer.sendPaymentReceiptEmail({
      to: r.email,
      restaurantName: r.name,
      amount: p.amount,
      originalPrice: p.listPrice || planObj.price || p.amount,
      discount: p.discount || 0,
      couponCode: p.coupon || null,
      planName: planObj.name,
      utrRef: p.utrRef,
      validUntil: r.subscription.paidUntil,
      invoiceId: p.id,
      websiteUrl: S.menuBaseUrl(),
    }).catch((err) => console.error('[Mailer:ReceiptErr]', err.message));
  }
  persistDb();
  if (r) RT.subscription(r, { event: 'payment_verified', payment: p });
  res.json({ success: true, payment: p });
});
router.post('/payments/:id/reject', (req, res) => {
  const p = inMemoryData.payments.find((x) => x.id === req.params.id);
  if (!p) return bad(res, 'Not found', 404);
  const wasAuto = p.status === 'verified' && p.verifiedBy === 'auto';
  p.status = 'rejected';
  const rr = find(p.restaurantId);
  if (rr && rr.subscription.status === 'pending') rr.subscription.status = 'expired';
  // a fake screenshot that was approved automatically: the plan stops at once (fraud notice on the pay page)
  if (rr && wasAuto) { rr.subscription.status = 'expired'; rr.subscription.paidUntil = new Date().toISOString(); recordActivity('payment', 'Auto-approval reversed', `${rr.name}: ₹${p.amount} rejected, service stopped.`); }
  if (rr) S.notify(rr, { type: 'payment', title: 'Payment could not be verified', body: `We could not find ₹${p.amount} with reference ${p.utrRef}. Please contact support.`, data: { paymentId: p.id } });
  persistDb();
  if (rr) RT.subscription(rr, { event: 'payment_rejected', payment: p });
  res.json({ success: true, payment: p });
});

/* ---------- leads (website demo requests) ---------- */
router.get('/leads', (req, res) => res.json({ success: true, leads: inMemoryData.leads }));
router.patch('/leads/:id', (req, res) => {
  const l = inMemoryData.leads.find((x) => x.id === req.params.id);
  if (!l) return bad(res, 'Not found', 404);
  if (['new', 'contacted', 'won', 'lost'].includes((req.body || {}).status)) l.status = req.body.status;
  persistDb();
  res.json({ success: true, lead: l });
});
router.delete('/leads/:id', (req, res) => {
  inMemoryData.leads = inMemoryData.leads.filter((x) => x.id !== req.params.id);
  forceFlushDb();
  res.json({ success: true, message: 'Lead permanently deleted' });
});

/* ---------- settings ---------- */
router.get('/settings', (req, res) => {
  const c = inMemoryData.adminConfig;
  res.json({ success: true, settings: { ...c.settings, adminUpiId: c.adminUpiId, adminPhone: c.adminPhone, supportEmail: c.supportEmail, payeeName: c.payeeName || '' }, websiteUrl: S.menuBaseUrl() });
});

router.post('/test-email', async (req, res) => {
  try {
    const mailer = require('../services/mailer');
    const to = req.body?.to || 'piyushassudani96@gmail.com';
    const result = await mailer.sendTestEmail({ to });
    if (result.success) {
      res.json({ success: true, message: `Test email sent to ${to}`, messageId: result.messageId, simulated: !!result.simulated });
    } else {
      res.status(500).json({ success: false, error: result.error || result.reason });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.put('/settings', (req, res) => {
  const c = inMemoryData.adminConfig; const b = req.body || {};
  if (typeof b.adminUpiId === 'string' && b.adminUpiId.trim() && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(b.adminUpiId.trim())) return bad(res, 'That UPI ID does not look right (example: name@okhdfc)');
  if (typeof b.supportEmail === 'string' && b.supportEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.supportEmail.trim())) return bad(res, 'Enter a valid email');
  for (const k of ['adminUpiId', 'adminPhone', 'supportEmail', 'payeeName']) if (typeof b[k] === 'string') c[k] = b[k].trim();
  if (typeof b.brandName === 'string' && b.brandName.trim()) c.settings.brandName = b.brandName.trim().slice(0, 40);
  if (b.trialDays !== undefined) c.settings.trialDays = Math.max(0, Math.min(90, Number(b.trialDays) || 0));
  for (const k of ['trialEnabled', 'signupsOpen', 'maintenanceMode', 'appPaymentLinks']) if (typeof b[k] === 'boolean') c.settings[k] = b[k];
  persistDb();
  res.json({ success: true });
});


/* ================= FULL CONTROL EXTRAS ================= */
const cleanRest = (r) => { const { owner, ...rest } = r; return rest; };

/* ---- menu editing for any restaurant ---- */
const gid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const syncCats = (r) => { r.categories = [...new Set([...r.categories.filter((c) => r.items.some((i) => i.category === c)), ...r.items.map((i) => i.category)])]; };
router.post('/restaurants/:id/items', (req, res) => {
  const r = find(req.params.id);
  if (!r) return bad(res, 'Not found', 404);
  const b = req.body || {};
  if (!b.name) return bad(res, 'Dish name required');
  const it = { id: gid('d'), name: String(b.name).trim(), category: String(b.category || 'Menu').trim(), price: Number(b.price) || 0, description: String(b.description || ''), isVeg: b.isVeg !== false, spiceLevel: b.spiceLevel || 'none', isAvailable: b.isAvailable !== false, imageUrl: String(b.imageUrl || ''), tags: b.tags || [], variants: (b.variants || []).map((v) => ({ id: gid('v'), name: v.name, price: Number(v.price) || 0 })), modifiers: [] };
  r.items.push(it); syncCats(r); persistDb(); RT.menuUpdated(r);
  res.status(201).json({ success: true, item: it });
});
router.patch('/restaurants/:id/items/:itemId', (req, res) => {
  const r = find(req.params.id); const it = r && r.items.find((x) => x.id === req.params.itemId);
  if (!it) return bad(res, 'Not found', 404);
  const b = req.body || {};
  for (const k of ['name', 'category', 'description', 'spiceLevel', 'imageUrl']) if (typeof b[k] === 'string') it[k] = b[k].trim();
  if (b.price !== undefined) it.price = Number(b.price) || 0;
  for (const k of ['isVeg', 'isAvailable']) if (typeof b[k] === 'boolean') it[k] = b[k];
  if (Array.isArray(b.variants)) it.variants = b.variants.map((v) => ({ id: v.id || gid('v'), name: v.name, price: Number(v.price) || 0 }));
  if (b.offerPrice !== undefined) it.offerPrice = Number(b.offerPrice) > 0 && Number(b.offerPrice) < it.price ? Number(b.offerPrice) : null;
  if (Array.isArray(b.addons)) it.addons = b.addons.filter((a) => a && a.name).map((a) => ({ id: a.id || gid('a'), name: String(a.name).slice(0, 40), price: Math.max(0, Number(a.price) || 0) }));
  if (Array.isArray(b.tags)) it.tags = b.tags.map(String).slice(0, 6);
  syncCats(r); persistDb(); RT.menuUpdated(r);
  res.json({ success: true, item: it });
});
router.delete('/restaurants/:id/items/:itemId', (req, res) => {
  const r = find(req.params.id);
  if (!r) return bad(res, 'Not found', 404);
  const item = r.items.find((x) => x.id === req.params.itemId);
  r.items = r.items.filter((x) => x.id !== req.params.itemId);
  if (item) archiveRecord('items', { ...item, restaurantId: r.id, restaurantName: r.name }, 'Deleted by admin');
  syncCats(r); persistDb(); RT.menuUpdated(r);
  res.json({ success: true });
});

/* ---- orders (all restaurants) ---- */
router.get('/orders', (req, res) => {
  const { restaurantId, status } = req.query;
  let list = inMemoryData.orders;
  if (restaurantId) list = list.filter((o) => o.restaurantId === restaurantId);
  if (status) list = list.filter((o) => o.status === status);
  const names = Object.fromEntries(inMemoryData.restaurants.map((r) => [r.id, r.name]));
  res.json({ success: true, total: list.length, orders: list.slice(0, 300).map((o) => ({ ...o, restaurantName: names[o.restaurantId] || '—' })) });
});
router.patch('/orders/:id/status', (req, res) => {
  const o = inMemoryData.orders.find((x) => x.id === req.params.id);
  if (!o) return bad(res, 'Not found', 404);
  if (!['pending', 'cooking', 'ready', 'served', 'cancelled'].includes((req.body || {}).status)) return bad(res, 'Invalid status');
  o.status = req.body.status; o.updatedAt = new Date().toISOString(); persistDb();
  RT.orderUpdate(o);
  res.json({ success: true, order: o });
});
router.delete('/orders/:id', (req, res) => {
  const i = inMemoryData.orders.findIndex((x) => x.id === req.params.id);
  if (i < 0) return bad(res, 'Not found', 404);
  inMemoryData.orders.splice(i, 1);
  rebuildIndexes();
  forceFlushDb();
  res.json({ success: true, message: 'Order permanently deleted' });
});

/* ---- feedback ---- */
router.get('/feedbacks', (req, res) => {
  const names = Object.fromEntries(inMemoryData.restaurants.map((r) => [r.id, r.name]));
  res.json({ success: true, feedbacks: inMemoryData.feedbacks.map((f) => ({ ...f, restaurantName: names[f.restaurantId] || '—' })) });
});
router.delete('/feedbacks/:id', (req, res) => {
  const i = inMemoryData.feedbacks.findIndex((x) => x.id === req.params.id);
  if (i >= 0) inMemoryData.feedbacks.splice(i, 1);
  forceFlushDb();
  res.json({ success: true, message: 'Feedback permanently deleted' });
});

/* ---- payments: record manually / delete ---- */
router.post('/payments', (req, res) => {
  const { restaurantId, planId, amount, utrRef, note, activate = true } = req.body || {};
  const r = find(restaurantId);
  if (!r) return bad(res, 'Choose a restaurant');
  if (!S.getPlans()[planId]) return bad(res, 'Choose a plan');
  const tx = { id: `TXN-${Date.now().toString().slice(-6)}`, restaurantId: r.id, restaurantName: r.name, ownerName: r.ownerName, phone: r.phone, planId, amount: Number(amount) || S.getPlans()[planId].price, method: 'MANUAL', utrRef: String(utrRef || 'manual-' + Date.now().toString(36)), note: String(note || ''), status: activate ? 'verified' : 'pending', source: 'admin', date: new Date().toISOString() };
  inMemoryData.payments.unshift(tx);
  if (activate) {
    const base = Math.max(Date.now(), new Date(r.subscription.paidUntil || 0).getTime());
    r.subscription.plan = planId; r.subscription.status = 'active'; r.subscription.paidUntil = new Date(base + 30 * S.DAY).toISOString();
    r.currentPlan = planId; r.plan = planId; r.isActive = true;
  }
  recordActivity('payment', 'Payment recorded by admin', `₹${tx.amount} for ${r.name}.`);
  persistDb();
  RT.subscription(r, { event: activate ? 'payment_verified' : 'payment_recorded', payment: tx });
  res.status(201).json({ success: true, payment: tx });
});
router.delete('/payments/:id', (req, res) => {
  const n = inMemoryData.payments.length;
  inMemoryData.payments = inMemoryData.payments.filter((x) => x.id !== req.params.id);
  if (inMemoryData.payments.length === n) return bad(res, 'Not found', 404);
  for (const r of inMemoryData.restaurants) {
    if (r.subscription && r.subscription.pendingPaymentId === req.params.id) {
      r.subscription.pendingPaymentId = null;
    }
  }
  forceFlushDb();
  res.json({ success: true, message: 'Payment permanently deleted' });
});

/* ---- send a message to one restaurant or everyone (shows in their app instantly) ---- */
router.post('/notify', (req, res) => {
  const { restaurantId, title, body } = req.body || {};
  if (!title || !String(title).trim()) return bad(res, 'Add a title');
  const targets = restaurantId && restaurantId !== 'all' ? [find(restaurantId)].filter(Boolean) : inMemoryData.restaurants;
  if (!targets.length) return bad(res, 'Restaurant not found', 404);
  for (const r of targets) S.notify(r, { type: 'admin', title: String(title).trim().slice(0, 80), body: String(body || '').trim().slice(0, 400) });
  recordActivity('system', 'Message sent', `"${String(title).slice(0, 40)}" to ${targets.length} restaurant(s).`);
  persistDb();
  res.json({ success: true, sent: targets.length });
});

/* ---- activity, account, backup, export ---- */
router.get('/activities', (req, res) => res.json({ success: true, activities: inMemoryData.activities }));
router.post('/account', (req, res) => {
  const { currentPassword, email, newPassword } = req.body || {};
  if (!checkPassword(currentPassword)) return bad(res, 'Current password is wrong', 403);
  const cur = cfgAdmin() || {};
  const next = { ...cur, email: (email || ADMIN_EMAIL()).toLowerCase() };
  if (newPassword) { if (String(newPassword).length < 8) return bad(res, 'New password must be at least 8 characters'); Object.assign(next, S.hashPassword(newPassword)); }
  else if (!next.hash) Object.assign(next, S.hashPassword(currentPassword));
  inMemoryData.adminConfig.admin = next; persistDb();
  res.json({ success: true, email: next.email });
});
router.post('/backup', (req, res) => { createSnapshot('admin_manual'); res.json({ success: true, message: 'Snapshot saved' }); });
router.get('/export', (req, res) => {
  const d = inMemoryData;
  res.setHeader('Content-Disposition', `attachment; filename="qrmenu-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), restaurants: d.restaurants.map(cleanRest), orders: d.orders, feedbacks: d.feedbacks, payments: d.payments, coupons: d.coupons, leads: d.leads, plans: S.getPlans() });
});

module.exports = router;
