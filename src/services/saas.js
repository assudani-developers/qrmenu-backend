/**
 * SaaS core: plans & feature gates, 7-day trial, coupons, theming, public URLs.
 * Everything lives in the same atomic db.json as the rest of the platform.
 */
const crypto = require('crypto');
const { inMemoryData, persistDb, rebuildIndexes } = require('../db');

const TRIAL_DAYS = 7;
const DAY = 24 * 3600 * 1000;

/** Public base URL where customer menus are hosted (the Next.js app). */
const menuBaseUrl = () => (process.env.PUBLIC_MENU_BASE_URL || 'https://qrmenu-website-three.vercel.app').replace(/\/$/, '');

/**
 * SEED DATA ONLY. On first boot these are written into the database (adminConfig.*); from then on the
 * database is the single source of truth and the admin panel edits it. Nothing below is read at runtime
 * except to seed an empty database.
 */
const SEED_TEMPLATES = [
  // ---- Starter (3)
  { id: 'haveli', tier: 'starter', name: 'Haveli', blurb: 'Warm ivory & saffron, timeless', primary: '#C2410C', accent: '#3B1D0F', background: '#FFF8EE', surface: '#FFFFFF', text: '#2B160A', muted: '#7A5B48', font: 'serif', radius: 18, layout: 'list', header: 'hero', dark: false },
  { id: 'minimal', tier: 'starter', name: 'Minimal', blurb: 'Clean, calm and very fast', primary: '#111827', accent: '#111827', background: '#FFFFFF', surface: '#F7F7F8', text: '#111827', muted: '#6B7280', font: 'sans', radius: 12, layout: 'list', header: 'centered', dark: false },
  { id: 'cafe', tier: 'starter', name: 'Café Latte', blurb: 'Cosy browns, rounded cards', primary: '#8A5A2B', accent: '#3B2417', background: '#F7EFE5', surface: '#FFFBF6', text: '#3B2417', muted: '#8C6E58', font: 'rounded', radius: 22, layout: 'cards', header: 'centered', dark: false },
  // ---- Growth (+3)
  { id: 'chaat', tier: 'growth', name: 'Chaat Street', blurb: 'Loud, hungry, appetising', primary: '#E11D48', accent: '#7C2D12', background: '#FFF7E6', surface: '#FFFFFF', text: '#431407', muted: '#9A5B3C', font: 'display', radius: 16, layout: 'grid', header: 'band', dark: false },
  { id: 'garden', tier: 'growth', name: 'Garden Fresh', blurb: 'Leafy greens for healthy kitchens', primary: '#15803D', accent: '#14532D', background: '#F3F8F1', surface: '#FFFFFF', text: '#14301F', muted: '#5B7564', font: 'sans', radius: 20, layout: 'cards', header: 'hero', dark: false },
  { id: 'indigo', tier: 'growth', name: 'Indigo Modern', blurb: 'Bold cards, crisp and fresh', primary: '#4F46E5', accent: '#1E1B4B', background: '#F6F7FB', surface: '#FFFFFF', text: '#111132', muted: '#63647E', font: 'sans', radius: 24, layout: 'grid', header: 'band', dark: false },
  // ---- Ultra (+4)
  { id: 'luxe', tier: 'ultra', name: 'Luxe Noir', blurb: 'Black & gold fine dining', primary: '#D4AF37', accent: '#F5E6B3', background: '#0C0B0A', surface: '#171512', text: '#F5F0E6', muted: '#A69C88', font: 'elegant', radius: 14, layout: 'list', header: 'hero', dark: true },
  { id: 'maharaja', tier: 'ultra', name: 'Maharaja', blurb: 'Royal plum with gold leaf', primary: '#E0B65A', accent: '#FCE7B2', background: '#1E0E24', surface: '#2A1532', text: '#FBF4FF', muted: '#C3A9CC', font: 'elegant', radius: 18, layout: 'cards', header: 'hero', dark: true },
  { id: 'coastal', tier: 'ultra', name: 'Konkan Coast', blurb: 'Sea teal & coral, breezy', primary: '#F97366', accent: '#0F4C5C', background: '#F1F8F8', surface: '#FFFFFF', text: '#0B2E36', muted: '#4F7179', font: 'rounded', radius: 22, layout: 'grid', header: 'hero', dark: false },
  { id: 'neon', tier: 'ultra', name: 'Midnight Neon', blurb: 'Night-out glow for bars & lounges', primary: '#22D3EE', accent: '#C084FC', background: '#0A0A14', surface: '#13131F', text: '#EEF2FF', muted: '#9CA3C4', font: 'display', radius: 20, layout: 'cards', header: 'band', dark: true },
];

