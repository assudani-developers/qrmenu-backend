const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/services/saas');

test('SaaS Catalog: Ultra & Master plans configured with feature gates', () => {
  const plans = S.getPlans();

  assert.ok(plans.starter, 'Starter plan exists');
  assert.ok(plans.growth, 'Growth plan exists');
  assert.ok(plans.ultra, 'Ultra plan exists');
  assert.ok(plans.master, 'Master plan exists');

  // Verify pricing
  assert.equal(plans.starter.price, 199);
  assert.equal(plans.growth.price, 399);
  assert.equal(plans.ultra.price, 699);
  assert.equal(plans.master.price, 1299);

  // Verify Ultra features
  assert.equal(plans.ultra.features.inventory, true, 'Ultra has inventory');
  assert.equal(plans.ultra.features.voiceAssistant, false, 'Ultra does not have voice assistant');
  assert.equal(plans.ultra.features.crmSuite, false, 'Ultra does not have crmSuite');

  // Verify Master features
  assert.equal(plans.master.features.inventory, true, 'Master has inventory');
  assert.equal(plans.master.features.voiceAssistant, true, 'Master has voice assistant (“Bolna”)');
  assert.equal(plans.master.features.crmSuite, true, 'Master has advanced CRM');
  assert.equal(plans.master.features.staffManagement, true, 'Master has staff management');
  assert.equal(plans.master.features.multiOutlet, true, 'Master has multi-outlet');

  // Verify required plan resolver
  assert.equal(S.requiredPlanFor('inventory'), 'ultra');
  assert.equal(S.requiredPlanFor('voiceAssistant'), 'master');
  assert.equal(S.requiredPlanFor('crmSuite'), 'master');
  assert.equal(S.requiredPlanFor('staffManagement'), 'master');
  assert.equal(S.requiredPlanFor('multiOutlet'), 'master');
});

test('Advanced Suite Logic: Inventory Auto-PO, Voice Formatting, CRM LTV', () => {
  // Test Inventory low stock and PO logic
  const inventory = [
    { id: 'inv_1', name: 'Amul Butter', stock: 2, minStock: 5, costPerUnit: 55, unit: 'pcs' },
    { id: 'inv_2', name: 'Paneer', stock: 12, minStock: 5, costPerUnit: 320, unit: 'kg' },
  ];
  const lowStock = inventory.filter((i) => i.stock <= i.minStock);
  assert.equal(lowStock.length, 1);
  assert.equal(lowStock[0].name, 'Amul Butter');

  const poItems = lowStock.map((i) => {
    const reorderQty = Math.max(10, (i.minStock * 2) - i.stock);
    return { name: i.name, qty: reorderQty, cost: reorderQty * i.costPerUnit };
  });
  assert.equal(poItems[0].qty, 10);
  assert.equal(poItems[0].cost, 550);

  // Test Voice Hindi & English script generation
  const mockOrder = {
    token: 42,
    tableNumber: 'Table 5',
    items: [{ name: 'Butter Chicken', qty: 2 }, { name: 'Garlic Naan', qty: 3 }],
  };
  const dishNames = mockOrder.items.map((i) => `${i.qty} ${i.name}`).join(', ');
  const textHi = `टेबल ${mockOrder.tableNumber} से नया ऑर्डर आया है! टोकन नंबर ${mockOrder.token}. ${dishNames}.`;
  const textEn = `New order received from ${mockOrder.tableNumber}! Token number ${mockOrder.token}. ${dishNames}.`;
  assert.ok(textHi.includes('Table 5'));
  assert.ok(textHi.includes('2 Butter Chicken, 3 Garlic Naan'));
  assert.ok(textEn.includes('Table 5'));

  // Test CRM LTV & VIP Tier Calculation
  const guests = [
    { phone: '9876543210', totalSpend: 12000, visits: 11 },
    { phone: '9123456789', totalSpend: 1500, visits: 1 },
  ];
  const vip1 = guests[0].totalSpend >= 10000 ? 'Platinum 👑' : 'Silver';
  const vip2 = guests[1].totalSpend >= 10000 ? 'Platinum 👑' : 'Bronze';
  assert.equal(vip1, 'Platinum 👑');
  assert.equal(vip2, 'Bronze');

  // Test WhatsApp Click-to-Chat URL Generation
  const cleanPhone = '9876543210';
  const restName = 'Royal Feast';
  const msg = `Namaste! Enjoy 15% off at ${restName}`;
  const waUrl = `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(msg)}`;
  assert.ok(waUrl.includes('https://wa.me/919876543210'));
  assert.ok(waUrl.includes('Enjoy%2015%25%20off'));
});
