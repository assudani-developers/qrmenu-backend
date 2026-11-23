/** End-to-end product flow against a real server process with an isolated database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}/api`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrm-'));
let server;
const call = async (method, url, body, token, headers = {}) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

test.before(async () => {
  server = spawn('node', [path.join(__dirname, '../src/server.js')], { env: { ...process.env, PORT, DB_FILE: path.join(dir, 'db.json'), OCR_PRELOAD: '0', RATE_LIMIT_MAX: '5000', ADMIN_EMAIL: 'a@t.io', ADMIN_PASSWORD: 'pw-test-1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/health')).ok) return; } catch (_) {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('server did not start');
});
test.after(async () => {
  if (server) { const done = new Promise((r) => server.once('exit', r)); server.kill(); await done; }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let growth, starter;
const menu = { categories: [{ name: 'Starters', items: [{ name: 'Paneer Tikka', price: 260, isVeg: true }, { name: 'Chicken 65', price: 290, isVeg: false, variants: [{ name: 'Half', price: 160 }, { name: 'Full', price: 290 }] }] }] };

test('signup starts a trial and returns hosted links; fresh DB has no dummy data', async () => {
  const plans = await call('GET', '/owner/plans');
  assert.deepEqual(plans.plans.map((p) => p.id), ['starter', 'growth', 'ultra']);
  assert.equal(plans.templates.length, 10);
  assert.equal(plans.qrThemes.length, 10);
  assert.deepEqual(plans.plans.map((p) => p.features.templates.length), [3, 6, 10]);
  assert.deepEqual(plans.plans.map((p) => p.features.qrThemes.length), [3, 6, 10]);
  assert.deepEqual(plans.plans.map((p) => p.features.photosPerDish), [1, 3, 3]);
  assert.ok(plans.plans.find((p) => p.id === 'ultra').popular);
  assert.ok(!JSON.stringify(plans).includes('customSlug') && !JSON.stringify(plans).includes('aiScansPerMonth'));
  assert.equal((await call('POST', '/owner/signup', { name: 'No Owner', phone: '9000000001', password: 'secret1', plan: 'growth' })).status, 400); // owner name required
  const r = await call('POST', '/owner/signup', { name: 'Test Cafe', ownerName: 'Tester', phone: '9111111111', password: 'secret1', plan: 'growth' });
  assert.equal(r.status, 201);
  assert.equal(r.restaurant.subscription.status, 'trial');
  assert.match(r.restaurant.links.qrUrl, /\/m\/[A-Z2-9]{7}$/);
  assert.equal(r.restaurant.links.qrUrl, r.restaurant.links.menuUrl);
  growth = { token: r.token, rest: r.restaurant };
  const s = await call('POST', '/owner/signup', { name: 'Tiny Tea', ownerName: 'Tia', phone: '9222222222', password: 'secret1', plan: 'starter' });
  starter = { token: s.token, rest: s.restaurant };
  const dup = await call('POST', '/owner/signup', { name: 'Dup', ownerName: 'Dev', phone: '9111111111', password: 'secret1', plan: 'growth' });
  assert.equal(dup.status, 409);
  assert.equal((await call('POST', '/owner/login', { phone: '9111111111', password: 'bad' })).status, 401);
});

test('website checkout: bill, coupon, UTR, admin verifies, trial coupons extend instantly', async () => {
  const { token: at } = await call('POST', '/admin/login', { email: 'a@t.io', password: 'pw-test-1' });
  assert.equal((await call('PUT', '/admin/settings', { adminUpiId: 'not a upi' }, at)).status, 400);
  await call('PUT', '/admin/settings', { adminUpiId: 'pay@bank' }, at);
  const r = await call('POST', '/owner/signup', { name: 'Pay Cafe', ownerName: 'Pia', phone: '9444444444', password: 'secret1', plan: 'growth' });
  assert.equal(r.restaurant.subscription.status, 'trial'); // signup never takes money
  const link = await call('POST', '/owner/subscription/checkout-link', { plan: 'ultra' }, r.token);
  assert.match(link.url, /\/pay\/[a-f0-9]{24}$/);
  const id = link.url.split('/').pop();
  const view = await call('GET', `/pay/${id}`);
  assert.equal(view.plan, 'ultra');
  assert.equal(view.payee.upiId, 'pay@bank');
  assert.ok(!view.restaurant.phone.startsWith('94')); // masked
  assert.equal((await call('GET', '/pay/deadbeefdeadbeefdeadbeef')).status, 404);
  await call('POST', '/admin/coupons', { code: 'OFF20', type: 'percent', value: 20 }, at);
  await call('POST', '/admin/coupons', { code: 'BONUS5', type: 'trial_days', value: 5 }, at);
  const q = await call('POST', `/pay/${id}/quote`, { plan: 'ultra', coupon: 'off20' });
  assert.deepEqual([q.original, q.discount, q.final], [699, 140, 559]);
  assert.equal((await call('POST', `/pay/${id}/submit`, { plan: 'ultra', coupon: 'OFF20', utr: '12' })).status, 400);
  const sub = await call('POST', `/pay/${id}/submit`, { plan: 'ultra', coupon: 'OFF20', utr: '412345678901' });
  assert.equal(sub.payment.status, 'pending');
  assert.equal(sub.payment.amount, 559);
  assert.equal((await call('POST', `/pay/${id}/submit`, { plan: 'ultra', utr: '412345678901' })).status, 409);
  const pays = await call('GET', '/admin/payments', null, at);
  const p = pays.payments.find((x) => x.utrRef === '412345678901');
  assert.equal(p.source, 'website');
  await call('POST', `/admin/payments/${p.id}/verify`, null, at);
  const after = await call('GET', `/pay/${id}`);
  assert.equal(after.payment.status, 'verified');
  assert.ok(after.payment.paidUntil);
  const me = await call('GET', '/owner/me', null, r.token);
  assert.equal(me.restaurant.subscription.status, 'active');
  assert.equal(me.restaurant.subscription.plan, 'ultra');
  // signup: percent coupon refused, trial coupon adds days
  assert.equal((await call('POST', '/owner/signup', { name: 'T1', ownerName: 'Asha', phone: '9666666666', password: 'secret1', plan: 'starter', couponCode: 'OFF20' })).status, 400);
  const t = await call('POST', '/owner/signup', { name: 'T2', ownerName: 'Bala', phone: '9777777777', password: 'secret1', plan: 'starter', couponCode: 'BONUS5' });
  assert.equal(t.restaurant.subscription.daysLeft, 12);
  // trial coupon on the website checkout
  const l2 = (await call('POST', '/owner/subscription/checkout-link', {}, t.token)).url.split('/').pop();
  assert.equal((await call('POST', `/pay/${l2}/trial-coupon`, { coupon: 'OFF20' })).status, 400);
  const ext = await call('POST', `/pay/${l2}/trial-coupon`, { coupon: 'BONUS5' });
  assert.equal(ext.subscription.daysLeft, 17);
});

test('menu import + server-priced ordering for Growth; Starter cannot take orders', async () => {
  for (const t of [growth, starter]) assert.ok((await call('POST', '/owner/menu/import', menu, t.token)).success);
  const slug = growth.rest.slug;
  const pub = await call('GET', `/menu/${slug}`);
  assert.equal(pub.features.ordering, true);
  const dish = pub.items.find((i) => i.name === 'Chicken 65');
  // client tries to cheat: price is ignored, variant price is used
  const o = await call('POST', '/orders', { slug, table: 'Table 1', items: [{ dishId: dish.id, variantId: dish.variants[0].id, qty: 2, price: 1 }], name: 'Asha' }, null, { 'Idempotency-Key': 'k1' });
  assert.equal(o.status, 201);
  assert.equal(o.order.totalAmount, 320);
  assert.equal(o.order.token, 1);
  const tr = await call('GET', `/orders/${o.order.id}/track?key=${o.order.trackKey}`);
  assert.equal(tr.order.status, 'pending');
  assert.equal((await call('GET', `/orders/${o.order.id}/track?key=wrong`)).status, 404);

  const pubStarter = await call('GET', `/menu/${starter.rest.slug}`);
  assert.equal(pubStarter.features.ordering, false);
  const d2 = pubStarter.items[0];
  assert.equal((await call('POST', '/orders', { slug: starter.rest.slug, table: 'Table 1', items: [{ dishId: d2.id, qty: 1 }] })).status, 403);
  assert.equal((await call('GET', '/owner/orders', null, starter.token)).status, 403);
});

test('owner sees the order, notification fires, kitchen flow is enforced', async () => {
  const list = await call('GET', '/owner/orders', null, growth.token);
  assert.equal(list.orders.length, 1);
  const id = list.orders[0].id;
  const n = await call('GET', '/owner/notifications', null, growth.token);
  assert.equal(n.unread, 1);
  assert.match(n.notifications[0].title, /New order #1/);
  assert.equal((await call('PATCH', `/owner/orders/${id}/status`, { status: 'served' }, growth.token)).status, 409); // cannot skip steps
  for (const st of ['cooking', 'ready', 'served']) assert.ok((await call('PATCH', `/owner/orders/${id}/status`, { status: st }, growth.token)).success);
  const tr = await call('GET', `/orders/${id}/track?key=${list.orders[0].trackKey}`);
  assert.equal(tr.order.status, 'served');
  await call('POST', '/owner/notifications/read', {}, growth.token);
  assert.equal((await call('GET', '/owner/notifications', null, growth.token)).unread, 0);
});

test('plans: unlimited dishes everywhere, locked features return an upgrade hint', async () => {
  const p = await call('GET', '/owner/plans');
  assert.ok(p.featureCatalog.length > 10);
  assert.ok(p.plans.every((x) => x.features.maxItems === undefined));
  // Starter can add any number of dishes
  const many = { categories: [{ name: 'Big', items: Array.from({ length: 80 }, (_, i) => ({ name: `Dish ${i}`, price: 10 + i })) }] };
  assert.ok((await call('POST', '/owner/menu/import', many, starter.token)).success);
  // starter gets the offers banner, but not Growth designs
  assert.ok((await call('PATCH', '/owner/theme', { announcement: 'Happy hour 5-7', template: 'cafe' }, starter.token)).success);
  const locked = await call('PATCH', '/owner/theme', { template: 'chaat' }, starter.token);
  assert.equal(locked.status, 403);
  assert.equal(locked.upgrade, true);
  assert.equal(locked.requiredPlan, 'growth');
  const qr = await call('PATCH', '/owner/theme', { qrTheme: 'gold' }, growth.token);
  assert.equal(qr.requiredPlan, 'ultra');
  assert.equal((await call('PATCH', '/owner/theme', { template: 'nope' }, growth.token)).status, 400);
  assert.ok((await call('PATCH', '/owner/theme', { qrTheme: 'sunset', template: 'garden', announcement: 'Happy hour 5-7' }, growth.token)).success);
  const pub = await call('GET', `/menu/${growth.rest.shortId}`);
  assert.equal(pub.restaurant.theme.announcement, 'Happy hour 5-7');
  assert.equal(pub.restaurant.template.id, 'garden');
  assert.equal(pub.restaurant.template.primary, '#15803D');
  // photos per dish: 1 on Starter, 3 on Growth
  const img = (n) => Array.from({ length: n }, (_, i) => `https://img.example/${i}.webp`);
  assert.equal((await call('POST', '/owner/menu/items', { name: 'Two pics', price: 10, images: img(2) }, starter.token)).requiredPlan, 'growth');
  const one = await call('POST', '/owner/menu/items', { name: 'One pic', price: 10, images: img(1) }, starter.token);
  assert.equal(one.item.imageUrl, 'https://img.example/0.webp');
  const three = await call('POST', '/owner/menu/items', { name: 'Three pics', price: 10, images: img(3) }, growth.token);
  assert.equal(three.item.images.length, 3);
  assert.equal((await call('PATCH', `/owner/menu/items/${three.item.id}`, { images: img(4) }, growth.token)).status, 403);
});

test('realtime: owner socket receives new orders and status updates; tenants isolated', async () => {
  const { io } = require('socket.io-client');
  const url = `http://localhost:${PORT}`;
  const owner = io(url, { auth: { token: growth.token }, transports: ['websocket'] });
  const other = io(url, { auth: { token: starter.token }, transports: ['websocket'] });
  await Promise.all([owner, other].map((s) => new Promise((r) => s.on('connect', r))));
  let leaked = false;
  other.on('order:new', () => { leaked = true; });
  const got = new Promise((r) => owner.once('order:new', r));
  const pub = await call('GET', `/menu/${growth.rest.slug}`);
  const o = await call('POST', '/orders', { slug: growth.rest.slug, table: 'Table 2', items: [{ dishId: pub.items[0].id, qty: 1 }] });
  const ev = await got;
  assert.equal(ev.order.id, o.order.id);
  // customer tracker gets status changes live
  const guest = io(url, { transports: ['websocket'] });
  await new Promise((r) => guest.on('connect', r));
  guest.emit('order:watch', { id: o.order.id, key: o.order.trackKey });
  await new Promise((r) => setTimeout(r, 150));
  const upd = new Promise((r) => guest.once('order:update', r));
  await call('PATCH', `/owner/orders/${o.order.id}/status`, { status: 'cooking' }, growth.token);
  assert.equal((await upd).order.status, 'cooking');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(leaked, false);
  // a bad token is refused
  const badSock = io(url, { auth: { token: 'nope' }, transports: ['websocket'] });
  const err = await new Promise((r) => badSock.on('connect_error', r));
  assert.match(err.message, /sign in/);
  [owner, other, guest, badSock].forEach((s) => s.close());
});

test('operations: add-ons, offer price, dine-in table orders, store closed, service calls, bookings, schedule, guest list, reports', async () => {
  const g = growth.token;
  const d = await call('POST', '/owner/menu/items', { name: 'Margherita', category: 'Pizza', price: 300, offerPrice: 250, addons: [{ name: 'Extra cheese', price: 40 }], diet: ['jain', 'bogus'], spiceLevel: 'mild', prepTime: 15 }, g);
  assert.equal(d.status, 201);
  assert.deepEqual(d.item.diet, ['jain']);
  assert.equal((await call('POST', '/owner/menu/items', { name: 'X', price: 100, offerPrice: 150 }, g)).status, 400); // offer must be lower
  const st = await call('POST', '/owner/menu/items', { name: 'Y', price: 100, addons: [{ name: 'Dip', price: 10 }] }, starter.token);
  assert.equal(st.upgrade, true);

  const slug = growth.rest.slug;
  const pub = await call('GET', `/menu/${slug}`);
  const pz = pub.items.find((i) => i.name === 'Margherita');
  assert.equal(pz.offerPrice, 250);
  // Customer ordering is dine-in only; payment is settled at the table.
  assert.equal((await call('POST', '/orders', { slug, orderType: 'takeaway', items: [{ dishId: pz.id, qty: 1 }] })).status, 403);
  const o = await call('POST', '/orders', { slug, table: 'Table 1', phone: '9876500000', name: 'Neha', items: [{ dishId: pz.id, qty: 2, addonIds: [pz.addons[0].id] }] });
  assert.equal(o.status, 201);
  assert.equal(o.order.totalAmount, 580); // (250 + 40) x 2
  // pay it, then close the store
  assert.equal((await call('PATCH', `/owner/orders/${o.order.id}/payment`, { status: 'paid', method: 'upi' }, g)).order.payment.method, 'upi');
  await call('PATCH', '/owner/store', { open: false, prepMinutes: 25, wifiName: 'Cafe', wifiPassword: 'tea123' }, g);
  assert.equal((await call('POST', '/orders', { slug, table: 'Table 1', items: [{ dishId: pz.id, qty: 1 }] })).status, 409);
  const pub2 = await call('GET', `/menu/${slug}`);
  assert.equal(pub2.restaurant.store.open, false);
  assert.equal(pub2.restaurant.store.wifiName, 'Cafe');
  await call('PATCH', '/owner/store', { open: true }, g);

  // service call: table only, dedupe, resolve
  assert.equal((await call('POST', '/service-calls', { slug, table: 'Nope', type: 'bill' })).status, 400);
  const c1 = await call('POST', '/service-calls', { slug, table: 'Table 3', type: 'bill' });
  const c2 = await call('POST', '/service-calls', { slug, table: 'Table 3', type: 'bill' });
  assert.equal(c1.call.id, c2.call.id);
  assert.equal((await call('GET', '/owner/service-calls', null, g)).open, 1);
  await call('PATCH', `/owner/service-calls/${c1.call.id}`, {}, g);
  assert.equal((await call('GET', '/owner/service-calls', null, g)).open, 0);
  assert.equal((await call('POST', '/service-calls', { slug: starter.rest.slug, table: 'Table 1', type: 'waiter' })).status, 403);

  // bookings & timed sections are Ultra
  assert.equal((await call('POST', '/reservations', { slug, name: 'A', phone: '9876543210', date: '2099-01-01', time: '20:00', guests: 2 })).status, 403);
  assert.equal((await call('PUT', '/owner/menu/schedule', { schedule: { Pizza: { from: '07:00', to: '11:00' } } }, g)).upgrade, true);
  const e = await call('POST', '/owner/signup', { name: 'Ultra House', ownerName: 'Uma', phone: '9555555555', password: 'secret1', plan: 'ultra' });
  const bk = await call('POST', '/reservations', { slug: e.restaurant.slug, name: 'Ravi', phone: '9876543210', date: '2099-01-01', time: '20:00', guests: 4 });
  assert.equal(bk.status, 201);
  assert.equal((await call('PATCH', `/owner/reservations/${bk.reservation.id}`, { status: 'confirmed' }, e.token)).reservation.status, 'confirmed');
  await call('POST', '/owner/menu/items', { name: 'Poha', category: 'Breakfast', price: 60 }, e.token);
  // a window that is never "now": 1 minute long, 12 hours away
  const now = new Date(Date.now() + 330 * 60000);
  const hh = String((now.getUTCHours() + 12) % 24).padStart(2, '0');
  assert.ok((await call('PUT', '/owner/menu/schedule', { schedule: { Breakfast: { from: `${hh}:00`, to: `${hh}:01` } } }, e.token)).success);
  const ep = await call('GET', `/menu/${e.restaurant.slug}`);
  assert.equal(ep.sections.find((x) => x.name === 'Breakfast').open, false);
  await call('PATCH', '/owner/profile', { tables: ['T1'] }, e.token);
  assert.equal((await call('POST', '/orders', { slug: e.restaurant.slug, table: 'T1', items: [{ dishId: ep.items[0].id, qty: 1 }] })).status, 409);

  // CRM + reports
  const locked = await call('GET', '/owner/customers', null, g); // guest list is Ultra
  assert.equal(locked.upgrade, true);
  assert.equal(locked.requiredPlan, 'ultra');
  assert.ok((await call('GET', '/owner/customers', null, e.token)).success);
  const rep = await call('GET', '/owner/reports?days=7', null, g);
  assert.ok(rep.revenue >= 580);
  assert.equal(rep.daily.length, 7);
  assert.ok(rep.payments.upi >= 580);
  assert.ok(rep.orderTypes.dine_in >= 1);
});


test('profile: name, owner and phone are fixed; email + password change; tenants are isolated', async () => {
  assert.equal((await call('PATCH', '/owner/account', { ownerName: 'New Name' }, growth.token)).status, 403);
  assert.equal((await call('PATCH', '/owner/account', { phone: '9000000099' }, growth.token)).status, 403);
  assert.equal((await call('PATCH', '/owner/profile', { name: 'Renamed' }, growth.token)).status, 403);
  assert.ok((await call('PATCH', '/owner/profile', { name: 'Test Cafe', tagline: 'Fresh daily' }, growth.token)).success); // unchanged name is fine
  assert.ok((await call('PATCH', '/owner/account', { ownerName: 'Tester', email: 'x@y.com' }, growth.token)).success);
  assert.equal((await call('POST', '/owner/account/password', { current: 'nope', next: 'abcdef' }, growth.token)).status, 403);
  assert.ok((await call('POST', '/owner/account/password', { current: 'secret1', next: 'abcdef' }, growth.token)).success);
  assert.ok((await call('POST', '/owner/login', { phone: '9111111111', password: 'abcdef' })).success);
  assert.equal((await call('GET', '/owner/orders', null, starter.token)).status, 403);
});

test('admin: auth required, coupons & plans live', async () => {
  assert.equal((await call('GET', '/admin/overview')).status, 401);
  const { token } = await call('POST', '/admin/login', { email: 'a@t.io', password: 'pw-test-1' });
  const ov = await call('GET', '/admin/overview', null, token);
  assert.ok(ov.kpis.restaurants >= 2);
  assert.ok((await call('POST', '/admin/coupons', { code: 'TEST10', type: 'percent', value: 10 }, token)).success);
  const q = await call('POST', '/owner/coupons/validate', { code: 'test10', plan: 'growth' });
  assert.equal(q.final, 359);
  const lead = await call('POST', '/leads', { restaurantName: 'Lead Co', phone: '9333333333' });
  assert.equal(lead.status, 201);
  assert.equal((await call('GET', '/admin/leads', null, token)).leads.length, 1);
});

test('admin has full control: menu, orders, feedback, manual payment, account, export', async () => {
  const { token } = await call('POST', '/admin/login', { email: 'a@t.io', password: 'pw-test-1' });
  const rid = growth.rest.id;
  const it = await call('POST', `/admin/restaurants/${rid}/items`, { name: 'Admin Dish', price: 99, category: 'Specials' }, token);
  assert.equal(it.status, 201);
  assert.ok((await call('PATCH', `/admin/restaurants/${rid}/items/${it.item.id}`, { price: 120, isAvailable: false }, token)).success);
  const det = await call('GET', `/admin/restaurants/${rid}`, null, token);
  assert.ok(det.restaurant.categories.includes('Specials'));
  assert.ok((await call('DELETE', `/admin/restaurants/${rid}/items/${it.item.id}`, null, token)).success);
  const orders = await call('GET', `/admin/orders?restaurantId=${rid}`, null, token);
  assert.ok(orders.orders.length >= 1);
  assert.ok((await call('PATCH', `/admin/orders/${orders.orders[0].id}/status`, { status: 'cancelled' }, token)).success);
  assert.ok((await call('DELETE', `/admin/orders/${orders.orders[0].id}`, null, token)).success);
  const pay = await call('POST', '/admin/payments', { restaurantId: starter.rest.id, planId: 'growth', amount: 399, note: 'cash' }, token);
  assert.equal(pay.status, 201);
  assert.equal((await call('GET', '/owner/me', null, starter.token)).restaurant.subscription.status, 'active');
  assert.ok((await call('DELETE', `/admin/payments/${pay.payment.id}`, null, token)).success);
  assert.equal((await call('POST', '/admin/account', { currentPassword: 'wrong', newPassword: 'newpass-123' }, token)).status, 403);
  const acc = await call('POST', '/admin/account', { currentPassword: 'pw-test-1', newPassword: 'newpass-123' }, token);
  assert.ok(acc.success, JSON.stringify(acc));
  assert.ok((await call('POST', '/admin/login', { email: 'a@t.io', password: 'newpass-123' })).success);
  assert.equal((await call('POST', '/admin/login', { email: 'a@t.io', password: 'pw-test-1' })).status, 401);
  assert.ok((await call('POST', '/admin/backup', {}, token)).success);
  const ex = await call('GET', '/admin/export', null, token);
  assert.ok(ex.restaurants.length >= 2 && !JSON.stringify(ex).includes('"hash"'));
});

test('offline OCR reads a menu photo (python worker, no cloud API)', { timeout: 240000 }, async (t) => {
  const img = path.join(__dirname, '../test_data/synthetic/a_single_dots.png');
  if (!fs.existsSync(img)) return t.skip('synthetic menu missing (run test_data/gen_menus.py)');
  server.kill();
  server = spawn('node', [path.join(__dirname, '../src/server.js')], { env: { ...process.env, PORT, DB_FILE: path.join(dir, 'db.json'), RATE_LIMIT_MAX: '5000', ADMIN_EMAIL: 'a@t.io', ADMIN_PASSWORD: 'pw-test-1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 250)); }
  const login = await call('POST', '/owner/login', { phone: '9111111111', password: 'abcdef' });
  const data = 'data:image/png;base64,' + fs.readFileSync(img).toString('base64');
  // instant clarity check: the clear page passes, a blurred copy is refused before OCR runs
  const sharp = require('sharp');
  const clear = await call('POST', '/owner/menu/check-photo', { image: data }, login.token);
  assert.equal(clear.quality.ok, true);
  const blurred = 'data:image/png;base64,' + (await sharp(fs.readFileSync(img)).blur(5).toBuffer()).toString('base64');
  const bq = await call('POST', '/owner/menu/check-photo', { image: blurred }, login.token);
  assert.equal(bq.quality.issue, 'blur');
  assert.equal((await call('POST', '/owner/menu/scan', { images: [{ data: blurred }] }, login.token)).status, 422);
  const r = await call('POST', '/owner/menu/scan', { images: [{ data }] }, login.token);
  assert.ok(r.success, r.message);
  assert.equal(r.menu.engine, 'local-ocr');
  assert.ok(r.menu.totalItems >= 12, `expected >=12 dishes, got ${r.menu.totalItems}`);
  assert.ok(r.menu.categories.some((c) => /starters/i.test(c.name)));
});