const SEED_QR_THEMES = [
  // fg = code colour, bg/bg2 = card gradient, ink = text on card, frame = border colour, dots = round modules
  { id: 'plain', tier: 'starter', name: 'Plain', blurb: 'Just the code', fg: '#111111', bg: '#FFFFFF', bg2: '#FFFFFF', ink: '#111111', frame: '#E5E7EB', dots: false },
  { id: 'classic', tier: 'starter', name: 'Saffron', blurb: 'Warm saffron card', fg: '#2B160A', bg: '#F59E0B', bg2: '#C2410C', ink: '#FFFFFF', frame: '#FFFFFF', dots: true },
  { id: 'mono', tier: 'starter', name: 'Mono', blurb: 'Crisp black on white', fg: '#000000', bg: '#FFFFFF', bg2: '#F3F4F6', ink: '#000000', frame: '#000000', dots: false },
  { id: 'sunset', tier: 'growth', name: 'Sunset', blurb: 'Orange to pink glow', fg: '#3B0A1E', bg: '#FB923C', bg2: '#DB2777', ink: '#FFFFFF', frame: '#FFFFFF', dots: true },
  { id: 'forest', tier: 'growth', name: 'Forest', blurb: 'Deep green & cream', fg: '#0F2E1D', bg: '#166534', bg2: '#052E16', ink: '#FEF9E7', frame: '#FEF9E7', dots: true },
  { id: 'ocean', tier: 'growth', name: 'Ocean', blurb: 'Fresh blues', fg: '#0C2A44', bg: '#0EA5E9', bg2: '#1E3A8A', ink: '#FFFFFF', frame: '#FFFFFF', dots: true },
  { id: 'noir', tier: 'ultra', name: 'Noir Gold', blurb: 'Black card, gold code', fg: '#111111', bg: '#1A1712', bg2: '#050505', ink: '#E8C872', frame: '#D4AF37', dots: true },
  { id: 'gold', tier: 'ultra', name: 'Gold Foil', blurb: 'Cream with a gold border', fg: '#3A2A08', bg: '#FFF8E6', bg2: '#F3E3B5', ink: '#6B4E0E', frame: '#C9A23A', dots: false },
  { id: 'royal', tier: 'ultra', name: 'Royal Plum', blurb: 'Plum & gold, festive', fg: '#2A0F33', bg: '#5B2179', bg2: '#260A33', ink: '#F7D98B', frame: '#F7D98B', dots: true },
  { id: 'tent', tier: 'ultra', name: 'Table Tent', blurb: 'Print and fold for tables', fg: '#111111', bg: '#FFFFFF', bg2: '#FFF7ED', ink: '#7C2D12', frame: '#F59E0B', dots: true },
];

const tierIds = (list, tiers) => list.filter((x) => tiers.includes(x.tier)).map((x) => x.id);

