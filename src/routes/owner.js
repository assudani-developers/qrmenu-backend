/**
 * Restaurant-owner API (the Flutter app). Multi-tenant: every call is scoped to the JWT's restaurant.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, generateToken } = require('../middleware/auth');
const { inMemoryData, persistDb, rebuildIndexes, findRestaurantById, recordActivity, archiveRecord } = require('../db');
const S = require('../services/saas');
const { scanMenu } = require('../services/menuScanner');
const RT = require('../services/realtime');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const id = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function ownerAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return bad(res, 'Please sign in', 401);
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== 'owner' || !p.restaurantId) return bad(res, 'Not an owner token', 403);
    const r = findRestaurantById(p.restaurantId);
    if (!r) return bad(res, 'Restaurant not found', 404);
    req.rest = r;
    next();
  } catch (_) {
    return bad(res, 'Session expired, please sign in again', 401);
  }
}

function summary(r) {
  const sub = S.subscriptionState(r);
  const plans = S.getPlans();
  return {
    id: r.id, name: r.name, ownerName: r.ownerName, email: r.email, taxPercent: r.taxPercent || 0, phone: r.phone, city: r.city, cuisine: r.cuisine,
    tagline: r.tagline, address: r.address, openingHours: r.openingHours, fssai: r.fssai, gstin: r.gstin, about: r.about, social: r.social, prefs: r.prefs,
    slug: r.slug, shortId: r.shortId, upiId: r.upiId, googleReviewUrl: r.googleReviewUrl,
    tables: r.tables, categories: r.categories, items: r.items, theme: r.theme, isActive: r.isActive, store: r.store, categorySchedule: r.categorySchedule,
    totalScans: r.totalScans || 0, createdAt: r.createdAt,
    subscription: { ...sub, plan: sub.plan, planDetails: plans[sub.plan], trialEndsAt: r.subscription.trialEndsAt, trialStartedAt: r.subscription.trialStartedAt },
    links: S.publicLinks(r),
    locked: { name: true, ownerName: true, phone: true },
  };
}


/* ---------- public: plans & coupon check ---------- */
/** Everything the app needs to render plans, designs and support — all from the database. */
function catalogue() {
  const c = inMemoryData.adminConfig;
  return {
    featureCatalog: S.catalog(), planOrder: S.planOrder(), plans: Object.values(S.getPlans()),
    templates: S.templates(), qrThemes: S.qrThemes(),
    trialEnabled: c.settings.trialEnabled, trialDays: c.settings.trialDays, appPaymentLinks: c.settings.appPaymentLinks !== false,
    brandName: c.settings.brandName || 'QR Menu Pro', websiteUrl: S.menuBaseUrl(),
    support: { phone: c.adminPhone, email: c.supportEmail },
  };
}
router.get('/plans', (req, res) => res.json({ success: true, ...catalogue() }));

router.post('/coupons/validate', (req, res) => {
  const { code, plan } = req.body || {};
  const r = S.priceWithCoupon(plan || 'growth', code);
  if (!r.ok) return bad(res, r.error);
  return res.json({ success: true, ...r });
});

/* ---------- auth ---------- */
/** Pre-signup phone check: verify number is valid and available before merchant proceeds through wizard. */
router.post('/check-phone', authLimiter, (req, res) => {
  const cleanPhone = String(req.body?.phone || '').replace(/\D/g, '');
  if (cleanPhone.length !== 10) {
    return bad(res, 'Mobile number must be exactly 10 digits', 422);
  }
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
    return bad(res, 'Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9', 422);
  }
  const exists = inMemoryData.restaurants.some((r) => String(r.phone || '').replace(/\D/g, '') === cleanPhone);
  if (exists) {
    return res.status(409).json({ success: false, available: false, message: 'This mobile number is already registered. Please sign in.' });
  }
  return res.json({ success: true, available: true, message: 'Number is available' });
});

