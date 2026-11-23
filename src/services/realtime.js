/**
 * Real-time layer (socket.io). Every client authenticates on connect and is placed in rooms:
 *   rest:<restaurantId>  — the owner app (orders, notifications, subscription changes)
 *   admin                — the super-admin panel (everything)
 *   menu:<restaurantId>  — customers looking at a hosted menu (live sold-out / price changes)
 *   order:<orderId>      — a customer's order tracker
 * Events never leak across tenants: nothing is broadcast globally.
 */
const jwt = require('jsonwebtoken');

let io = null;

function init(server) {
  io = server;
  const { JWT_SECRET } = require('../middleware/auth');
  const { inMemoryData, findRestaurantBySlug, findRestaurantByShortId } = require('../db');

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    socket.data.role = 'guest';
    if (token) {
      try {
        const p = jwt.verify(token, JWT_SECRET);
        socket.data.role = p.role;
        socket.data.restaurantId = p.restaurantId;
      } catch (_) {
        return next(new Error('Session expired, please sign in again'));
      }
    }
    next();
  });

  io.on('connection', (socket) => {
    const { role, restaurantId } = socket.data;
    if (role === 'owner' && restaurantId) socket.join(`rest:${restaurantId}`);
    if (role === 'superadmin') socket.join('admin');

    socket.on('menu:watch', (slug) => {
      const r = findRestaurantBySlug(String(slug || '')) || findRestaurantByShortId(String(slug || '')) || findRestaurantByShortId(String(slug || '').toUpperCase());
      if (r) socket.join(`menu:${r.id}`);
    });
    socket.on('order:watch', ({ id, key } = {}) => {
      const o = inMemoryData.orders.find((x) => x.id === id && x.trackKey && x.trackKey === key);
      if (o) socket.join(`order:${o.id}`);
    });
  });
}

const push = require('./push');
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const emit = (room, ev, data) => { if (io) io.to(room).emit(ev, data); };

/** Public, customer-safe view of an order. */
const publicOrder = (o) => ({ id: o.id, token: o.token, status: o.status, tableNumber: o.tableNumber, totalAmount: o.totalAmount });

module.exports = {
  init,
  toRestaurant: (rid, ev, data) => {
    emit(`rest:${rid}`, ev, data);
    if (ev === 'service:new' && data && data.call) push.toRestaurant(rid, { title: `${data.call.table || 'A table'} · ${data.call.label || 'needs you'}`, body: 'Tap to open', url: './', tag: 'call' });
  },
  toAdmin: (ev, data) => emit('admin', ev, data),
  orderNew(r, o) {
    emit(`rest:${r.id}`, 'order:new', { order: o });
    emit('admin', 'order:new', { order: o, restaurantName: r.name });
    const qty = (o.items || []).reduce((n, i) => n + (Number(i.qty) || 0), 0);
    push.toRestaurant(r.id, { title: `New order #${o.token} · ${o.tableNumber || ''}`.trim(), body: `${qty} items · ${inr(o.totalAmount)}`, url: './', tag: `order-${o.id}` });
  },
  orderUpdate(o) {
    emit(`rest:${o.restaurantId}`, 'order:update', { order: o });
    emit('admin', 'order:update', { order: o });
    emit(`order:${o.id}`, 'order:update', { order: publicOrder(o) });
  },
  notification(r, n) {
    emit(`rest:${r.id}`, 'notification', { notification: n, unread: (r.notifications || []).filter((x) => !x.read).length });
    if (n && n.type !== 'order') push.toRestaurant(r.id, { title: n.title || 'Update', body: n.body || '', url: './', tag: n.id });
  },
  menuUpdated(r) {
    emit(`menu:${r.id}`, 'menu:updated', { slug: r.slug });
    emit(`rest:${r.id}`, 'menu:updated', {});
  },
  /** Plan / payment status changed (admin verified, rejected, extended…). The app refetches /me. */
  subscription(r, info = {}) {
    emit(`rest:${r.id}`, 'subscription', info);
    emit('admin', 'restaurant:update', { id: r.id });
  },
};