const SEED_PLANS = [
  {
    id: 'starter', name: 'Starter', tagline: 'A beautiful QR menu, live today', price: 199, color: '#0EA5E9', order: 1,
    description: 'Your full menu on every phone in seconds — logo, cover photo, a photo for every dish, offers banner and your Instagram, WhatsApp and map buttons. Unlimited dishes and unlimited scans.',
    bestFor: 'Cafés, chai points, sweet shops & counters',
    features: {
      templates: tierIds(SEED_TEMPLATES, ['starter']), qrThemes: tierIds(SEED_QR_THEMES, ['starter']),
      photosPerDish: 1, coverImage: true, announcement: true, socialLinks: true, reviewInterceptor: true,
      dishBadges: false, offers: false, addons: false, ordering: false, tableQr: false, maxTables: 0, serviceCalls: false,
      analytics: false, customers: false, menuScheduling: false, reservations: false, inventory: false,
      removeBranding: false, prioritySupport: false,
    },
  },
  {
    id: 'growth', name: 'Growth', tagline: 'Orders from the table to your kitchen', price: 399, color: '#F59E0B', order: 2,
    description: 'Everything in Starter plus table ordering, a live kitchen screen with printed slips, call-waiter buttons, offer prices, add-ons, bestseller tags, 3 photos per dish and sales reports.',
    bestFor: 'Restaurants & busy cafés',
    features: {
      templates: tierIds(SEED_TEMPLATES, ['starter', 'growth']), qrThemes: tierIds(SEED_QR_THEMES, ['starter', 'growth']),
      photosPerDish: 3, coverImage: true, announcement: true, socialLinks: true, reviewInterceptor: true,
      dishBadges: true, offers: true, addons: true, ordering: true, tableQr: true, maxTables: 15, serviceCalls: true,
      analytics: true, customers: false, menuScheduling: false, reservations: false, inventory: false,
      removeBranding: false, prioritySupport: false,
    },
  },
  {
    id: 'ultra', name: 'Ultra', tagline: 'Everything, for the serious restaurant', price: 699, color: '#8B5CF6', order: 3, popular: true, badge: 'Best value',
    description: 'Everything in Growth plus all 10 premium menu designs and QR designs, unlimited tables, your guest list, table bookings, timed breakfast/lunch sections, stock tracking, no “Powered by” branding and priority support.',
    bestFor: 'Full-service restaurants, bars & fine dining',
    features: {
      templates: tierIds(SEED_TEMPLATES, ['starter', 'growth', 'ultra']), qrThemes: tierIds(SEED_QR_THEMES, ['starter', 'growth', 'ultra']),
      photosPerDish: 3, coverImage: true, announcement: true, socialLinks: true, reviewInterceptor: true,
      dishBadges: true, offers: true, addons: true, ordering: true, tableQr: true, maxTables: 999, serviceCalls: true,
      analytics: true, customers: true, menuScheduling: true, reservations: true, inventory: true,
      removeBranding: true, prioritySupport: true,
    },
  },
];

const SEED_CATALOG = [
  { key: 'items', label: 'Dishes on your menu', group: 'Menu', type: 'text', values: { starter: 'Unlimited', growth: 'Unlimited', ultra: 'Unlimited' } },
  { key: 'scans', label: 'Menu scans by guests', group: 'Menu', type: 'text', values: { starter: 'Unlimited', growth: 'Unlimited', ultra: 'Unlimited' } },
  { key: 'photoScan', label: 'Import menu from a photo', group: 'Menu', type: 'text', values: { starter: 'Unlimited', growth: 'Unlimited', ultra: 'Unlimited' } },
  { key: 'photosPerDish', label: 'Photos per dish', group: 'Menu', type: 'number' },
  { key: 'templates', label: 'Premium menu designs', group: 'Look', type: 'count' },
  { key: 'qrThemes', label: 'QR code designs', group: 'Look', type: 'count' },
  { key: 'coverImage', label: 'Logo & cover photo', group: 'Look', type: 'bool' },
  { key: 'announcement', label: 'Offers banner on menu', group: 'Look', type: 'bool' },
  { key: 'socialLinks', label: 'Instagram, WhatsApp & map buttons', group: 'Look', type: 'bool' },
  { key: 'reviewInterceptor', label: 'Guest feedback & Google review link', group: 'Look', type: 'bool' },
  { key: 'dishBadges', label: 'Bestseller & chef special tags', group: 'Look', type: 'bool' },
  { key: 'ordering', label: 'Order from the table', group: 'Orders', type: 'bool' },
  { key: 'kitchen', label: 'Live kitchen screen & printed slips', group: 'Orders', type: 'bool', from: 'ordering' },
  { key: 'serviceCalls', label: 'Call waiter / ask for bill', group: 'Orders', type: 'bool' },
  { key: 'offers', label: 'Offer prices & happy hours', group: 'Orders', type: 'bool' },
  { key: 'addons', label: 'Add-ons (extra cheese, dips…)', group: 'Orders', type: 'bool' },
  { key: 'maxTables', label: 'Tables', group: 'Orders', type: 'number' },
  { key: 'analytics', label: 'Sales reports & best sellers', group: 'Business', type: 'bool' },
  { key: 'customers', label: 'Guest list & export', group: 'Business', type: 'bool' },
  { key: 'reservations', label: 'Table bookings from your menu', group: 'Business', type: 'bool' },
  { key: 'menuScheduling', label: 'Timed sections (breakfast, lunch…)', group: 'Business', type: 'bool' },
  { key: 'inventory', label: 'Stock tracking & low-stock alerts', group: 'Business', type: 'bool' },
  { key: 'removeBranding', label: 'No “Powered by QR Menu Pro”', group: 'Brand', type: 'bool' },
  { key: 'prioritySupport', label: 'Priority phone support', group: 'Brand', type: 'bool' },
];