router.post('/signup', (req, res) => {
  const { name, ownerName, phone, password, city, plan, cuisine, couponCode } = req.body || {};
  const settings = inMemoryData.adminConfig.settings;
  if (!settings.signupsOpen) return bad(res, 'Signups are temporarily closed', 403);
  if (!name || String(name).trim().length < 2) return bad(res, 'Enter your restaurant name');
  if (!ownerName || String(ownerName).trim().length < 2) return bad(res, 'Enter your name');
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.length !== 10) return bad(res, 'Mobile number must be exactly 10 digits', 422);
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) return bad(res, 'Enter a valid 10-digit Indian mobile number', 422);
  if (!password || String(password).length < 6) return bad(res, 'Password must be at least 6 characters');
  if (!S.getPlans()[plan]) return bad(res, 'Choose a plan');
  if (inMemoryData.restaurants.some((r) => String(r.phone || '').replace(/\D/g, '') === cleanPhone)) {
    return bad(res, 'This mobile number is already registered. Please sign in.', 409);
  }
  // Every account starts on the free trial; paying happens later on the website.
  let price = null;
  if (couponCode) {
    price = S.priceWithCoupon(plan, couponCode);
    if (!price.ok) return bad(res, price.error);
    if (!(price.coupon && price.coupon.type === 'trial_days')) return bad(res, 'Discount coupons apply when you pay. Add this one at checkout.');
  }
  const r = S.createRestaurant({ name: String(name).trim(), ownerName: String(ownerName).trim(), phone: cleanPhone, password, city, plan, cuisine });
  if (price && price.coupon) {
    S.findCoupon(couponCode).used += 1;
    r.subscription.trialEndsAt = new Date(new Date(r.subscription.trialEndsAt).getTime() + price.extraTrialDays * S.DAY).toISOString();
  }
  recordActivity('restaurant', 'New signup', `${r.name} joined on the ${S.getPlans()[r.subscription.plan].name} trial.`);
  persistDb();
  RT.toAdmin('restaurant:new', { id: r.id, name: r.name });
  require('../services/push').toAdmins({ title: 'New restaurant signed up', body: `${r.name} · ${r.city || ''} · ${S.getPlans()[r.subscription.plan].name} trial`, url: '/dashboard/restaurants' });
  return res.status(201).json({ success: true, token: generateToken({ role: 'owner', restaurantId: r.id }), restaurant: summary(r) });
});

router.post('/login', (req, res) => {
  const { phone, password } = req.body || {};
  const clean = String(phone || '').replace(/\s/g, '');
  const r = inMemoryData.restaurants.find((x) => x.owner && String(x.phone).replace(/\s/g, '') === clean);
  if (!r || !S.verifyPassword(password, r.owner)) return bad(res, 'Wrong mobile number or password', 401);
  return res.json({ success: true, token: generateToken({ role: 'owner', restaurantId: r.id }), restaurant: summary(r) });
});

router.use(ownerAuth);

router.get('/me', (req, res) => res.json({ success: true, restaurant: summary(req.rest), ...catalogue() }));

/* ---------- profile ---------- */
router.patch('/profile', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  const b = req.body || {};
  if (b.taxPercent !== undefined) r.taxPercent = Math.max(0, Math.min(28, Number(b.taxPercent) || 0));
  if (typeof b.name === 'string' && b.name.trim() !== r.name) return bad(res, 'Your restaurant name is fixed after sign-up. Contact support to correct a spelling mistake.', 403);
  if (typeof b.upiId === 'string' && b.upiId.trim() && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(b.upiId.trim())) return bad(res, 'That UPI ID does not look right (example: name@okhdfc)');
  if (typeof b.gstin === 'string' && b.gstin.trim() && !/^[0-9A-Z]{15}$/.test(b.gstin.trim().toUpperCase())) return bad(res, 'GSTIN must be 15 characters');
  if (typeof b.fssai === 'string' && b.fssai.trim() && !/^[0-9]{14}$/.test(b.fssai.trim())) return bad(res, 'FSSAI licence number must be 14 digits');
  for (const k of ['tagline', 'city', 'cuisine', 'upiId', 'googleReviewUrl', 'address', 'openingHours', 'fssai', 'about']) {
    if (typeof b[k] === 'string') r[k] = b[k].trim().slice(0, k === 'about' || k === 'address' ? 400 : 140);
  }
  if (typeof b.gstin === 'string') r.gstin = b.gstin.trim().toUpperCase();
  if (b.social && typeof b.social === 'object') {
    const filled = Object.values(b.social).some((v) => String(v || '').trim());
    if (filled && !f.socialLinks) return S.planBlocked(res, 'socialLinks');
    for (const k of ['instagram', 'facebook', 'whatsapp', 'website', 'maps']) if (typeof b.social[k] === 'string') r.social[k] = b.social[k].trim().slice(0, 200);
  }
  if (Array.isArray(b.tables)) {
    const list = [...new Set(b.tables.map((t) => String(t).trim()).filter(Boolean))];
    if (list.length > (f.maxTables || 0) && list.join('|') !== (r.tables || []).join('|')) {
      return S.planBlocked(res, f.maxTables ? 'maxTables' : 'tableQr', f.maxTables ? `Your plan includes ${f.maxTables} tables. Upgrade to add more.` : 'Table QR codes start on the Growth plan');
    }
    r.tables = list;
  }
  rebuildIndexes();
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true, restaurant: summary(r) });
});

