const express = require('express');
const router = express.Router();
const { calculateOrderBill } = require('../utils/calculator');
const { idempotency } = require('../middleware/idempotency');
const { orderLimiter } = require('../middleware/rateLimiter');
const { ordersDb, persistDb, withTableLock } = require('../db');

/**
 * POST /api/orders
 * Creates a new KOT order with concurrency table locking, idempotency protection, and financial validation.
 */
router.post('/', orderLimiter, idempotency(), async (req, res, next) => {
  try {
    const {
      tableNumber,
      items,
      discountPercent,
      taxRatePercent,
      customerNotes,
      customerName,
      customerPhone,
      receiptHeader,
      receiptFooter,
      restaurantId,
    } = req.body;

    // Strict Input Validation
    if (!tableNumber || typeof tableNumber !== 'string' || tableNumber.trim().length === 0) {
      return res.status(400).json({
        status: 400,
        error: 'Bad Request',
        message: 'Valid tableNumber is required (e.g. "Table 4").',
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        status: 400,
        error: 'Bad Request',
        message: 'Order items must be a non-empty array.',
      });
    }

    // Validate each item
    for (const item of items) {
      if (!item.name || typeof item.name !== 'string' || item.name.trim().length === 0) {
        return res.status(400).json({ status: 400, error: 'Bad Request', message: 'Each item must have a valid name.' });
      }
      const qty = Number(item.qty || item.quantity);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 100) {
        return res.status(400).json({ status: 400, error: 'Bad Request', message: `Invalid quantity "${qty}". Must be integer between 1 and 100.` });
      }
      const price = Number(item.price);
      if (isNaN(price) || price < 0 || price > 50000) {
        return res.status(400).json({ status: 400, error: 'Bad Request', message: `Invalid price "${price}". Must be between 0 and 50,000.` });
      }
    }

    // Exact financial calculation (zero float drift)
    const billing = calculateOrderBill({
      items,
      taxRatePercent: typeof taxRatePercent === 'number' ? taxRatePercent : 5.0,
      discountPercent: typeof discountPercent === 'number' ? discountPercent : 0.0,
    });

    // Execute with Table-Level Concurrency Lock
    const newOrder = await withTableLock(tableNumber, async () => {
      const receiptNo = `AQ-REC-${Math.floor(10000 + Math.random() * 90000)}`;
      const order = {
        id: `KOT-${Math.floor(100 + Math.random() * 900)}`,
        receiptNo,
        restaurantId: restaurantId ? String(restaurantId) : null,
        tableNumber: tableNumber.trim(),
        customer: {
          name: customerName && String(customerName).trim().length > 0 ? String(customerName).trim() : 'Guest Diner',
          phone: customerPhone && String(customerPhone).trim().length > 0 ? String(customerPhone).trim() : '',
        },
        status: 'pending',
        items: items.map((i) => ({
          name: i.name.trim(),
          qty: Number(i.qty || i.quantity),
          price: Number(i.price),
          notes: i.notes ? String(i.notes).trim() : null,
        })),
        billing,
        totalAmount: billing.grandTotal,
        customerNotes: customerNotes ? String(customerNotes).trim() : null,
        receiptHeader: receiptHeader ? String(receiptHeader).trim() : 'Tax Invoice & Order Slip',
        receiptFooter: receiptFooter ? String(receiptFooter).trim() : 'Thank you for dining with us! Freshly cooked with passion.',
        watermark: 'POWERED BY ASSUDANI QR OS • DESIGNED & DEVELOPED BY PIYUSH ASSUDANI (FOUNDER, ASSUDANI DEVELOPERS)',
        createdAt: new Date().toISOString(),
        timeAgo: 'Just now',
      };

      ordersDb.unshift(order);
      persistDb(); // Write-behind atomic persistence
      return order;
    });

    // Broadcast real-time event to connected Kitchen Display via Socket.io
    const io = req.app.get('io');
    if (io) {
      io.emit('order:new', newOrder);
      io.emit('notification:new', {
        id: `notif-${Date.now()}`,
        type: 'new_order',
        title: `🔔 New Order: ${newOrder.tableNumber}`,
        message: `${newOrder.customer.name}${newOrder.customer.phone ? ` (${newOrder.customer.phone})` : ''} ordered ${newOrder.items.length} items (₹${newOrder.totalAmount}). Receipt #${newOrder.receiptNo}`,
        receiptNo: newOrder.receiptNo,
        table: newOrder.tableNumber,
        amount: newOrder.totalAmount,
        time: 'Just now',
      });
      console.log(`[Socket.io] Emitted order:new (${newOrder.id}, ${newOrder.receiptNo}) to Owner & Kitchen displays`);
    }

    return res.status(201).json({
      success: true,
      message: 'Order placed successfully and sent to Kitchen KOT display',
      order: newOrder,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/orders
 * Returns orders with optional status filter
 */
router.get('/', (req, res) => {
  const { status, table } = req.query;
  let filtered = [...ordersDb];

  if (status) {
    filtered = filtered.filter((o) => o.status.toLowerCase() === String(status).toLowerCase());
  }

  if (table) {
    filtered = filtered.filter((o) => o.tableNumber.toLowerCase().includes(String(table).toLowerCase()));
  }

  // Caching header: private, max-age 5 seconds (fast live updates)
  res.setHeader('Cache-Control', 'private, max-age=5');
  return res.status(200).json({
    success: true,
    count: filtered.length,
    orders: filtered,
  });
});

/**
 * PATCH /api/orders/:id/status
 * Updates status (pending -> cooking -> served)
 */
router.patch('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'cooking', 'served', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      status: 400,
      error: 'Bad Request',
      message: `Invalid status "${status}". Allowed values: ${validStatuses.join(', ')}`,
    });
  }

  const order = ordersDb.find((o) => o.id === id);
  if (!order) {
    return res.status(404).json({
      status: 404,
      error: 'Not Found',
      message: `Order with ID "${id}" was not found.`,
    });
  }

  order.status = status;
  order.updatedAt = new Date().toISOString();
  persistDb();

  // Broadcast status update to Kitchen & Waiter app
  const io = req.app.get('io');
  if (io) {
    io.emit('order:status_updated', { id, status });
  }

  return res.status(200).json({
    success: true,
    message: `Order ${id} status updated to ${status}`,
    order,
  });
});

module.exports = router;