const SEED_SETTINGS = { trialDays: 7, trialEnabled: true, maintenanceMode: false, signupsOpen: true, appPaymentLinks: true, brandName: 'QR Menu Pro' };

/* ---------- database-backed catalogue (the only runtime source) ---------- */
let seeded = false;
const cfg = () => {
  if (!seeded) { seeded = true; seedCatalogue(); }
  return inMemoryData.adminConfig;
};
const PLAN_ORDER = ['starter', 'growth', 'ultra'];
const planOrder = () => Object.values(cfg().plans).sort((a, b) => (a.order || 0) - (b.order || 0)).map((p) => p.id);
const catalog = () => {
  const c = cfg().featureCatalog;
  // one QR per restaurant now: older databases still call this "Table QR codes"
  for (const r of c || []) if (r.key === 'maxTables' && r.label === 'Table QR codes') r.label = 'Tables';
  return c;
};
const templates = () => cfg().templates;
const qrThemes = () => cfg().qrThemes;
const templateById = (id) => templates().find((t) => t.id === id);
const qrThemeById = (id) => qrThemes().find((t) => t.id === id);
function templateList() { return templates(); }

/** Plans as stored in the database (admin edits these directly). */
function getPlans() {
  const out = {};
  for (const id of planOrder()) out[id] = cfg().plans[id];
  return out;
}

/** Cheapest plan that unlocks a feature, includes a list value (template / QR design) or allows at least N (number). */
function requiredPlanFor(feature, listValue) {
  const plans = getPlans();
  for (const id of planOrder()) {
    const v = plans[id] && plans[id].features[feature];
    if (typeof listValue === 'number' ? typeof v === 'number' && v >= listValue : listValue !== undefined ? Array.isArray(v) && v.includes(listValue) : v === true || (typeof v === 'number' && v > 0)) return id;
  }
  return planOrder().slice(-1)[0];
}

/** Standard 403 for anything a plan does not include — clients show an upgrade sheet when `upgrade` is true. */
function planBlocked(res, feature, message, listValue) {
  const need = requiredPlanFor(feature, listValue);
  const plan = getPlans()[need];
  return res.status(403).json({ success: false, upgrade: true, feature, requiredPlan: need, message: message || `This is on the ${plan ? plan.name : 'higher'} plan` });
}

const DEFAULT_THEME = {
  template: 'haveli', logoUrl: '', coverUrl: '', welcome: '', announcement: '', currency: '₹', showVegToggle: true, showSearch: true, qrTheme: 'classic',
};

/** Seed or repair the catalogue in the database (idempotent). Old plans (elite/master) are folded into Ultra. */
function seedCatalogue() {
  seeded = true;
  const c = inMemoryData.adminConfig;
  const plans = c.plans || {};
  const valid = PLAN_ORDER.every((id) => plans[id] && plans[id].features && Array.isArray(plans[id].features.templates));
  if (!valid || Object.keys(plans).some((k) => !PLAN_ORDER.includes(k))) {
    c.plans = Object.fromEntries(SEED_PLANS.map((p) => [p.id, JSON.parse(JSON.stringify(p))]));
  }
  if (!Array.isArray(c.templates) || !c.templates.length) c.templates = JSON.parse(JSON.stringify(SEED_TEMPLATES));
  if (!Array.isArray(c.qrThemes) || !c.qrThemes.length) c.qrThemes = JSON.parse(JSON.stringify(SEED_QR_THEMES));
  if (!Array.isArray(c.featureCatalog) || !c.featureCatalog.length || c.featureCatalog.some((f) => f.key === 'aiScansPerMonth')) c.featureCatalog = JSON.parse(JSON.stringify(SEED_CATALOG));
  c.settings = { ...SEED_SETTINGS, ...(c.settings || {}) };
  c.adminUpiId = c.adminUpiId || process.env.ADMIN_UPI_ID || '';
  c.payeeName = c.payeeName || c.settings.brandName || 'QR Menu Pro';
}