router.patch('/prefs', (req, res) => {
  const b = req.body || {};
  for (const k of ['orderSound', 'receiptAnimation', 'autoAccept']) if (typeof b[k] === 'boolean') req.rest.prefs[k] = b[k];
  persistDb();
  res.json({ success: true, prefs: req.rest.prefs });
});

/* ---------- look: ready-made templates + QR design (no fiddly colour pickers) ---------- */
router.patch('/theme', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  const b = req.body || {};
  const t = { ...r.theme };
  if (b.template !== undefined) {
    const tpl = S.templateById(b.template);
    if (!tpl) return bad(res, 'Unknown design');
    if (!(f.templates || []).includes(b.template)) return S.planBlocked(res, 'templates', `The ${tpl.name} design is on the ${S.getPlans()[S.requiredPlanFor('templates', b.template)].name} plan`, b.template);
    t.template = b.template;
  }
  if (b.qrTheme !== undefined) {
    const q = S.qrThemeById(b.qrTheme);
    if (!q) return bad(res, 'Unknown QR design');
    if (!(f.qrThemes || []).includes(b.qrTheme)) return S.planBlocked(res, 'qrThemes', `The ${q.name} QR design is on the ${S.getPlans()[S.requiredPlanFor('qrThemes', b.qrTheme)].name} plan`, b.qrTheme);
    t.qrTheme = b.qrTheme;
  }
  if (typeof b.coverUrl === 'string' && b.coverUrl && !f.coverImage) return S.planBlocked(res, 'coverImage');
  if (typeof b.announcement === 'string' && b.announcement.trim() && !f.announcement) return S.planBlocked(res, 'announcement');
  for (const k of ['showVegToggle', 'showSearch']) if (typeof b[k] === 'boolean') t[k] = b[k];
  for (const k of ['welcome', 'logoUrl', 'coverUrl', 'announcement']) if (typeof b[k] === 'string') t[k] = b[k].trim().slice(0, 300);
  r.theme = t;
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true, theme: t, links: S.publicLinks(r) });
});

/* ---------- menu: photo scan -> preview -> import ---------- */
/** Instant clarity check before the (slow) OCR: blur, darkness, glare and size. */
const { checkPhoto } = require('../services/photoQuality');
router.post('/menu/check-photo', async (req, res) => {
  const m = String((req.body || {}).image || '').match(/^(?:data:image\/[a-z+]+;base64,)?(.+)$/);
  if (!m || m[1].length < 100) return bad(res, 'No photo received');
  res.json({ success: true, quality: await checkPhoto(Buffer.from(m[1], 'base64')) });
});

