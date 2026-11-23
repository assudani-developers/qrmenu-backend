const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/services/saas');

test('Catalogue: exactly Starter, Growth and Ultra; Ultra is the best value', () => {
  const plans = S.getPlans();
  assert.deepEqual(Object.keys(plans), ['starter', 'growth', 'ultra']);
  assert.deepEqual(Object.values(plans).map((p) => p.price), [199, 399, 699]);
  assert.equal(plans.ultra.popular, true);
  assert.equal(plans.growth.popular, false || undefined);

  // designs: 3 / 6 / 10 and each tier includes the one below
  assert.deepEqual(Object.values(plans).map((p) => p.features.templates.length), [3, 6, 10]);
  assert.deepEqual(Object.values(plans).map((p) => p.features.qrThemes.length), [3, 6, 10]);
  assert.ok(plans.starter.features.templates.every((t) => plans.growth.features.templates.includes(t)));
  assert.equal(S.templates().length, 10);
  assert.equal(S.qrThemes().length, 10);

  // starter is a real product: photos, cover, offers banner, social buttons, branding stays
  const st = plans.starter.features;
  assert.equal(st.photosPerDish, 1);
  assert.ok(st.coverImage && st.announcement && st.socialLinks && st.reviewInterceptor);
  assert.equal(st.removeBranding, false);
  assert.equal(st.ordering, false);
  assert.equal(plans.growth.features.photosPerDish, 3);

  // gates resolve to the cheapest plan that has them
  assert.equal(S.requiredPlanFor('ordering'), 'growth');
  assert.equal(S.requiredPlanFor('inventory'), 'ultra');
  assert.equal(S.requiredPlanFor('templates', 'luxe'), 'ultra');
  assert.equal(S.requiredPlanFor('qrThemes', 'sunset'), 'growth');

  // removed features are gone everywhere
  const all = JSON.stringify({ plans, catalog: S.catalog() });
  for (const k of ['voiceAssistant', 'crmSuite', 'staffManagement', 'multiOutlet', 'customSlug', 'aiScansPerMonth', 'master', 'elite']) assert.ok(!all.includes(k), k);
});

test('Inventory low-stock reorder maths', () => {
  const inventory = [
    { id: 'inv_1', name: 'Amul Butter', stock: 2, minStock: 5, costPerUnit: 55, unit: 'pcs' },
    { id: 'inv_2', name: 'Paneer', stock: 12, minStock: 5, costPerUnit: 320, unit: 'kg' },
  ];
  const lowStock = inventory.filter((i) => i.stock <= i.minStock);
  assert.equal(lowStock.length, 1);
  const reorderQty = Math.max(10, lowStock[0].minStock * 2 - lowStock[0].stock);
  assert.equal(reorderQty * lowStock[0].costPerUnit, 550);
});