function ensureCollections() {
  const d = inMemoryData;
  d.coupons = d.coupons || [];
  d.leads = d.leads || [];
  d.payments = d.payments || [];
  d.activities = d.activities || [];
  d.feedbacks = d.feedbacks || [];
  d.orders = d.orders || [];
  d.checkouts = d.checkouts || [];
  d.pushSubs = d.pushSubs || [];
  seedCatalogue();
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
  if (!PLAN_ORDER.includes(r.subscription.plan)) r.subscription.plan = 'ultra'; // elite / master -> ultra
  const th = { ...DEFAULT_THEME, ...(r.theme || {}) };
  if (!templateById(th.template)) th.template = DEFAULT_THEME.template;
  if (!qrThemeById(th.qrTheme)) th.qrTheme = DEFAULT_THEME.qrTheme;
  r.theme = th;
  r.locked = r.locked !== false; // restaurant name, owner name and phone are fixed after sign-up
  for (const it of r.items || []) {
    if (!Array.isArray(it.images)) it.images = it.imageUrl ? [it.imageUrl] : [];
    it.imageUrl = it.images[0] || '';
  }
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
  for (const k of ['voice', 'crm', 'staff', 'branches', 'aiScans', 'brandColorHex']) delete r[k];
  r.currentPlan = r.subscription.plan;
  r.plan = r.subscription.plan;
}

function migrateAll() {
  ensureCollections();
  inMemoryData.restaurants.forEach(migrateRestaurant);
  persistDb();
}

/** Compute live subscription state (trial / active / grace_period / expired). */
function subscriptionState(r) {
  const s = r.subscription;
  const now = Date.now();
  let status = s.status;
  let endsAt = null;
  let inGrace = false;
  let graceDaysLeft = 0;

  if (status === 'trial') {
    endsAt = s.trialEndsAt;
    // Free trials expire immediately with no grace period
    if (new Date(endsAt).getTime() < now) status = 'expired';
  } else if (status === 'active' || status === 'grace_period') {
    endsAt = s.paidUntil;
    if (endsAt) {
      const expTime = new Date(endsAt).getTime();
      const GRACE_PERIOD_MS = 3 * DAY;
      if (now > expTime) {
        if (now <= expTime + GRACE_PERIOD_MS) {
          // Strictly for paid plans: 3-day courtesy grace period
          status = 'grace_period';
          inGrace = true;
          graceDaysLeft = Math.max(1, Math.ceil((expTime + GRACE_PERIOD_MS - now) / DAY));
        } else {
          status = 'expired';
        }
      } else {
        status = 'active';
      }
    }
  }
  if (status === 'pending') endsAt = null;
  const daysLeft = endsAt ? Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / DAY)) : 0;
  const plan = getPlans()[s.plan] || getPlans()[planOrder()[0]];
  return { plan: s.plan, status, endsAt, daysLeft, inGrace, graceDaysLeft, features: plan.features, planName: plan.name };
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
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read aloud
  do { id = Array.from(crypto.randomBytes(7), (b) => A[b % A.length]).join(''); } while (taken.has(id));
  return id;
}

function publicLinks(r) {
  const base = menuBaseUrl();
  const url = `${base}/m/${r.shortId}`; // permanent short code: the printed QR never breaks
  return {
    menuUrl: url,
    qrUrl: url,
    tableUrls: (r.tables || []).map((t) => ({ table: t, url: `${url}?t=${encodeURIComponent(t)}` })),
  };
}