router.post('/menu/scan', async (req, res) => {
  const r = req.rest;
  const images = (req.body.images || []).slice(0, 6).map((i) => {
    const m = String(i.data || '').match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    return m ? { mediaType: m[1].replace('jpg', 'jpeg'), data: m[2] } : { mediaType: i.mediaType || 'image/jpeg', data: String(i.data || '') };
  }).filter((i) => i.data.length > 100);
  if (!images.length) return bad(res, 'Add at least one menu photo');
  for (const [i, img] of images.entries()) {
    const q = await checkPhoto(Buffer.from(img.data, 'base64'));
    if (!q.ok) return res.status(422).json({ success: false, quality: q, page: i + 1, message: `Photo ${images.length > 1 ? i + 1 + ' ' : ''}is not clear enough: ${q.reason}` });
  }
  try {
    const menu = await scanMenu(images);
    res.json({ success: true, menu });
  } catch (e) {
    bad(res, e.message, 422);
  }
});

router.post('/menu/import', (req, res) => {
  const r = req.rest;
  const sub = S.subscriptionState(r);
  const { categories = [], replace = false, tagline, template } = req.body || {};
  const incoming = [];
  const catNames = replace ? [] : [...r.categories];
  for (const c of categories) {
    const cname = String(c.name || '').trim();
    if (!cname) continue;
    if (!catNames.includes(cname)) catNames.push(cname);
    for (const i of c.items || []) {
      if (!i.name) continue;
      incoming.push({
        id: id('d'), name: String(i.name).trim(), category: cname, price: Number(i.price) || 0,
        description: String(i.description || '').trim(), isVeg: i.isVeg !== false, spiceLevel: i.spiceLevel || 'none',
        isAvailable: true, imageUrl: '', images: [], tags: i.tags || [],
        variants: (i.variants || []).map((v) => ({ id: id('v'), name: v.name, price: Number(v.price) || 0 })),
        modifiers: [],
      });
    }
  }
  r.items = replace ? incoming : [...r.items, ...incoming];
  r.categories = catNames.filter((n) => r.items.some((i) => i.category === n));
  if (tagline && !r.tagline) r.tagline = String(tagline).slice(0, 140);
  if (template && (sub.features.templates || []).includes(template)) r.theme.template = template;
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true, imported: incoming.length, restaurant: summary(r) });
});

