/**
 * Advanced Restaurant Suite:
 * 1. Live Inventory & Stock Management (Ultra & Master)
 * 2. Voice Announcements & Kitchen Speaker "Bolna" (Master)
 * 3. Advanced CRM, Loyalty Points & WhatsApp Marketing (Master)
 * 4. Staff PINs & Multi-Role Access (Master)
 * 5. Multi-Branch Outlet Management (Master)
 */
const express = require('express');
const { inMemoryData, persistDb } = require('../db');
const S = require('../services/saas');
const RT = require('../services/realtime');

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const feat = (req) => S.subscriptionState(req.rest).features;
const mineOrders = (req) => inMemoryData.orders.filter((o) => o.restaurantId === req.rest.id);

/* ==========================================================================
   1. INVENTORY & STOCK MANAGEMENT (Ultra & Master)
   ========================================================================== */

router.get('/inventory', (req, res) => {
  if (!feat(req).inventory) {
    return S.planBlocked(res, 'inventory', 'Live Inventory & Stock Management is available on Ultra and Master plans');
  }
  const r = req.rest;
  r.inventory = r.inventory || [];
  r.suppliers = r.suppliers || [];
  r.inventoryLogs = r.inventoryLogs || [];

  const totalItems = r.inventory.length;
  const lowStockItems = r.inventory.filter((i) => Number(i.stock || 0) <= Number(i.minStock || 0));
  const totalValue = r.inventory.reduce((sum, i) => sum + (Number(i.stock || 0) * Number(i.costPerUnit || 0)), 0);

  res.json({
    success: true,
    items: r.inventory,
    totalItems,
    lowStockCount: lowStockItems.length,
    lowStockItems,
    totalValue: Math.round(totalValue),
    suppliers: r.suppliers,
    logs: r.inventoryLogs.slice(0, 50),
  });
});

router.post('/inventory', (req, res) => {
  if (!feat(req).inventory) return S.planBlocked(res, 'inventory');
  const r = req.rest;
  const b = req.body || {};
  if (!b.name || String(b.name).trim().length < 2) return bad(res, 'Item name must be at least 2 characters');
  
  const newItem = {
    id: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(b.name).trim(),
    unit: b.unit || 'kg', // kg, gm, litres, ml, pcs, packets
    stock: Math.max(0, Number(b.stock) || 0),
    minStock: Math.max(0, Number(b.minStock) || 5),
    costPerUnit: Math.max(0, Number(b.costPerUnit) || 0),
    supplier: b.supplier || '',
    category: b.category || 'General',
    updatedAt: new Date().toISOString(),
  };

  r.inventory = r.inventory || [];
  r.inventory.unshift(newItem);

  r.inventoryLogs = r.inventoryLogs || [];
  r.inventoryLogs.unshift({
    id: `log_${Date.now()}`,
    itemId: newItem.id,
    itemName: newItem.name,
    change: newItem.stock,
    oldStock: 0,
    newStock: newItem.stock,
    reason: 'Initial stock intake',
    at: new Date().toISOString(),
  });

  persistDb();
  RT.toRestaurant(r.id, 'inventory:update', { item: newItem });
  res.status(201).json({ success: true, item: newItem });
});

router.patch('/inventory/:id', (req, res) => {
  if (!feat(req).inventory) return S.planBlocked(res, 'inventory');
  const r = req.rest;
  r.inventory = r.inventory || [];
  const item = r.inventory.find((i) => i.id === req.params.id);
  if (!item) return bad(res, 'Inventory item not found', 404);

  const b = req.body || {};
  const oldStock = Number(item.stock || 0);

  if (typeof b.name === 'string') item.name = b.name.trim();
  if (typeof b.unit === 'string') item.unit = b.unit.trim();
  if (b.minStock !== undefined) item.minStock = Math.max(0, Number(b.minStock) || 0);
  if (b.costPerUnit !== undefined) item.costPerUnit = Math.max(0, Number(b.costPerUnit) || 0);
  if (typeof b.supplier === 'string') item.supplier = b.supplier.trim();
  if (typeof b.category === 'string') item.category = b.category.trim();

  // Stock adjustment (+ or -)
  if (b.adjustment !== undefined) {
    const adj = Number(b.adjustment) || 0;
    item.stock = Math.max(0, oldStock + adj);
    r.inventoryLogs = r.inventoryLogs || [];
    r.inventoryLogs.unshift({
      id: `log_${Date.now()}`,
      itemId: item.id,
      itemName: item.name,
      change: adj,
      oldStock,
      newStock: item.stock,
      reason: b.reason || (adj >= 0 ? 'Restock / Purchase' : 'Consumption / Spoilage'),
      at: new Date().toISOString(),
    });
  } else if (b.stock !== undefined) {
    const nextStock = Math.max(0, Number(b.stock) || 0);
    const diff = nextStock - oldStock;
    item.stock = nextStock;
    r.inventoryLogs = r.inventoryLogs || [];
    r.inventoryLogs.unshift({
      id: `log_${Date.now()}`,
      itemId: item.id,
      itemName: item.name,
      change: diff,
      oldStock,
      newStock: nextStock,
      reason: b.reason || 'Manual audit correction',
      at: new Date().toISOString(),
    });
  }

  item.updatedAt = new Date().toISOString();
  persistDb();
  RT.toRestaurant(r.id, 'inventory:update', { item });
  res.json({ success: true, item });
});

