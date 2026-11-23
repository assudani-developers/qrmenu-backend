/**
 * Precision Financial & Billing Calculator
 * Prevents IEEE 754 floating point arithmetic bugs (e.g. 0.1 + 0.2 = 0.30000000000000004)
 * Uses integer math (paise / cents) for internal calculations and rounds to 2 decimal places.
 */

// Convert ₹ to Paise (Integer)
function toPaise(rupees) {
  if (typeof rupees !== 'number' || isNaN(rupees) || !isFinite(rupees) || rupees < 0) {
    throw new Error(`Invalid price value: ${rupees}. Must be a valid non-negative number.`);
  }
  return Math.round(rupees * 100);
}

// Convert Paise (Integer) to ₹
function toRupees(paise) {
  return Number((paise / 100).toFixed(2));
}

/**
 * Calculates item total with variants and modifiers safely
 */
function calculateItemSubtotal(basePrice, variantPrice = null, modifiers = [], quantity = 1) {
  if (quantity <= 0 || !Number.isInteger(quantity)) {
    throw new Error('Quantity must be an integer greater than 0.');
  }

  // Use variant price if present, otherwise basePrice
  const unitPrice = variantPrice !== null && variantPrice !== undefined ? variantPrice : basePrice;
  let unitPaise = toPaise(unitPrice);

  for (const mod of modifiers) {
    if (mod && typeof mod.price === 'number') {
      unitPaise += toPaise(mod.price);
    }
  }

  const totalPaise = unitPaise * quantity;
  return toRupees(totalPaise);
}

/**
 * Calculates complete order bill with taxes and discounts safely
 */
function calculateOrderBill({ items = [], taxRatePercent = 5.0, discountPercent = 0.0, deliveryFee = 0.0 }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Order must contain at least 1 item.');
  }

  let itemsSubtotalPaise = 0;

  for (const item of items) {
    const itemSubtotal = calculateItemSubtotal(
      item.price || 0,
      item.variantPrice,
      item.modifiers || [],
      item.qty || item.quantity || 1
    );
    itemsSubtotalPaise += toPaise(itemSubtotal);
  }

  // Calculate discount
  const safeDiscount = Math.max(0, Math.min(100, discountPercent));
  const discountPaise = Math.round((itemsSubtotalPaise * safeDiscount) / 100);
  const discountedSubtotalPaise = itemsSubtotalPaise - discountPaise;

  // Calculate GST / Tax
  const safeTaxRate = Math.max(0, Math.min(100, taxRatePercent));
  const taxPaise = Math.round((discountedSubtotalPaise * safeTaxRate) / 100);

  // Delivery / Packaging fee
  const deliveryPaise = toPaise(Math.max(0, deliveryFee));

  // Grand Total
  const grandTotalPaise = discountedSubtotalPaise + taxPaise + deliveryPaise;

  return {
    itemsSubtotal: toRupees(itemsSubtotalPaise),
    discountAmount: toRupees(discountPaise),
    discountPercent: safeDiscount,
    taxableAmount: toRupees(discountedSubtotalPaise),
    taxAmount: toRupees(taxPaise),
    taxRatePercent: safeTaxRate,
    deliveryFee: toRupees(deliveryPaise),
    grandTotal: toRupees(grandTotalPaise),
    calculatedAt: new Date().toISOString(),
  };
}

module.exports = {
  toPaise,
  toRupees,
  calculateItemSubtotal,
  calculateOrderBill,
};