/* ---------- menu: manual CRUD (unlimited dishes on every plan) ---------- */
const DIETS = ['jain', 'vegan', 'glutenFree', 'nuts', 'egg', 'dairy', 'soy', 'sesame'];
/** Validates the richer dish fields (offer price, add-ons, diet, ingredients, allergens, spice, prep time, calories). */
function dishExtras(b, f, cur) {
  const patch = {};
  const price = b.price !== undefined ? Number(b.price) : cur ? cur.price : 0;
  if (b.offerPrice !== undefined) {
    if (b.offerPrice === null || b.offerPrice === '' || Number(b.offerPrice) === 0) patch.offerPrice = null;
    else {
      if (!f.offers) return { error: (res) => S.planBlocked(res, 'offers', 'Offer prices & deals are on Growth and Ultra') };
      const op = Number(b.offerPrice);
      if (!(op > 0 && op < price)) return { error: (res) => bad(res, 'Offer price must be lower than the regular price') };
      patch.offerPrice = op;
    }
  }
  if (Array.isArray(b.addons)) {
    if (b.addons.length && !f.addons) return { error: (res) => S.planBlocked(res, 'addons', 'Add-ons like extra cheese are on Growth and Ultra') };
    const list = [];
    for (const a of b.addons.slice(0, 12)) {
      const n = String(a.name || '').trim();
      const p = Number(a.price);
      if (!n) continue;
      if (!(p >= 0)) return { error: (res) => bad(res, `Add-on “${n}” needs a price (0 or more)`) };
      list.push({ id: a.id || id('a'), name: n.slice(0, 40), price: p });
    }
    patch.addons = list;
  }
  if (Array.isArray(b.diet)) patch.diet = b.diet.filter((d) => DIETS.includes(d));
  if (typeof b.ingredients === 'string') patch.ingredients = b.ingredients.trim().slice(0, 500);
  if (Array.isArray(b.allergens)) patch.allergens = b.allergens.map(String).filter((a) => DIETS.includes(a)).slice(0, 8);
  if (b.spiceLevel !== undefined) patch.spiceLevel = ['none', 'mild', 'medium', 'hot'].includes(b.spiceLevel) ? b.spiceLevel : 'none';
  if (b.prepTime !== undefined) patch.prepTime = Math.max(0, Math.min(180, parseInt(b.prepTime, 10) || 0)) || null;
  if (b.calories !== undefined) patch.calories = Math.max(0, Math.min(5000, parseInt(b.calories, 10) || 0)) || null;
  return { patch };
}
const BADGES = ['bestseller', 'chef', 'new', 'spicy'];
/** Dish photos: 1 on Starter, up to 3 on Growth & Ultra (plan value `photosPerDish`). */
function dishImages(b, f, res) {
  let list = Array.isArray(b.images) ? b.images : typeof b.imageUrl === 'string' ? (b.imageUrl ? [b.imageUrl] : []) : null;
  if (list === null) return { list: null };
  list = list.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//.test(u)).slice(0, 6);
  const max = Number(f.photosPerDish) || 0;
  if (list.length > max) return { error: () => S.planBlocked(res, 'photosPerDish', max ? `Your plan allows ${max} photo${max === 1 ? '' : 's'} per dish. Upgrade for more.` : 'Dish photos are not on your plan', list.length) };
  return { list };
}
router.post('/menu/items', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return bad(res, 'Dish name required');
  if (Number(b.price) < 0) return bad(res, 'Price cannot be negative');
  const badge = (b.tags || []).some((t) => BADGES.includes(t));
  if (badge && !f.dishBadges) return S.planBlocked(res, 'dishBadges', 'Bestseller & chef special tags are on Growth and Ultra');
  const ph = dishImages(b, f, res);
  if (ph.error) return ph.error();
  const cat = String(b.category || 'Menu').trim();
  const item = {
    id: id('d'), name: String(b.name).trim(), category: cat, price: Number(b.price) || 0,
    description: String(b.description || ''), ingredients: String(b.ingredients || '').trim().slice(0, 500),
    allergens: Array.isArray(b.allergens) ? b.allergens.map(String).filter((a) => DIETS.includes(a)).slice(0, 8) : [],
    isVeg: b.isVeg !== false, spiceLevel: b.spiceLevel || 'none',
    isAvailable: true, images: ph.list || [], imageUrl: (ph.list || [])[0] || '', tags: (b.tags || []).map(String).slice(0, 6),
    variants: (b.variants || []).map((v) => ({ id: id('v'), name: v.name, price: Number(v.price) || 0 })), modifiers: [],
  };
  const extra = dishExtras(b, f, null);
  if (extra.error) return extra.error(res);
  Object.assign(item, extra.patch);
  r.items.push(item);
  if (!r.categories.includes(cat)) r.categories.push(cat);
  persistDb();
  RT.menuUpdated(r);
  res.status(201).json({ success: true, item });
});

router.patch('/menu/items/:itemId', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  const it = r.items.find((x) => x.id === req.params.itemId);
  if (!it) return bad(res, 'Dish not found', 404);
  const b = req.body || {};
  for (const k of ['name', 'category', 'description', 'spiceLevel']) if (typeof b[k] === 'string') it[k] = b[k].trim();
  if (b.price !== undefined) it.price = Number(b.price) || 0;
  if (typeof b.isVeg === 'boolean') it.isVeg = b.isVeg;
  if (typeof b.isAvailable === 'boolean') it.isAvailable = b.isAvailable;
  if (Array.isArray(b.tags)) {
    if (b.tags.some((t) => BADGES.includes(t)) && !f.dishBadges) return S.planBlocked(res, 'dishBadges', 'Bestseller & chef special tags are on Growth and Ultra');
    it.tags = b.tags.map(String).slice(0, 6);
  }
  if (b.price !== undefined && Number(b.price) < 0) return bad(res, 'Price cannot be negative');
  const extra = dishExtras(b, f, it);
  if (extra.error) return extra.error(res);
  Object.assign(it, extra.patch);
  if (Array.isArray(b.variants)) it.variants = b.variants.map((v) => ({ id: v.id || id('v'), name: v.name, price: Number(v.price) || 0 }));
  const ph = dishImages(b, f, res);
  if (ph.error) return ph.error();
  if (ph.list) { it.images = ph.list; it.imageUrl = ph.list[0] || ''; }
  if (!r.categories.includes(it.category)) r.categories.push(it.category);
  r.categories = r.categories.filter((n) => r.items.some((i) => i.category === n));
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true, item: it });
});