/** Create a new restaurant tenant with a 7-day trial or direct pending payment. */
function createRestaurant({ name, ownerName, phone, city, plan = 'growth', password, cuisine, email, startTrial = true }) {
  const settings = inMemoryData.adminConfig.settings;
  const chosen = getPlans()[plan] ? plan : 'growth';
  const now = Date.now();
  const trialOn = startTrial !== false && settings.trialEnabled !== false;
  const slug = uniqueSlug(name);
  const r = {
    id: `rest-${crypto.randomBytes(5).toString('hex')}`,
    name: String(name).trim(),
    ownerName: ownerName || 'Owner',
    phone: String(phone || '').trim(),
    email: email ? String(email).trim().toLowerCase() : '',
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
    tables: (getPlans()[chosen].features.maxTables || 0) > 0 ? ['Table 1', 'Table 2', 'Table 3', 'Table 4'] : [],
    categories: [],
    items: [],
    subscription: {
      plan: chosen,
      status: trialOn ? 'trial' : (startTrial === false ? 'pending' : 'expired'),
      trialStartedAt: trialOn ? new Date(now).toISOString() : null,
      trialEndsAt: trialOn ? new Date(now + (settings.trialDays || TRIAL_DAYS) * DAY).toISOString() : null,
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
  TRIAL_DAYS, DAY, PLAN_ORDER, planOrder, catalog, templates, qrThemes, templateById, qrThemeById, requiredPlanFor, planBlocked, templateList, DEFAULT_THEME, getPlans, migrateAll, migrateRestaurant, subscriptionState, seedCatalogue,
  SEED_PLANS, SEED_TEMPLATES, SEED_QR_THEMES, SEED_CATALOG,
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

/**
 * Price for a restaurant paying for `planId`: coupon first, then — when moving up from a paid plan that still has
 * days left — a credit for those unused days, so upgrading costs only the difference. The new plan runs 30 days from today.
 */
function quoteFor(r, planId, code) {
  const q = priceWithCoupon(planId, code);
  if (!q.ok || !r) return q;
  const st = subscriptionState(r);
  const cur = getPlans()[r.subscription.plan];
  const next = getPlans()[planId];
  const left = r.subscription.paidUntil ? (new Date(r.subscription.paidUntil).getTime() - Date.now()) / DAY : 0;
  if ((st.status === 'active' || st.status === 'grace_period') && cur && next && next.price > cur.price && left > 0.5) {
    const daysRemaining = Math.ceil(Math.min(30, left));
    const daysUsed = Math.max(0, 30 - daysRemaining);
    const perDay = Number((cur.price / 30).toFixed(1));
    const credit = Math.min(q.final, Math.round((cur.price * Math.min(30, left)) / 30));
    if (credit > 0) {
      const finalPrice = Math.max(0, q.final - credit);
      Object.assign(q, {
        credit,
        creditPlan: cur.name,
        creditDays: daysRemaining,
        daysUsed,
        curPrice: cur.price,
        perDay,
        final: finalPrice,
        upgrade: true,
        breakdownHinglish: `${cur.name} plan ₹${cur.price} ka tha (₹${perDay}/din). Aapne ${daysUsed} din use kiye aur ${daysRemaining} din bache hain, isliye ₹${credit} credit minus ho gaya. Naye ${next.name} plan ke liye aapko sirf ₹${finalPrice} pay karna hai.`,
        breakdownEnglish: `You used ${daysUsed} days of ${cur.name} and have ${daysRemaining} days remaining (₹${credit} credit applied). Upgrading to ${next.name} costs only the difference: ₹${finalPrice}.`,
      });
    }
  }
  return q;
}

/**
 * Switch a payment on: the plan becomes the paid plan (features follow it everywhere — a trial on Ultra that pays
 * for Starter gets Starter limits), 30 days are added. Nothing the owner made is deleted, so moving back up restores it.
 */
function activatePayment(p, r, { by = 'admin', auto = false } = {}) {
  p.status = 'verified';
  p.verifiedAt = new Date().toISOString();
  p.verifiedBy = auto ? 'auto' : by;
  if (!r) return;
  const base = p.upgrade ? Date.now() : Math.max(Date.now(), new Date(r.subscription.paidUntil || 0).getTime());
  r.subscription.plan = p.planId; r.subscription.status = 'active';
  r.subscription.paidUntil = new Date(base + 30 * DAY).toISOString();
  r.currentPlan = p.planId; r.plan = p.planId; r.isActive = true; r.mrr = p.amount;
  delete r.subscription.pendingPaymentId;
  p.expiryExtendedTo = r.subscription.paidUntil;
}

/** The design actually shown: the saved one if the plan includes it, else the plan's first design (saved choice is kept). */
function effectiveTemplate(r, features) {
  const allowed = (features && features.templates) || [];
  const id = r.theme && r.theme.template;
  return templateById(allowed.includes(id) ? id : allowed[0]) || templateById(id) || templates()[0];
}
function effectiveQrTheme(r, features) {
  const allowed = (features && features.qrThemes) || [];
  const id = r.theme && r.theme.qrTheme;
  return allowed.includes(id) ? id : allowed[0] || id;
}

module.exports.quoteFor = quoteFor;
module.exports.activatePayment = activatePayment;
module.exports.effectiveTemplate = effectiveTemplate;
module.exports.effectiveQrTheme = effectiveQrTheme;