router.delete('/inventory/:id', (req, res) => {
  if (!feat(req).inventory) return S.planBlocked(res, 'inventory');
  const r = req.rest;
  r.inventory = r.inventory || [];
  const idx = r.inventory.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return bad(res, 'Item not found', 404);

  const deleted = r.inventory.splice(idx, 1)[0];
  persistDb();
  res.json({ success: true, deletedId: req.params.id });
});

// Auto-generate Purchase Order for low stock items
router.post('/inventory/auto-po', (req, res) => {
  if (!feat(req).inventory) return S.planBlocked(res, 'inventory');
  const r = req.rest;
  r.inventory = r.inventory || [];

  const lowStock = r.inventory.filter((i) => Number(i.stock || 0) <= Number(i.minStock || 0));
  if (lowStock.length === 0) {
    return res.json({ success: true, po: null, message: 'All items are currently well stocked! Zero purchase order needed.' });
  }

  const poItems = lowStock.map((i) => {
    const reorderQty = Math.max(10, (Number(i.minStock || 0) * 2) - Number(i.stock || 0));
    const estimatedCost = reorderQty * Number(i.costPerUnit || 0);
    return {
      itemId: i.id,
      name: i.name,
      currentStock: i.stock,
      minStock: i.minStock,
      suggestedQty: reorderQty,
      unit: i.unit,
      costPerUnit: i.costPerUnit,
      estimatedCost: Math.round(estimatedCost),
      supplier: i.supplier || 'Primary Vendor',
    };
  });

  const totalPoCost = poItems.reduce((acc, p) => acc + p.estimatedCost, 0);
  const po = {
    id: `PO-${Date.now().toString().slice(-6)}`,
    generatedAt: new Date().toISOString(),
    items: poItems,
    totalEstimatedCost: Math.round(totalPoCost),
    itemCount: poItems.length,
  };

  res.json({ success: true, po });
});

// Supplier directory
router.post('/inventory/suppliers', (req, res) => {
  if (!feat(req).inventory) return S.planBlocked(res, 'inventory');
  const r = req.rest;
  const b = req.body || {};
  if (!b.name) return bad(res, 'Supplier name required');

  const s = {
    id: `sup_${Date.now()}`,
    name: String(b.name).trim(),
    phone: String(b.phone || '').trim(),
    email: String(b.email || '').trim(),
    category: b.category || 'Raw Materials',
    createdAt: new Date().toISOString(),
  };

  r.suppliers = r.suppliers || [];
  r.suppliers.unshift(s);
  persistDb();
  res.status(201).json({ success: true, supplier: s });
});

router.delete('/inventory/suppliers/:id', (req, res) => {
  if (!feat(req).inventory) return S.planBlocked(res, 'inventory');
  const r = req.rest;
  r.suppliers = r.suppliers || [];
  r.suppliers = r.suppliers.filter((s) => s.id !== req.params.id);
  persistDb();
  res.json({ success: true, deleted: req.params.id });
});

/* ==========================================================================
   2. VOICE ANNOUNCEMENTS & KITCHEN SPEAKER ("BOLNA") (Master)
   ========================================================================== */