/* Bulk price change: percent or flat ₹, optionally one section, rounded to a friendly step. */
router.post('/menu/items/bulk-price', (req, res) => {
  const r = req.rest;
  const b = req.body || {};
  const mode = b.mode === 'flat' ? 'flat' : 'percent';
  const value = Number(b.value);
  const step = [1, 5, 10].includes(Number(b.round)) ? Number(b.round) : 1;
  if (!isFinite(value) || value === 0) return bad(res, 'Enter how much to change prices by');
  if (mode === 'percent' && (value < -90 || value > 300)) return bad(res, 'Percent change must be between -90% and 300%');
  if (mode === 'flat' && Math.abs(value) > 100000) return bad(res, 'That change is too large');
  const cat = typeof b.category === 'string' && b.category ? b.category : null;
  const ids = Array.isArray(b.itemIds) ? new Set(b.itemIds.map(String)) : null;
  const next = (p) => {
    const raw = mode === 'percent' ? p * (1 + value / 100) : p + value;
    return Math.max(0, Math.round(raw / step) * step);
  };
  let changed = 0;
  for (const it of r.items) {
    if (cat && it.category !== cat) continue;
    if (ids && !ids.has(it.id)) continue;
    const priced = (it.price || 0) > 0 || (it.variants || []).some((v) => (v.price || 0) > 0);
    if (!priced) continue;
    if ((it.price || 0) > 0) it.price = next(it.price);
    if (Array.isArray(it.variants)) it.variants = it.variants.map((v) => ({ ...v, price: (v.price || 0) > 0 ? next(v.price) : v.price }));
    changed += 1;
  }
  if (!changed) return bad(res, 'No priced dishes matched', 404);
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true, changed, items: r.items });
});

router.delete('/menu/items/:itemId', (req, res) => {
  const r = req.rest;
  const n = r.items.length;
  const item = r.items.find((x) => x.id === req.params.itemId);
  r.items = r.items.filter((x) => x.id !== req.params.itemId);
  if (r.items.length === n) return bad(res, 'Dish not found', 404);
  if (item) archiveRecord('items', { ...item, restaurantId: r.id, restaurantName: r.name }, 'Deleted by owner', r.phone || 'owner');
  r.categories = r.categories.filter((c) => r.items.some((i) => i.category === c));
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true });
});

router.put('/menu/categories', (req, res) => {
  const r = req.rest;
  const order = (req.body.categories || []).map(String);
  const known = new Set(r.categories);
  r.categories = [...order.filter((c) => known.has(c)), ...r.categories.filter((c) => !order.includes(c))];
  const renames = req.body.renames || {};
  for (const [from, to] of Object.entries(renames)) {
    if (!known.has(from) || !String(to).trim()) continue;
    r.items.forEach((i) => { if (i.category === from) i.category = String(to).trim(); });
    r.categories = r.categories.map((c) => (c === from ? String(to).trim() : c));
  }
  persistDb();
  res.json({ success: true, categories: r.categories });
});

/* ---------- subscription / coupons / trial ---------- */
router.get('/subscription', (req, res) => {
  const r = req.rest;
  const pays = inMemoryData.payments.filter((p) => p.restaurantId === r.id);
  res.json({ success: true, subscription: summary(r).subscription, payments: pays, plans: Object.values(S.getPlans()) });
});

/** Switch plan while on trial (free) – keeps the remaining trial days. */
router.post('/subscription/switch-trial-plan', (req, res) => {
  const r = req.rest;
  const { plan } = req.body || {};
  if (!S.getPlans()[plan]) return bad(res, 'Unknown plan');
  if (S.subscriptionState(r).status !== 'trial') return bad(res, 'Plan can be switched freely only during the trial');
  r.subscription.plan = plan; r.currentPlan = plan; r.plan = plan;
  persistDb();
  res.json({ success: true, restaurant: summary(r) });
});

/**
 * Paying happens on the website (no payment gateway, no in-app purchase): the app asks for a one-time
 * checkout link, the website shows the bill, takes the UPI payment + reference, and the admin verifies it.
 */
