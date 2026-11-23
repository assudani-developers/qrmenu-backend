/** Stock tracking & low-stock alerts (Ultra). */
const express = require('express');
const { inMemoryData, persistDb } = require('../db');
const S = require('../services/saas');
const RT = require('../services/realtime');

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const feat = (req) => S.subscriptionState(req.rest).features;

/* ==========================================================================
   1. INVENTORY & STOCK MANAGEMENT (Ultra)
   ========================================================================== */

router.get('/inventory', (req, res) => {
  if (!feat(req).inventory) {
    return S.planBlocked(res, 'inventory', 'Stock tracking is on the Ultra plan');
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

module.exports = router;