router.get('/voice/settings', (req, res) => {
  if (!feat(req).voiceAssistant) {
    return S.planBlocked(res, 'voiceAssistant', 'Live Voice Announcements & Assistant (“Bolna”) is exclusive to the Master Plan 👑');
  }
  const r = req.rest;
  r.voice = {
    enabled: true,
    language: 'hi', // 'hi' = Hindi, 'en' = English
    speed: 1.0,
    speakDishNames: true,
    volume: 1.0,
    kitchenSpeaker: true,
    ...(r.voice || {}),
  };
  res.json({ success: true, settings: r.voice });
});

router.patch('/voice/settings', (req, res) => {
  if (!feat(req).voiceAssistant) return S.planBlocked(res, 'voiceAssistant');
  const r = req.rest;
  const b = req.body || {};
  r.voice = r.voice || {};

  if (typeof b.enabled === 'boolean') r.voice.enabled = b.enabled;
  if (['hi', 'en'].includes(b.language)) r.voice.language = b.language;
  if (typeof b.speakDishNames === 'boolean') r.voice.speakDishNames = b.speakDishNames;
  if (typeof b.kitchenSpeaker === 'boolean') r.voice.kitchenSpeaker = b.kitchenSpeaker;
  if (typeof b.speed === 'number') r.voice.speed = Math.max(0.5, Math.min(2.0, b.speed));
  if (typeof b.volume === 'number') r.voice.volume = Math.max(0.1, Math.min(1.0, b.volume));

  persistDb();
  RT.toRestaurant(r.id, 'voice:settings', { settings: r.voice });
  res.json({ success: true, settings: r.voice });
});

router.post('/voice/speak-order/:oid', (req, res) => {
  if (!feat(req).voiceAssistant) return S.planBlocked(res, 'voiceAssistant');
  const r = req.rest;
  const o = inMemoryData.orders.find((x) => x.id === req.params.oid && x.restaurantId === r.id);
  if (!o) return bad(res, 'Order not found', 404);

  const itemCount = o.items.reduce((sum, item) => sum + (item.qty || 1), 0);
  const dishNames = o.items.map((i) => `${i.qty} ${i.name}`).join(', ');

  const textHi = o.tableNumber
    ? `टेबल ${o.tableNumber} से नया ऑर्डर आया है! टोकन नंबर ${o.token}. ${dishNames}.`
    : `नया टेकअवे ऑर्डर आया है! टोकन नंबर ${o.token}. कुल ${itemCount} आइटम.`;

  const textEn = o.tableNumber
    ? `New order received from Table ${o.tableNumber}! Token number ${o.token}. ${dishNames}.`
    : `New takeaway order received! Token number ${o.token}. Total ${itemCount} items.`;

  res.json({
    success: true,
    orderId: o.id,
    token: o.token,
    table: o.tableNumber,
    textHi,
    textEn,
    language: r.voice?.language || 'hi',
    enabled: r.voice?.enabled !== false,
  });
});

/* ==========================================================================
   3. ADVANCED CRM, LOYALTY CLUB & WHATSAPP MARKETING (Master)
   ========================================================================== */