router.post('/subscription/checkout-link', (req, res) => {
  const r = req.rest;
  const plan = (req.body || {}).plan || r.subscription.plan;
  if (!S.getPlans()[plan]) return bad(res, 'Unknown plan');
  const crypto = require('crypto');
  const co = { id: crypto.randomBytes(12).toString('hex'), restaurantId: r.id, plan, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString() };
  inMemoryData.checkouts = (inMemoryData.checkouts || []).filter((c) => new Date(c.expiresAt).getTime() > Date.now());
  inMemoryData.checkouts.unshift(co);
  persistDb();
  res.json({ success: true, url: `${S.menuBaseUrl()}/pay/${co.id}`, expiresAt: co.expiresAt });
});

/* ---------- orders / kitchen (Growth & Ultra) ---------- */
const { calculateOrderBill } = require('../utils/calculator');
function needOrdering(req, res, next) {
  if (!S.subscriptionState(req.rest).features.ordering) return S.planBlocked(res, 'ordering', 'Table ordering & the live kitchen screen are on Growth and Ultra');
  next();
}
const FLOW = { pending: ['cooking', 'cancelled'], cooking: ['ready', 'cancelled'], ready: ['served'], served: [], cancelled: [] };
router.get('/orders', needOrdering, (req, res) => {
  const mine = inMemoryData.orders.filter((o) => o.restaurantId === req.rest.id).slice(0, 300);
  const counts = {};
  for (const o of mine) counts[o.status] = (counts[o.status] || 0) + 1;
  const today = new Date().toISOString().slice(0, 10);
  const revenueToday = mine.filter((o) => o.status !== 'cancelled' && (o.createdAt || '').slice(0, 10) === today).reduce((n, o) => n + (o.totalAmount || 0), 0);
  res.json({ success: true, orders: mine, counts, revenueToday });
});
router.patch('/orders/:oid/status', needOrdering, (req, res) => {
  const o = inMemoryData.orders.find((x) => x.id === req.params.oid && x.restaurantId === req.rest.id);
  if (!o) return bad(res, 'Order not found', 404);
  const st = (req.body || {}).status;
  if (!(FLOW[o.status] || []).includes(st)) return bad(res, `Cannot move an order from ${o.status} to ${st}`, 409);
  o.status = st; o.updatedAt = new Date().toISOString();
  persistDb();
  RT.orderUpdate(o);
  res.json({ success: true, order: o });
});
/** Staff / waiter punches an order for a table. */
router.post('/orders', needOrdering, (req, res) => {
  const r = req.rest;
  const { tableNumber, items, customerNotes } = req.body || {};
  if (!tableNumber) return bad(res, 'Choose a table');
  if (!Array.isArray(items) || !items.length) return bad(res, 'Add at least one dish');
  const lines = [];
  for (const it of items) {
    const d = r.items.find((x) => x.id === it.dishId);
    if (!d) return bad(res, 'Dish not found', 404);
    const qty = parseInt(it.qty, 10);
    if (!(qty >= 1 && qty <= 50)) return bad(res, 'Invalid quantity');
    lines.push({ dishId: d.id, name: d.name, qty, price: S.effectivePrice(r, d, null), modifiers: [], notes: null });
  }
  const billing = calculateOrderBill({ items: lines, taxRatePercent: r.taxPercent || 0, discountPercent: 0 });
  r.orderSeq = (r.orderSeq || 0) + 1;
  const order = { id: `${r.shortId}-${r.orderSeq}`, token: r.orderSeq, trackKey: '', restaurantId: r.id, tableNumber: String(tableNumber), customer: { name: 'Walk-in', phone: '' }, status: 'pending', items: lines, billing, totalAmount: billing.grandTotal, customerNotes: customerNotes || null, orderType: String(tableNumber) === 'Takeaway' ? 'takeaway' : 'dine_in', payment: { status: 'unpaid', method: null }, source: 'staff', createdAt: new Date().toISOString() };
  inMemoryData.orders.unshift(order);
  persistDb();
  RT.orderNew(r, order);
  res.status(201).json({ success: true, order });
});

