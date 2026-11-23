/**
 * SaaS core: plans & feature gates, 7-day trial, coupons, theming, public URLs.
 * Everything lives in the same atomic db.json as the rest of the platform.
 */
const crypto = require('crypto');
const { inMemoryData, persistDb, rebuildIndexes } = require('../db');

const TRIAL_DAYS = 7;
const DAY = 24 * 3600 * 1000;

/** Public base URL where customer menus are hosted (the Next.js app). */
const menuBaseUrl = () => (process.env.PUBLIC_MENU_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

/**
 * Default feature matrix per tier. Admin can override any value from the admin panel.
 * Menu size is UNLIMITED on every plan — plans differ by what you can do with the menu.
 */
const ALL_TEMPLATES = ['classic', 'minimal', 'modern', 'cafe', 'street', 'luxe', 'neon'];
const ALL_QR_THEMES = ['plain', 'classic', 'mono', 'bold', 'sunset', 'forest', 'ocean', 'noir', 'gold', 'neon', 'tent'];
const DEFAULT_PLANS = {
  starter: {
    id: 'starter', name: 'Starter', tagline: 'Go digital in minutes', price: 199, color: '#0EA5E9',
    description: 'Replace your paper menu with a branded QR menu that opens instantly on any phone. Unlimited dishes, always up to date.',
    bestFor: 'Chai points, counters & small cafés',
    features: {
      templates: ['classic', 'minimal'], qrThemes: ['plain', 'classic', 'mono'],
      customColors: false, customFonts: false, dishImages: false, coverImage: false, dishBadges: false,
      announcement: false, socialLinks: false, ordering: false, analytics: false, tableQr: false, maxTables: 0,
      reviewInterceptor: false, removeBranding: false, customSlug: false, prioritySupport: false,
      serviceCalls: false, offers: false, addons: false, customers: false, menuScheduling: false, reservations: false, takeaway: false,
      inventory: false, voiceAssistant: false, crmSuite: false, staffManagement: false, multiOutlet: false,
      aiScansPerMonth: 3,
    },
  },
  growth: {
    id: 'growth', name: 'Growth', tagline: 'Table orders, kitchen & insights', price: 399, color: '#F59E0B', popular: true,
    description: 'Guests order from their table, your kitchen gets a live screen with printed order slips, dish photos, your brand colours, offers banner and scan analytics.',
    bestFor: 'Restaurants & busy cafés',
    features: {
      templates: ['classic', 'minimal', 'modern', 'cafe', 'street'], qrThemes: ['plain', 'classic', 'mono', 'bold', 'sunset', 'forest', 'ocean'],
      customColors: true, customFonts: true, dishImages: true, coverImage: true, dishBadges: true,
      announcement: true, socialLinks: true, ordering: true, analytics: true, tableQr: true, maxTables: 15,
      reviewInterceptor: true, removeBranding: false, customSlug: false, prioritySupport: false,
      serviceCalls: true, offers: true, addons: true, customers: true, menuScheduling: false, reservations: false, takeaway: true,
      inventory: false, voiceAssistant: false, crmSuite: false, staffManagement: false, multiOutlet: false,
      aiScansPerMonth: 15,
    },
  },
  ultra: {
    id: 'ultra', name: 'Ultra', tagline: 'Full Inventory, Brand & 100 Tables', price: 699, color: '#8B5CF6',
    description: 'Everything in Growth plus Live Inventory Management, low-stock alerts, auto-deduction, supplier directory, Luxe & Neon templates, custom web address, no branding and 100 tables.',
    bestFor: 'Full-service restaurants, bars & busy kitchens',
    features: {
      templates: ALL_TEMPLATES, qrThemes: ALL_QR_THEMES,
      customColors: true, customFonts: true, dishImages: true, coverImage: true, dishBadges: true,
      announcement: true, socialLinks: true, ordering: true, analytics: true, tableQr: true, maxTables: 100,
      reviewInterceptor: true, removeBranding: true, customSlug: true, prioritySupport: true,
      serviceCalls: true, offers: true, addons: true, customers: true, menuScheduling: true, reservations: true, takeaway: true,
      inventory: true, voiceAssistant: false, crmSuite: false, staffManagement: false, multiOutlet: false,
      aiScansPerMonth: 999,
    },
  },
  elite: {
    id: 'elite', name: 'Ultra', tagline: 'Full Inventory, Brand & 100 Tables', price: 699, color: '#8B5CF6',
    description: 'Everything in Growth plus Live Inventory Management, low-stock alerts, auto-deduction, supplier directory, Luxe & Neon templates, custom web address, no branding and 100 tables.',
    bestFor: 'Full-service restaurants, bars & busy kitchens',
    features: {
      templates: ALL_TEMPLATES, qrThemes: ALL_QR_THEMES,
      customColors: true, customFonts: true, dishImages: true, coverImage: true, dishBadges: true,
      announcement: true, socialLinks: true, ordering: true, analytics: true, tableQr: true, maxTables: 100,
      reviewInterceptor: true, removeBranding: true, customSlug: true, prioritySupport: true,
      serviceCalls: true, offers: true, addons: true, customers: true, menuScheduling: true, reservations: true, takeaway: true,
      inventory: true, voiceAssistant: false, crmSuite: false, staffManagement: false, multiOutlet: false,
      aiScansPerMonth: 999,
    },
  },
  master: {
    id: 'master', name: 'Master', tagline: 'Complete Automation, Voice & CRM', price: 1299, color: '#EC4899', popular: false, badge: 'Flagship 👑',
    description: 'The ultimate restaurant management suite: Complete Management, Hindi/English Voice Announcements (“Bolna”) for incoming orders & kitchen, Advanced Inventory with auto-PO, Full CRM with VIP Tiers, Loyalty points & WhatsApp marketing campaigns, Multi-role Staff PINs, Multi-Branch and unlimited tables.',
    bestFor: 'Fine dine empires, high-volume dining & restaurant chains',
    features: {
      templates: ALL_TEMPLATES, qrThemes: ALL_QR_THEMES,
      customColors: true, customFonts: true, dishImages: true, coverImage: true, dishBadges: true,
      announcement: true, socialLinks: true, ordering: true, analytics: true, tableQr: true, maxTables: 500,
      reviewInterceptor: true, removeBranding: true, customSlug: true, prioritySupport: true,
      serviceCalls: true, offers: true, addons: true, customers: true, menuScheduling: true, reservations: true, takeaway: true,
      inventory: true, voiceAssistant: true, crmSuite: true, staffManagement: true, multiOutlet: true,
      aiScansPerMonth: 9999,
    },
  },
};
const PLAN_ORDER = ['starter', 'growth', 'ultra', 'master'];

/**
 * Human labels for every feature — the app, website and admin all render the comparison table from this,
 * so nothing is hidden and every client stays in sync.
 */
const FEATURE_CATALOG = [
  { key: 'items', label: 'Dishes on your menu', group: 'Menu', type: 'text', values: { starter: 'Unlimited', growth: 'Unlimited', ultra: 'Unlimited', master: 'Unlimited', elite: 'Unlimited' } },
  { key: 'aiScansPerMonth', label: 'Menu photo scans / month', group: 'Menu', type: 'number' },
  { key: 'templates', label: 'Menu designs', group: 'Look & brand', type: 'count' },
  { key: 'qrThemes', label: 'QR code designs', group: 'Look & brand', type: 'count' },
  { key: 'customColors', label: 'Your brand colours', group: 'Look & brand', type: 'bool' },
  { key: 'customFonts', label: 'Custom fonts', group: 'Look & brand', type: 'bool' },
  { key: 'coverImage', label: 'Cover photo on menu', group: 'Look & brand', type: 'bool' },
  { key: 'dishImages', label: 'Dish photos', group: 'Look & brand', type: 'bool' },
  { key: 'dishBadges', label: 'Bestseller / Chef special tags', group: 'Look & brand', type: 'bool' },
  { key: 'announcement', label: 'Offers & announcement banner', group: 'Look & brand', type: 'bool' },
  { key: 'socialLinks', label: 'Instagram, WhatsApp & map buttons', group: 'Look & brand', type: 'bool' },
  { key: 'ordering', label: 'Order from table', group: 'Orders', type: 'bool' },
  { key: 'kitchen', label: 'Live kitchen screen + printed slips', group: 'Orders', type: 'bool', from: 'ordering' },
  { key: 'takeaway', label: 'Takeaway / parcel orders', group: 'Orders', type: 'bool' },
  { key: 'addons', label: 'Add-ons & extras (cheese, dips…)', group: 'Orders', type: 'bool' },
  { key: 'serviceCalls', label: 'Call waiter / ask for bill from table', group: 'Orders', type: 'bool' },
  { key: 'tableQr', label: 'Per-table QR codes', group: 'Orders', type: 'bool' },
  { key: 'maxTables', label: 'Tables', group: 'Orders', type: 'number' },
  { key: 'inventory', label: 'Live Inventory & Stock Management', group: 'Operations', type: 'bool' },
  { key: 'voiceAssistant', label: 'Voice announcements & kitchen speaker (“Bolna”)', group: 'Operations', type: 'bool' },
  { key: 'staffManagement', label: 'Staff PINs & role permissions', group: 'Operations', type: 'bool' },
  { key: 'crmSuite', label: 'Advanced CRM, Loyalty & WhatsApp Marketing', group: 'Growth', type: 'bool' },
  { key: 'analytics', label: 'Sales reports, peak hours & analytics', group: 'Growth', type: 'bool' },
  { key: 'reviewInterceptor', label: 'Guest feedback & Google review link', group: 'Growth', type: 'bool' },
  { key: 'offers', label: 'Offer prices & happy-hour deals', group: 'Growth', type: 'bool' },
  { key: 'customers', label: 'Customer list (CRM) & export', group: 'Growth', type: 'bool' },
  { key: 'menuScheduling', label: 'Timed sections (breakfast, lunch…)', group: 'Growth', type: 'bool' },
  { key: 'reservations', label: 'Table bookings from your menu', group: 'Growth', type: 'bool' },
  { key: 'multiOutlet', label: 'Multi-branch outlet switcher', group: 'Brand control', type: 'bool' },
  { key: 'customSlug', label: 'Your own web address', group: 'Brand control', type: 'bool' },
  { key: 'removeBranding', label: 'Remove “Powered by QR Menu Pro”', group: 'Brand control', type: 'bool' },
  { key: 'prioritySupport', label: 'Priority WhatsApp & phone support', group: 'Brand control', type: 'bool' },
];

/** Cheapest plan that unlocks a feature (used for "Upgrade to X" prompts). */
function requiredPlanFor(feature) {
  const plans = getPlans();
  for (const id of PLAN_ORDER) {
    const v = plans[id] && plans[id].features[feature];
    if (v === true || (typeof v === 'number' && v > 0)) return id;
  }
  return 'master';
}

/** Standard 403 for anything a plan does not include — clients show an upgrade sheet when `upgrade` is true. */
function planBlocked(res, feature, message) {
  const need = requiredPlanFor(feature);
  const plan = getPlans()[need];
  return res.status(403).json({ success: false, upgrade: true, feature, requiredPlan: need, message: message || `Upgrade to ${plan ? plan.name : 'a higher plan'} to use this` });
}

/** Template catalogue (single source of truth — the apps load this from /api/owner/plans). */
const TEMPLATE_META = {
  classic: ['Classic', 'Warm & timeless'], minimal: ['Minimal', 'Clean, fast, calm'], modern: ['Modern', 'Bold cards, fresh'],
  cafe: ['Café', 'Cosy & rounded'], street: ['Street', 'Loud & appetising'], luxe: ['Luxe', 'Fine-dine gold on black'], neon: ['Neon', 'Night-out glow'],
};

const DEFAULT_THEME = {
  template: 'classic', primary: '#D97706', accent: '#1F0F14', background: '#FFFBF5', text: '#1F2937',
  font: 'sans', radius: 18, layout: 'list', showImages: true, darkMode: 'auto',
  logoUrl: '', coverUrl: '', welcome: '', announcement: '', currency: '₹', showVegToggle: true, showSearch: true, qrTheme: 'classic',
};

/** Each template ships a complete palette; plans with customColors may override any value afterwards. */
const TEMPLATE_PALETTES = {
  classic: { primary: '#D97706', accent: '#1F0F14', background: '#FFFBF5', text: '#1F2937', font: 'serif', radius: 18, darkMode: 'light' },
  minimal: { primary: '#111827', accent: '#111827', background: '#FFFFFF', text: '#111827', font: 'sans', radius: 10, darkMode: 'light' },
  modern:  { primary: '#6366F1', accent: '#0F172A', background: '#F8FAFC', text: '#0F172A', font: 'sans', radius: 24, darkMode: 'light' },
  cafe:    { primary: '#A16207', accent: '#3B2417', background: '#FAF3E8', text: '#3B2417', font: 'rounded', radius: 22, darkMode: 'light' },
  street:  { primary: '#EF4444', accent: '#7F1D1D', background: '#FFF7ED', text: '#431407', font: 'display', radius: 14, darkMode: 'light' },
  luxe:    { primary: '#D4AF37', accent: '#0B0B0F', background: '#0B0B0F', text: '#F5F1E6', font: 'serif', radius: 14, darkMode: 'dark' },
  neon:    { primary: '#22D3EE', accent: '#A855F7', background: '#0A0A14', text: '#E5E7EB', font: 'sans', radius: 20, darkMode: 'dark' },
};

function templateList() {
  return Object.entries(TEMPLATE_PALETTES).map(([id, p]) => ({ id, name: TEMPLATE_META[id][0], blurb: TEMPLATE_META[id][1], ...p }));
}

/** Merge admin overrides (adminConfig.plans) on top of defaults. */
function getPlans() {
  const overrides = inMemoryData.adminConfig.plans || {};
  const out = {};
  for (const [id, def] of Object.entries(DEFAULT_PLANS)) {
    const o = overrides[id] || {};
    out[id] = {
      ...def,
      name: (o.name || def.name).replace(/ Plan$/, ''),
      price: typeof o.price === 'number' ? o.price : def.price,
      tagline: o.tagline || def.tagline,
      description: o.description || def.description,
      bestFor: o.bestFor || def.bestFor,
      features: (({ maxItems, ...rest }) => rest)({ ...def.features, ...(o.features || {}) }),
      popular: def.popular || false,
      limitItems: undefined,
    };
    if (typeof o.orderingEnabled === 'boolean' && !(o.features && 'ordering' in o.features)) {
      out[id].features.ordering = o.orderingEnabled;
    }
  }
  return out;
}

function ensureCollections() {
  const d = inMemoryData;
  d.coupons = d.coupons || [];
  d.leads = d.leads || [];
  d.payments = d.payments || [];
  d.activities = d.activities || [];
  d.feedbacks = d.feedbacks || [];
  d.orders = d.orders || [];
  d.adminConfig.plans = d.adminConfig.plans || {};
  d.adminConfig.settings = { trialDays: TRIAL_DAYS, trialEnabled: true, maintenanceMode: false, signupsOpen: true, ...(d.adminConfig.settings || {}) };
  d.adminConfig.adminUpiId = d.adminConfig.adminUpiId || process.env.ADMIN_UPI_ID || '';
}

/** Upgrade legacy restaurant rows to the SaaS shape (idempotent). */
function migrateRestaurant(r) {
  if (!r.subscription) {
    r.subscription = {
      plan: r.currentPlan || r.plan || 'growth',
      status: 'active',
      trialStartedAt: null,
      trialEndsAt: null,
      paidUntil: new Date(Date.now() + 30 * DAY).toISOString(),
    };
  }
  r.theme = { ...DEFAULT_THEME, primary: r.brandColorHex || DEFAULT_THEME.primary, ...(r.theme || {}) };
  r.aiScans = r.aiScans || { month: new Date().toISOString().slice(0, 7), count: 0 };
  r.createdAt = r.createdAt || new Date().toISOString();
  r.notifications = r.notifications || [];
  r.orderSeq = r.orderSeq || 0;
  r.email = r.email || '';
  r.tables = r.tables || [];
  r.social = { instagram: '', facebook: '', whatsapp: '', website: '', maps: '', ...(r.social || {}) };
  for (const k of ['address', 'openingHours', 'fssai', 'gstin', 'about']) r[k] = r[k] || '';
  r.prefs = { orderSound: true, receiptAnimation: true, autoAccept: false, ...(r.prefs || {}) };
  r.store = { open: true, prepMinutes: 20, takeaway: true, wifiName: '', wifiPassword: '', ...(r.store || {}) };
  r.categorySchedule = r.categorySchedule || {};
  r.serviceCalls = r.serviceCalls || [];
  r.reservations = r.reservations || [];
  r.categories = r.categories || [];
  r.items = r.items || [];
  r.inventory = r.inventory || [];
  r.inventoryLogs = r.inventoryLogs || [];
  r.suppliers = r.suppliers || [];
  r.voice = { enabled: true, language: 'hi', speed: 1.0, speakDishNames: true, volume: 1.0, kitchenSpeaker: true, ...(r.voice || {}) };
  r.crm = { loyaltyRate: 10, minRedeemPoints: 50, vipThresholds: { silver: 2000, gold: 5000, platinum: 10000 }, ...(r.crm || {}) };
  r.staff = r.staff || [];
  r.branches = r.branches || [];
  r.currentPlan = r.subscription.plan;
  r.plan = r.subscription.plan;
}

function migrateAll() {
  ensureCollections();
  inMemoryData.restaurants.forEach(migrateRestaurant);
  persistDb();
}

/** Compute live subscription state (trial / active / expired). */
function subscriptionState(r) {
  const s = r.subscription;
  const now = Date.now();
  let status = s.status;
  let endsAt = null;
  if (status === 'trial') {
    endsAt = s.trialEndsAt;
    if (new Date(endsAt).getTime() < now) status = 'expired';
  } else if (status === 'active') {
    endsAt = s.paidUntil;
    if (endsAt && new Date(endsAt).getTime() < now) status = 'expired';
  }
  if (status === 'pending') endsAt = null;
  const daysLeft = endsAt ? Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / DAY)) : 0;
  const plan = getPlans()[s.plan] || getPlans().starter;
  return { plan: s.plan, status, endsAt, daysLeft, features: plan.features, planName: plan.name };
}

