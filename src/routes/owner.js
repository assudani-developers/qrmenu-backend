/**
 * Restaurant-owner API (the Flutter app). Multi-tenant: every call is scoped to the JWT's restaurant.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, generateToken } = require('../middleware/auth');
const { inMemoryData, persistDb, rebuildIndexes, findRestaurantById, recordActivity } = require('../db');
const S = require('../services/saas');
const { scanMenu } = require('../services/menuScanner');
const RT = require('../services/realtime');

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
    aiScans: { used: r.aiScans.count, limit: sub.features.aiScansPerMonth },
  };
}

function resetAiMonth(r) {
  const m = new Date().toISOString().slice(0, 7);
  if (r.aiScans.month !== m) r.aiScans = { month: m, count: 0 };
}

/* ---------- public: plans & coupon check ---------- */
router.get('/plans', (req, res) => res.json({ success: true, featureCatalog: S.FEATURE_CATALOG, planOrder: S.PLAN_ORDER, qrThemes: S.ALL_QR_THEMES, trialEnabled: inMemoryData.adminConfig.settings.trialEnabled, trialDays: inMemoryData.adminConfig.settings.trialDays, plans: Object.values(S.getPlans()), templates: S.templateList(), payment: { upiId: inMemoryData.adminConfig.adminUpiId, payee: 'QR Menu Pro' }, support: { phone: inMemoryData.adminConfig.adminPhone, email: inMemoryData.adminConfig.supportEmail } }));

router.post('/coupons/validate', (req, res) => {
  const { code, plan } = req.body || {};
  const r = S.priceWithCoupon(plan || 'growth', code);
  if (!r.ok) return bad(res, r.error);
  return res.json({ success: true, ...r });
});

/* ---------- auth ---------- */
router.post('/signup', (req, res) => {
  const { name, ownerName, phone, password, city, plan, cuisine, mode = 'trial', couponCode, utrRef } = req.body || {};
  const settings = inMemoryData.adminConfig.settings;
  if (!settings.signupsOpen) return bad(res, 'Signups are temporarily closed', 403);
  if (!name || String(name).trim().length < 2) return bad(res, 'Enter your restaurant name');
  if (!/^\+?[0-9 ]{10,15}$/.test(String(phone || ''))) return bad(res, 'Enter a valid mobile number');
  if (!password || String(password).length < 6) return bad(res, 'Password must be at least 6 characters');
  if (!S.getPlans()[plan]) return bad(res, 'Choose a package');
  const cleanPhone = String(phone).replace(/\s/g, '');
  if (inMemoryData.restaurants.some((r) => r.owner && String(r.phone).replace(/\s/g, '') === cleanPhone)) return bad(res, 'This number is already registered. Please sign in.', 409);

  let price = null;
  if (mode === 'pay') {
    if (!inMemoryData.adminConfig.adminUpiId) return bad(res, 'Online payment is not set up yet. Please start the free trial or contact support.', 503);
    if (!/^[A-Za-z0-9]{8,24}$/.test(String(utrRef || '').trim())) return bad(res, 'Enter the UPI reference / UTR number from your payment app');
    price = S.priceWithCoupon(plan, couponCode);
    if (!price.ok) return bad(res, price.error);
    if (price.coupon && price.coupon.type === 'trial_days') return bad(res, 'That coupon is for free trials — use it when starting the trial');
    if (inMemoryData.payments.some((p) => p.utrRef === String(utrRef).trim())) return bad(res, 'This payment reference was already used', 409);
  } else {
    if (settings.trialEnabled === false) return bad(res, 'Free trial is not available right now. Please choose direct payment.');
    if (couponCode) {
      price = S.priceWithCoupon(plan, couponCode);
      if (!price.ok) return bad(res, price.error);
      if (!(price.coupon && price.coupon.type === 'trial_days')) return bad(res, 'That coupon applies when you pay — switch to direct payment to use it');
    }
  }

  const r = S.createRestaurant({ name, ownerName, phone: cleanPhone, password, city, plan, cuisine });
  let payment = null;
  if (mode === 'pay') {
    r.subscription.status = 'pending';
    r.subscription.trialEndsAt = null;
    if (price.coupon) S.findCoupon(couponCode).used += 1;
    payment = {
      id: `TXN-${Date.now().toString().slice(-6)}`, restaurantId: r.id, restaurantName: r.name, ownerName: r.ownerName, phone: r.phone, planId: plan,
      amount: price.final, listPrice: price.original, coupon: price.coupon ? price.coupon.code : null, method: 'UPI', utrRef: String(utrRef).trim(),
      payeeUpi: inMemoryData.adminConfig.adminUpiId, status: 'pending', source: 'signup', date: new Date().toISOString(),
    };
    inMemoryData.payments.unshift(payment);
    RT.toAdmin('payment:new', { payment });
    recordActivity('payment', 'Signup with direct payment', `${r.name} paid ₹${price.final} for ${plan}. Awaiting verification.`);
  } else {
    if (price && price.coupon) {
      S.findCoupon(couponCode).used += 1;
      r.subscription.trialEndsAt = new Date(new Date(r.subscription.trialEndsAt).getTime() + price.extraTrialDays * S.DAY).toISOString();
    }
    recordActivity('restaurant', 'New signup', `${r.name} joined on the ${plan} trial.`);
  }
  persistDb();
  RT.toAdmin('restaurant:new', { id: r.id, name: r.name });
  return res.status(201).json({ success: true, token: generateToken({ role: 'owner', restaurantId: r.id }), restaurant: summary(r), payment });
});