/* ---------- notifications ---------- */
router.get('/notifications', (req, res) => {
  const list = req.rest.notifications.slice(0, 60);
  res.json({ success: true, notifications: list, unread: req.rest.notifications.filter((n) => !n.read).length });
});
router.post('/notifications/read', (req, res) => {
  const ids = (req.body || {}).ids;
  req.rest.notifications.forEach((n) => { if (!ids || ids.includes(n.id)) n.read = true; });
  persistDb();
  res.json({ success: true });
});
router.get('/feedback', (req, res) => res.json({ success: true, feedbacks: inMemoryData.feedbacks.filter((f) => f.restaurantId === req.rest.id).slice(0, 100) }));

/* ---------- account (owner profile) ---------- */
router.patch('/account', (req, res) => {
  const r = req.rest; const b = req.body || {};
  if ((typeof b.ownerName === 'string' && b.ownerName.trim() !== r.ownerName) || (typeof b.phone === 'string' && b.phone.replace(/\s/g, '') !== String(r.phone).replace(/\s/g, ''))) {
    return bad(res, 'Your name and mobile number are fixed after sign-up. Contact support if they need correcting.', 403);
  }
  if (typeof b.email === 'string') {
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return bad(res, 'Enter a valid email');
    r.email = b.email.trim().toLowerCase();
  }
  persistDb();
  res.json({ success: true, restaurant: summary(r) });
});
router.post('/account/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!S.verifyPassword(current, req.rest.owner)) return bad(res, 'Current password is wrong', 403);
  if (!next || String(next).length < 6) return bad(res, 'New password must be at least 6 characters');
  req.rest.owner = S.hashPassword(next);
  persistDb();
  res.json({ success: true });
});

/* ---------- dish photo upload ---------- */
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const ImageVault = require('../services/imageVault');
const uploadDir = path.join(__dirname, '../../uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 }, fileFilter: (q, f, cb) => cb(null, f.mimetype.startsWith('image/')) });
router.post('/upload', upload.single('image'), async (req, res) => {
  const kind = String(req.query.kind || 'dish');
  const f = S.subscriptionState(req.rest).features;
  if (kind === 'dish' && !(f.photosPerDish > 0)) return S.planBlocked(res, 'photosPerDish');
  if (kind === 'cover' && !f.coverImage) return S.planBlocked(res, 'coverImage');
  if (!req.file) return bad(res, 'No image received');
  try {
    const name = `${req.rest.shortId}_${Date.now().toString(36)}.webp`;
    await sharp(req.file.buffer).rotate().resize(1000, 1000, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(uploadDir, name));
    ImageVault.preserveFile(name);
    const origin = process.env.PUBLIC_API_URL || 'https://qrmenu.piyushassudani.in';
    res.json({ success: true, url: `${origin.replace(/\/$/, '')}/uploads/${name}` });
  } catch (_) { bad(res, 'Could not process that image', 422); }
});

/* ---------- analytics (Growth+) ---------- */
router.get('/analytics', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  if (!f.analytics) return S.planBlocked(res, 'analytics', 'Scan & dish analytics are on Growth and Ultra');
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * S.DAY).toISOString().slice(0, 10);
    days.push({ date: d, scans: (r.scanDaily && r.scanDaily[d]) || 0 });
  }
  const top = [...r.items].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5).map((i) => ({ name: i.name, views: i.views || 0 }));
  const orders = inMemoryData.orders.filter((o) => o.restaurantId === r.id && o.status !== 'cancelled');
  const sold = {};
  for (const o of orders) for (const l of o.items) sold[l.name] = (sold[l.name] || 0) + l.qty;
  const bestSellers = Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty }));
  const revenue = orders.reduce((n, o) => n + (o.totalAmount || 0), 0);
  res.json({ success: true, totalScans: r.totalScans || 0, days, top, bestSellers, orderCount: orders.length, revenue, avgOrder: orders.length ? Math.round(revenue / orders.length) : 0 });
});

router.use(require('./ownerOps'));
router.use(require('./ownerAdvanced'));

module.exports = router;
module.exports.summary = summary;