router.get('/crm/dashboard', (req, res) => {
  if (!feat(req).crmSuite) {
    return S.planBlocked(res, 'crmSuite', 'Advanced CRM, Loyalty Club & WhatsApp Marketing is exclusive to Master Plan 👑');
  }

  const r = req.rest;
  r.crm = r.crm || { loyaltyRate: 10, minRedeemPoints: 50 };
  const orders = mineOrders(req);
  const customerMap = new Map();

  for (const o of orders) {
    const rawPhone = String(o.customer?.phone || '').replace(/\D/g, '').slice(-10);
    if (rawPhone.length < 10 || o.status === 'cancelled') continue;

    const entry = customerMap.get(rawPhone) || {
      phone: rawPhone,
      name: o.customer.name || 'Guest',
      visits: 0,
      totalSpend: 0,
      firstVisit: o.createdAt,
      lastVisit: o.createdAt,
      favouriteDishes: {},
      loyaltyPoints: 0,
      notes: '',
    };

    entry.visits += 1;
    entry.totalSpend += (o.totalAmount || 0);
    if (o.customer.name && o.customer.name !== 'Guest') entry.name = o.customer.name;
    if (o.createdAt < entry.firstVisit) entry.firstVisit = o.createdAt;
    if (o.createdAt > entry.lastVisit) entry.lastVisit = o.createdAt;

    for (const item of (o.items || [])) {
      entry.favouriteDishes[item.name] = (entry.favouriteDishes[item.name] || 0) + (item.qty || 1);
    }

    customerMap.set(rawPhone, entry);
  }

  // Calculate VIP Tier & Loyalty Points
  const list = [...customerMap.values()].map((c) => {
    // 1 point per Rs.10 spent
    c.loyaltyPoints = Math.floor(c.totalSpend / (r.crm.loyaltyRate || 10));
    
    let vipTier = 'Bronze';
    if (c.totalSpend >= 10000 || c.visits >= 10) vipTier = 'Platinum 👑';
    else if (c.totalSpend >= 5000 || c.visits >= 5) vipTier = 'Gold 🌟';
    else if (c.totalSpend >= 2000 || c.visits >= 3) vipTier = 'Silver ⚡';

    const favDish = Object.entries(c.favouriteDishes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Chef Special';

    const daysSinceLastVisit = Math.floor((Date.now() - new Date(c.lastVisit).getTime()) / (1000 * 3600 * 24));
    let segment = 'Regular';
    if (c.visits === 1) segment = 'New';
    else if (vipTier.includes('Gold') || vipTier.includes('Platinum')) segment = 'VIP';
    else if (daysSinceLastVisit > 30) segment = 'At Risk';

    return {
      phone: c.phone,
      name: c.name,
      visits: c.visits,
      totalSpend: Math.round(c.totalSpend),
      avgOrderValue: Math.round(c.totalSpend / c.visits),
      firstVisit: c.firstVisit,
      lastVisit: c.lastVisit,
      daysSinceLastVisit,
      favDish,
      loyaltyPoints: c.loyaltyPoints,
      vipTier,
      segment,
    };
  }).sort((a, b) => b.totalSpend - a.totalSpend);

  const totalCustomers = list.length;
  const vipCount = list.filter((c) => c.segment === 'VIP').length;
  const repeatCount = list.filter((c) => c.visits > 1).length;
  const atRiskCount = list.filter((c) => c.segment === 'At Risk').length;
  const totalLoyaltyDistributed = list.reduce((sum, c) => sum + c.loyaltyPoints, 0);

  // Ready WhatsApp Marketing Templates
  const campaignTemplates = [
    {
      id: 'win_back',
      title: 'Win-Back At-Risk Diners',
      description: 'Send 15% discount code to guests who haven’t visited in 30+ days.',
      discount: '15%',
      code: 'COMEBACK15',
    },
    {
      id: 'vip_appreciation',
      title: 'VIP Diners Free Dessert',
      description: 'Reward high-spending Gold & Platinum guests with a complimentary starter or dessert.',
      discount: 'Chef Gift',
      code: 'VIPGIFT',
    },
    {
      id: 'weekend_carnival',
      title: 'Weekend Dine-In Fest',
      description: 'Invite loyal diners to reserve table for the upcoming weekend live menu.',
      discount: 'Special Fest',
      code: 'WEEKEND10',
    },
    {
      id: 'loyalty_reminder',
      title: 'Loyalty Balance Reminder',
      description: 'Remind guests to redeem their accumulated reward points on their next order.',
      discount: 'Points Redeem',
      code: 'POINTSPAY',
    },
  ];

  res.json({
    success: true,
    totalCustomers,
    vipCount,
    repeatCount,
    atRiskCount,
    totalLoyaltyDistributed,
    customers: list,
    campaignTemplates,
  });
});

router.post('/crm/campaign/whatsapp', (req, res) => {
  if (!feat(req).crmSuite) return S.planBlocked(res, 'crmSuite');
  const r = req.rest;
  const { phone, name, templateId, customMsg } = req.body || {};
  if (!phone) return bad(res, 'Customer phone number required');

  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  const guestName = name || 'Diner';
  const restName = r.name || 'our restaurant';

  let message = '';
  switch (templateId) {
    case 'win_back':
      message = `Namaste ${guestName}! ✨ We miss having you at ${restName}. Enjoy a flat 15% discount on your next visit with coupon code COMEBACK15! View our latest live menu here: ${S.menuBaseUrl()}/menu/${r.slug}`;
      break;
    case 'vip_appreciation':
      message = `Dear ${guestName}, you are one of our most valued VIP diners at ${restName}! 👑 Show this message to our server on your next table visit to enjoy a complimentary chef special starter on us!`;
      break;
    case 'loyalty_reminder':
      message = `Hello ${guestName}! You have valuable reward points waiting at ${restName}. Redeem them for instant bill discounts on your next dine-in order!`;
      break;
    default:
      message = customMsg || `Namaste ${guestName}! Greetings from ${restName}. Check out our fresh seasonal dishes on our live QR menu: ${S.menuBaseUrl()}/menu/${r.slug}`;
  }

  const whatsappUrl = `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(message)}`;

  res.json({
    success: true,
    phone: cleanPhone,
    message,
    whatsappUrl,
  });
});

/* ==========================================================================
   4. STAFF PINs & ROLE-BASED ACCESS (Master)
   ========================================================================== */

router.get('/staff', (req, res) => {
  if (!feat(req).staffManagement) {
    return S.planBlocked(res, 'staffManagement', 'Staff PINs & Multi-Role Access is exclusive to the Master Plan 👑');
  }
  const r = req.rest;
  r.staff = r.staff || [];
  res.json({ success: true, staff: r.staff });
});

router.post('/staff', (req, res) => {
  if (!feat(req).staffManagement) return S.planBlocked(res, 'staffManagement');
  const r = req.rest;
  const { name, role, pin, phone } = req.body || {};
  if (!name || String(name).trim().length < 2) return bad(res, 'Staff name required');
  if (!pin || !/^\d{4}$/.test(String(pin).trim())) return bad(res, 'Staff PIN must be a 4-digit numeric code');

  const member = {
    id: `staff_${Date.now()}`,
    name: String(name).trim(),
    role: role || 'captain', // 'manager', 'captain', 'chef', 'cashier'
    pin: String(pin).trim(),
    phone: phone ? String(phone).trim() : '',
    active: true,
    createdAt: new Date().toISOString(),
  };

  r.staff = r.staff || [];
  r.staff.unshift(member);
  persistDb();
  res.status(201).json({ success: true, member });
});

router.patch('/staff/:id', (req, res) => {
  if (!feat(req).staffManagement) return S.planBlocked(res, 'staffManagement');
  const r = req.rest;
  r.staff = r.staff || [];
  const s = r.staff.find((x) => x.id === req.params.id);
  if (!s) return bad(res, 'Staff member not found', 404);

  const b = req.body || {};
  if (typeof b.name === 'string') s.name = b.name.trim();
  if (typeof b.role === 'string') s.role = b.role.trim();
  if (b.pin && /^\d{4}$/.test(String(b.pin).trim())) s.pin = String(b.pin).trim();
  if (typeof b.phone === 'string') s.phone = b.phone.trim();
  if (typeof b.active === 'boolean') s.active = b.active;

  persistDb();
  res.json({ success: true, member: s });
});

router.delete('/staff/:id', (req, res) => {
  if (!feat(req).staffManagement) return S.planBlocked(res, 'staffManagement');
  const r = req.rest;
  r.staff = r.staff || [];
  r.staff = r.staff.filter((x) => x.id !== req.params.id);
  persistDb();
  res.json({ success: true, deleted: req.params.id });
});

/* ==========================================================================
   5. MULTI-BRANCH OUTLET MANAGEMENT (Master)
   ========================================================================== */

router.get('/branches', (req, res) => {
  if (!feat(req).multiOutlet) {
    return S.planBlocked(res, 'multiOutlet', 'Multi-Branch Outlet Switcher is exclusive to the Master Plan 👑');
  }
  const r = req.rest;
  r.branches = r.branches || [];
  res.json({ success: true, branches: r.branches, currentBranch: r.name });
});

router.post('/branches', (req, res) => {
  if (!feat(req).multiOutlet) return S.planBlocked(res, 'multiOutlet');
  const r = req.rest;
  const { name, city, address, phone } = req.body || {};
  if (!name || String(name).trim().length < 2) return bad(res, 'Branch name required');

  const b = {
    id: `br_${Date.now()}`,
    name: String(name).trim(),
    city: city ? String(city).trim() : r.city,
    address: address ? String(address).trim() : '',
    phone: phone ? String(phone).trim() : r.phone,
    createdAt: new Date().toISOString(),
  };

  r.branches = r.branches || [];
  r.branches.push(b);
  persistDb();
  res.status(201).json({ success: true, branch: b });
});

module.exports = router;