router.post('/login', (req, res) => {
  const { phone, password } = req.body || {};
  const clean = String(phone || '').replace(/\s/g, '');
  const r = inMemoryData.restaurants.find((x) => x.owner && String(x.phone).replace(/\s/g, '') === clean);
  if (!r || !S.verifyPassword(password, r.owner)) return bad(res, 'Wrong mobile number or password', 401);
  return res.json({ success: true, token: generateToken({ role: 'owner', restaurantId: r.id }), restaurant: summary(r) });
});

router.use(ownerAuth);

router.get('/me', (req, res) => res.json({ success: true, restaurant: summary(req.rest), plans: Object.values(S.getPlans()), featureCatalog: S.FEATURE_CATALOG }));

/* ---------- profile ---------- */
router.patch('/profile', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  const b = req.body || {};
  if (b.taxPercent !== undefined) r.taxPercent = Math.max(0, Math.min(28, Number(b.taxPercent) || 0));
  if (typeof b.name === 'string' && b.name.trim().length < 2) return bad(res, 'Restaurant name is too short');
  if (typeof b.upiId === 'string' && b.upiId.trim() && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(b.upiId.trim())) return bad(res, 'That UPI ID does not look right (example: name@okhdfc)');
  if (typeof b.gstin === 'string' && b.gstin.trim() && !/^[0-9A-Z]{15}$/.test(b.gstin.trim().toUpperCase())) return bad(res, 'GSTIN must be 15 characters');
  if (typeof b.fssai === 'string' && b.fssai.trim() && !/^[0-9]{14}$/.test(b.fssai.trim())) return bad(res, 'FSSAI licence number must be 14 digits');
  for (const k of ['name', 'tagline', 'city', 'cuisine', 'upiId', 'googleReviewUrl', 'address', 'openingHours', 'fssai', 'about']) {
    if (typeof b[k] === 'string') r[k] = b[k].trim().slice(0, k === 'about' || k === 'address' ? 400 : 140);
  }
  if (typeof b.gstin === 'string') r.gstin = b.gstin.trim().toUpperCase();
  if (b.social && typeof b.social === 'object') {
    const filled = Object.values(b.social).some((v) => String(v || '').trim());
    if (filled && !f.socialLinks) return S.planBlocked(res, 'socialLinks', 'Instagram, WhatsApp & map buttons are on Growth and Elite');
    for (const k of ['instagram', 'facebook', 'whatsapp', 'website', 'maps']) if (typeof b.social[k] === 'string') r.social[k] = b.social[k].trim().slice(0, 200);
  }
  if (Array.isArray(b.tables)) {
    const list = [...new Set(b.tables.map((t) => String(t).trim()).filter(Boolean))];
    if (list.length > (f.maxTables || 0) && list.join('|') !== (r.tables || []).join('|')) {
      return S.planBlocked(res, f.maxTables ? 'maxTables' : 'tableQr', f.maxTables ? `Your plan includes ${f.maxTables} tables. Upgrade to add more.` : 'Tables & table ordering start on the Growth plan');
    }
    r.tables = list;
  }
  if (typeof b.slug === 'string' && b.slug !== r.slug) {
    if (!f.customSlug) return S.planBlocked(res, 'customSlug', 'Your own web address is an Elite feature');
    const s = S.slugify(b.slug);
    if (inMemoryData.restaurants.some((x) => x.slug === s && x.id !== r.id)) return bad(res, 'That address is already taken', 409);
    r.slug = s;
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

/* ---------- theme / full customisation ---------- */
router.patch('/theme', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  const b = req.body || {};
  const t = { ...r.theme };
  const hex = (v) => /^#[0-9a-fA-F]{6}$/.test(v);
  if (b.template !== undefined) {
    if (!S.TEMPLATE_PALETTES[b.template]) return bad(res, 'Unknown template');
    if (!f.templates.includes(b.template)) {
      const need = ['starter', 'growth', 'elite'].find((p) => S.getPlans()[p].features.templates.includes(b.template)) || 'elite';
      return res.status(403).json({ success: false, upgrade: true, feature: 'templates', requiredPlan: need, message: `The ${b.template} design is on the ${S.getPlans()[need].name} plan` });
    }
    t.template = b.template;
    Object.assign(t, S.TEMPLATE_PALETTES[b.template] || {}); // full palette; custom-colour plans may override below
  }
  const colorKeys = ['primary', 'accent', 'background', 'text'];
  for (const k of colorKeys) {
    if (b[k] !== undefined) {
      if (!hex(b[k])) return bad(res, `Invalid colour for ${k}`);
      if (!f.customColors && b[k] !== t[k]) return S.planBlocked(res, 'customColors', 'Your own brand colours are on Growth and Elite');
      t[k] = b[k];
    }
  }
  if (b.font !== undefined) {
    if (!['sans', 'serif', 'rounded', 'mono', 'display'].includes(b.font)) return bad(res, 'Unknown font');
    if (!f.customFonts && b.font !== t.font) return S.planBlocked(res, 'customFonts', 'Custom fonts are on Growth and Elite');
    t.font = b.font;
  }
  if (b.layout !== undefined) { if (!['list', 'grid', 'cards'].includes(b.layout)) return bad(res, 'Unknown layout'); t.layout = b.layout; }
  if (b.darkMode !== undefined) { if (!['auto', 'light', 'dark'].includes(b.darkMode)) return bad(res, 'Bad mode'); t.darkMode = b.darkMode; }
  if (b.radius !== undefined) t.radius = Math.max(0, Math.min(32, Number(b.radius) || 0));
  for (const k of ['showImages', 'showVegToggle', 'showSearch']) if (typeof b[k] === 'boolean') t[k] = b[k];
  if (typeof b.coverUrl === 'string' && b.coverUrl && !f.coverImage) return S.planBlocked(res, 'coverImage', 'A cover photo on your menu is on Growth and Elite');
  if (typeof b.announcement === 'string' && b.announcement.trim() && !f.announcement) return S.planBlocked(res, 'announcement', 'The offers banner is on Growth and Elite');
  if (b.qrTheme !== undefined) {
    if (!S.ALL_QR_THEMES.includes(b.qrTheme)) return bad(res, 'Unknown QR design');
    if (!(f.qrThemes || []).includes(b.qrTheme)) {
      const need = ['starter', 'growth', 'elite'].find((p) => (S.getPlans()[p].features.qrThemes || []).includes(b.qrTheme)) || 'elite';
      return res.status(403).json({ success: false, upgrade: true, feature: 'qrThemes', requiredPlan: need, message: `This QR design is on the ${S.getPlans()[need].name} plan` });
    }
    t.qrTheme = b.qrTheme;
  }
  for (const k of ['welcome', 'logoUrl', 'coverUrl', 'currency', 'announcement']) if (typeof b[k] === 'string') t[k] = b[k].trim().slice(0, 300);
  r.theme = t;
  r.brandColorHex = t.primary;
  persistDb();
  RT.menuUpdated(r);
  res.json({ success: true, theme: t, links: S.publicLinks(r) });
});

/* ---------- menu: photo scan -> preview -> import ---------- */
router.post('/menu/scan', async (req, res) => {
  const r = req.rest;
  const sub = S.subscriptionState(r);
  resetAiMonth(r);
  if (r.aiScans.count >= sub.features.aiScansPerMonth) return S.planBlocked(res, 'aiScansPerMonth', `You have used all ${sub.features.aiScansPerMonth} photo scans this month. Upgrade for more scans.`);
  const images = (req.body.images || []).slice(0, 6).map((i) => {
    const m = String(i.data || '').match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    return m ? { mediaType: m[1].replace('jpg', 'jpeg'), data: m[2] } : { mediaType: i.mediaType || 'image/jpeg', data: String(i.data || '') };
  }).filter((i) => i.data.length > 100);
  if (!images.length) return bad(res, 'Add at least one menu photo');
  try {
    const menu = await scanMenu(images);
    r.aiScans.count += 1;
    persistDb();
    res.json({ success: true, menu, aiScans: { used: r.aiScans.count, limit: sub.features.aiScansPerMonth } });
  } catch (e) {
    bad(res, e.message, 422);
  }
});

router.post('/menu/import', (req, res) => {
  const r = req.rest;
  const sub = S.subscriptionState(r);
  const { categories = [], replace = false, restaurantName, tagline, template, primary, accent } = req.body || {};
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
        isAvailable: true, imageUrl: '', tags: i.tags || [],
        variants: (i.variants || []).map((v) => ({ id: id('v'), name: v.name, price: Number(v.price) || 0 })),
        modifiers: [],
      });
    }
  }
  r.items = replace ? incoming : [...r.items, ...incoming];
  r.categories = catNames.filter((n) => r.items.some((i) => i.category === n));
  if (restaurantName && (replace || !r.tagline)) r.name = String(restaurantName).slice(0, 80);
  if (tagline && !r.tagline) r.tagline = String(tagline).slice(0, 140);
  if (template && sub.features.templates.includes(template)) { r.theme.template = template; Object.assign(r.theme, S.TEMPLATE_PALETTES[template] || {}); r.brandColorHex = r.theme.primary; }
  if (primary && /^#[0-9a-fA-F]{6}$/.test(primary) && sub.features.customColors) { r.theme.primary = primary; r.brandColorHex = primary; }
  if (accent && /^#[0-9a-fA-F]{6}$/.test(accent) && sub.features.customColors) r.theme.accent = accent;
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
      if (!f.offers) return { error: (res) => S.planBlocked(res, 'offers', 'Offer prices & deals are on Growth and Elite') };
      const op = Number(b.offerPrice);
      if (!(op > 0 && op < price)) return { error: (res) => bad(res, 'Offer price must be lower than the regular price') };
      patch.offerPrice = op;
    }
  }
  if (Array.isArray(b.addons)) {
    if (b.addons.length && !f.addons) return { error: (res) => S.planBlocked(res, 'addons', 'Add-ons like extra cheese are on Growth and Elite') };
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
router.post('/menu/items', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return bad(res, 'Dish name required');
  if (Number(b.price) < 0) return bad(res, 'Price cannot be negative');
  const badge = (b.tags || []).some((t) => BADGES.includes(t));
  if (badge && !f.dishBadges) return S.planBlocked(res, 'dishBadges', 'Bestseller & Chef special tags are on Growth and Elite');
  if (b.imageUrl && !f.dishImages) return S.planBlocked(res, 'dishImages', 'Dish photos are on Growth and Elite');
  const cat = String(b.category || 'Menu').trim();
  const item = {
    id: id('d'), name: String(b.name).trim(), category: cat, price: Number(b.price) || 0,
    description: String(b.description || ''), ingredients: String(b.ingredients || '').trim().slice(0, 500),
    allergens: Array.isArray(b.allergens) ? b.allergens.map(String).filter((a) => DIETS.includes(a)).slice(0, 8) : [],
    isVeg: b.isVeg !== false, spiceLevel: b.spiceLevel || 'none',
    isAvailable: true, imageUrl: f.dishImages ? String(b.imageUrl || '') : '', tags: (b.tags || []).map(String).slice(0, 6),
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
    if (b.tags.some((t) => BADGES.includes(t)) && !f.dishBadges) return S.planBlocked(res, 'dishBadges', 'Bestseller & Chef special tags are on Growth and Elite');
    it.tags = b.tags.map(String).slice(0, 6);
  }
  if (b.price !== undefined && Number(b.price) < 0) return bad(res, 'Price cannot be negative');
  const extra = dishExtras(b, f, it);
  if (extra.error) return extra.error(res);
  Object.assign(it, extra.patch);
  if (Array.isArray(b.variants)) it.variants = b.variants.map((v) => ({ id: v.id || id('v'), name: v.name, price: Number(v.price) || 0 }));
  if (typeof b.imageUrl === 'string') { if (!f.dishImages && b.imageUrl) return S.planBlocked(res, 'dishImages', 'Dish photos are on Growth and Elite'); it.imageUrl = b.imageUrl; }
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
  r.items = r.items.filter((x) => x.id !== req.params.itemId);
  if (r.items.length === n) return bad(res, 'Dish not found', 404);
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
  res.json({ success: true, subscription: summary(r).subscription, payments: pays, plans: Object.values(S.getPlans()), adminUpiId: inMemoryData.adminConfig.adminUpiId });
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

/** Start checkout: applies coupon, returns UPI intent. Trial-extension coupons apply instantly. */
router.post('/subscription/checkout', (req, res) => {
  const r = req.rest;
  const { plan, couponCode } = req.body || {};
  const price = S.priceWithCoupon(plan, couponCode);
  if (!price.ok) return bad(res, price.error);
  if (price.coupon && price.coupon.type === 'trial_days') {
    const c = S.findCoupon(couponCode);
    c.used += 1;
    const base = Math.max(Date.now(), new Date(r.subscription.trialEndsAt || Date.now()).getTime());
    r.subscription.status = 'trial';
    r.subscription.trialEndsAt = new Date(base + price.extraTrialDays * S.DAY).toISOString();
    r.subscription.plan = plan;
    r.currentPlan = plan; r.plan = plan;
    persistDb();
    return res.json({ success: true, applied: 'trial_extended', message: `${price.extraTrialDays} bonus trial days added!`, restaurant: summary(r) });
  }
  const upi = inMemoryData.adminConfig.adminUpiId;
  const uri = `upi://pay?pa=${upi}&pn=QRMenuPro&am=${price.final.toFixed(2)}&cu=INR&tn=${encodeURIComponent(`${r.shortId}-${plan}`)}`;
  res.json({ success: true, plan, ...price, adminUpiId: upi, upiIntentUri: uri });
});

/** Owner submits UTR after paying. Stays *pending* until the admin verifies it. */
router.post('/subscription/pay', (req, res) => {
  const r = req.rest;
  const { plan, couponCode, utrRef } = req.body || {};
  if (!/^[A-Za-z0-9]{8,24}$/.test(String(utrRef || '').trim())) return bad(res, 'Enter the UPI reference / UTR number from your payment app');
  const price = S.priceWithCoupon(plan, couponCode);
  if (!price.ok) return bad(res, price.error);
  if (inMemoryData.payments.some((p) => p.utrRef === String(utrRef).trim())) return bad(res, 'This reference was already submitted', 409);
  if (price.coupon) { const c = S.findCoupon(couponCode); c.used += 1; }
  const tx = {
    id: `TXN-${Date.now().toString().slice(-6)}`, restaurantId: r.id, restaurantName: r.name, ownerName: r.ownerName,
    phone: r.phone, planId: plan, amount: price.final, listPrice: price.original, coupon: price.coupon ? price.coupon.code : null,
    method: 'UPI', utrRef: String(utrRef).trim(), payeeUpi: inMemoryData.adminConfig.adminUpiId, status: 'pending', date: new Date().toISOString(),
  };
  inMemoryData.payments.unshift(tx);
  recordActivity('payment', 'Payment submitted', `${r.name} paid ₹${tx.amount} for ${plan}. Awaiting verification.`);
  persistDb();
  RT.toAdmin('payment:new', { payment: tx });
  res.json({ success: true, message: 'Payment received! We will activate your plan after verification (usually within an hour).', transaction: tx });
});


/* ---------- orders / kitchen (Growth & Elite) ---------- */
const { calculateOrderBill } = require('../utils/calculator');
function needOrdering(req, res, next) {
  if (!S.subscriptionState(req.rest).features.ordering) return S.planBlocked(res, 'ordering', 'Table ordering & the live kitchen screen are on Growth and Elite');
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
  if (typeof b.ownerName === 'string' && b.ownerName.trim()) r.ownerName = b.ownerName.trim().slice(0, 60);
  if (typeof b.email === 'string') {
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return bad(res, 'Enter a valid email');
    r.email = b.email.trim().toLowerCase();
  }
  if (typeof b.phone === 'string') {
    const p = b.phone.replace(/\s/g, '');
    if (!/^\+?[0-9]{10,15}$/.test(p)) return bad(res, 'Enter a valid mobile number');
    if (inMemoryData.restaurants.some((x) => x.id !== r.id && x.owner && String(x.phone).replace(/\s/g, '') === p)) return bad(res, 'That number is already registered', 409);
    r.phone = p;
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
const uploadDir = path.join(__dirname, '../../uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 }, fileFilter: (q, f, cb) => cb(null, f.mimetype.startsWith('image/')) });
router.post('/upload', upload.single('image'), async (req, res) => {
  const kind = String(req.query.kind || 'dish');
  const f = S.subscriptionState(req.rest).features;
  if (kind === 'dish' && !f.dishImages) return S.planBlocked(res, 'dishImages', 'Dish photos are on Growth and Elite');
  if (kind === 'cover' && !f.coverImage) return S.planBlocked(res, 'coverImage', 'A cover photo is on Growth and Elite');
  if (!req.file) return bad(res, 'No image received');
  try {
    const name = `${req.rest.shortId}_${Date.now().toString(36)}.webp`;
    await sharp(req.file.buffer).rotate().resize(1000, 1000, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(uploadDir, name));
    const origin = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, url: `${origin.replace(/\/$/, '')}/uploads/${name}` });
  } catch (_) { bad(res, 'Could not process that image', 422); }
});

/* ---------- analytics (Growth+) ---------- */
router.get('/analytics', (req, res) => {
  const r = req.rest;
  const f = S.subscriptionState(r).features;
  if (!f.analytics) return S.planBlocked(res, 'analytics', 'Scan & dish analytics are on Growth and Elite');
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