/** Is the public menu allowed to be served? */
function isMenuLive(r) {
  if (!r.isActive) return false;
  const st = subscriptionState(r);
  return st.status !== 'expired' && st.status !== 'pending';
}

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'restaurant';
}

function uniqueSlug(base) {
  let slug = slugify(base);
  const taken = new Set(inMemoryData.restaurants.map((r) => r.slug));
  if (!taken.has(slug)) return slug;
  let i = 2;
  while (taken.has(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

function uniqueShortId() {
  const taken = new Set(inMemoryData.restaurants.map((r) => r.shortId));
  let id;
  do { id = crypto.randomBytes(4).toString('hex').slice(0, 6); } while (taken.has(id));
  return id;
}

function publicLinks(r) {
  const base = menuBaseUrl();
  return {
    menuUrl: `${base}/menu/${r.slug}`,
    qrUrl: `${base}/q/${r.shortId}`, // permanent: survives slug renames
    tableUrls: (r.tables || []).map((t) => ({ table: t, url: `${base}/q/${r.shortId}?table=${encodeURIComponent(t)}` })),
  };
}

/** Create a new restaurant tenant with a 7-day trial. */
function createRestaurant({ name, ownerName, phone, city, plan = 'growth', password, cuisine }) {
  const settings = inMemoryData.adminConfig.settings;
  const chosen = getPlans()[plan] ? plan : 'growth';
  const now = Date.now();
  const trialOn = settings.trialEnabled !== false;
  const slug = uniqueSlug(name);
  const r = {
    id: `rest-${crypto.randomBytes(5).toString('hex')}`,
    name: String(name).trim(),
    ownerName: ownerName || 'Owner',
    phone: String(phone || '').trim(),
    city: city || '',
    cuisine: cuisine || '',
    tagline: '',
    slug,
    shortId: uniqueShortId(),
    upiId: '',
    googleReviewUrl: '',
    isActive: true,
    mrr: 0,
    totalScans: 0,
    scanLog: [],
    joinedDate: new Date(now).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    createdAt: new Date(now).toISOString(),
    brandColorHex: DEFAULT_THEME.primary,
    tables: (getPlans()[chosen].features.maxTables || 0) > 0 ? ['Table 1', 'Table 2', 'Table 3', 'Table 4'] : [],
    categories: [],
    items: [],
    subscription: {
      plan: chosen,
      status: trialOn ? 'trial' : 'expired',
      trialStartedAt: new Date(now).toISOString(),
      trialEndsAt: new Date(now + (settings.trialDays || TRIAL_DAYS) * DAY).toISOString(),
      paidUntil: null,
    },
  };
  if (password) r.owner = hashPassword(password);
  migrateRestaurant(r);
  inMemoryData.restaurants.unshift(r);
  rebuildIndexes();
  persistDb();
  return r;
}

/* ---------------- passwords ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, owner) {
  if (!owner || !owner.salt) return false;
  const h = crypto.scryptSync(String(pw), owner.salt, 32);
  const expected = Buffer.from(owner.hash, 'hex');
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}

/* ---------------- coupons ---------------- */
function findCoupon(code) {
  return inMemoryData.coupons.find((c) => c.code.toUpperCase() === String(code || '').trim().toUpperCase());
}

/** Validate a coupon against a plan. Returns {ok, error?, coupon?, original, discount, final, extraTrialDays}. */
function priceWithCoupon(planId, code) {
  const plan = getPlans()[planId];
  if (!plan) return { ok: false, error: 'Unknown plan' };
  const original = plan.price;
  if (!code) return { ok: true, original, discount: 0, final: original, extraTrialDays: 0 };
  const c = findCoupon(code);
  if (!c || !c.active) return { ok: false, error: 'Invalid coupon code' };
  if (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) return { ok: false, error: 'This coupon has expired' };
  if (c.maxUses && c.used >= c.maxUses) return { ok: false, error: 'Coupon usage limit reached' };
  if (c.plans && c.plans.length && !c.plans.includes(planId)) return { ok: false, error: `Coupon not valid for ${plan.name}` };
  let discount = 0;
  let extraTrialDays = 0;
  if (c.type === 'percent') discount = Math.round((original * Math.min(100, c.value)) / 100);
  else if (c.type === 'flat') discount = Math.min(original, c.value);
  else if (c.type === 'trial_days') extraTrialDays = c.value;
  return { ok: true, coupon: { code: c.code, description: c.description, type: c.type, value: c.value }, original, discount, final: Math.max(0, original - discount), extraTrialDays };
}

module.exports = {
  TRIAL_DAYS, DAY, DEFAULT_PLANS, FEATURE_CATALOG, PLAN_ORDER, ALL_QR_THEMES, requiredPlanFor, planBlocked, TEMPLATE_PALETTES, templateList, DEFAULT_THEME, getPlans, migrateAll, migrateRestaurant, subscriptionState,
  isMenuLive, slugify, uniqueSlug, uniqueShortId, publicLinks, menuBaseUrl, createRestaurant,
  hashPassword, verifyPassword, findCoupon, priceWithCoupon,
};

/** Add an entry to the owner's notification centre (shown in the app, drives local push alerts). */
function notify(r, { type, title, body, data = {} }) {
  r.notifications = r.notifications || [];
  const n = { id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type, title, body, data, read: false, createdAt: new Date().toISOString() };
  r.notifications.unshift(n);
  if (r.notifications.length > 200) r.notifications.length = 200;
  require('./realtime').notification(r, n);
  return n;
}
module.exports.notify = notify;

/* ---------------- time-aware menu (India time) ---------------- */
function nowMinutesIST(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const h = +p.find((x) => x.type === 'hour').value % 24;
  const m = +p.find((x) => x.type === 'minute').value;
  return h * 60 + m;
}
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
/** Is a section open right now? Windows may cross midnight (e.g. 22:00–02:00). */
function categoryOpen(r, cat, at) {
  const f = subscriptionState(r).features;
  const w = (r.categorySchedule || {})[cat];
  if (!f.menuScheduling || !w || !w.from || !w.to) return true;
  const a = toMin(w.from), b = toMin(w.to), n = at == null ? nowMinutesIST() : at;
  if (a == null || b == null || a === b) return true;
  return a < b ? n >= a && n < b : n >= a || n < b;
}
/** Price a guest actually pays for a dish (offer price only when the plan includes offers). */
function effectivePrice(r, d, variant) {
  const f = subscriptionState(r).features;
  if (variant) return variant.price;
  if (f.offers && typeof d.offerPrice === 'number' && d.offerPrice > 0 && d.offerPrice < d.price) return d.offerPrice;
  return d.price;
}
module.exports.nowMinutesIST = nowMinutesIST;
module.exports.categoryOpen = categoryOpen;
module.exports.effectivePrice = effectivePrice;
module.exports.toMin = toMin;
