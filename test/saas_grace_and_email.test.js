'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/services/saas');
const mailer = require('../src/services/mailer');

after(async () => {
  try { await require('../src/services/ocrLite').terminate(); } catch (_) {}
});

test('Email Service: simulation mode works safely without throwing', async () => {
  const otpRes = await mailer.sendOtpEmail({ to: 'partner@test.com', code: '482910', name: 'Test Rest' });
  assert.equal(otpRes.success, true);
  assert.equal(otpRes.simulated, true);

  const subRes = await mailer.sendPaymentSubmittedEmail({
    to: 'partner@test.com',
    restaurantName: 'Test Diner',
    amount: 1999,
    planName: 'Growth',
    utrRef: '123456789012',
  });
  assert.equal(subRes.success, true);

  const recRes = await mailer.sendPaymentReceiptEmail({
    to: 'partner@test.com',
    restaurantName: 'Test Diner',
    amount: 1999,
    originalPrice: 1999,
    discount: 0,
    planName: 'Growth',
    utrRef: '123456789012',
    validUntil: new Date(Date.now() + 30 * S.DAY).toISOString(),
    invoiceId: 'INV-TEST-001',
  });
  assert.equal(recRes.success, true);

  const alertRes = await mailer.sendExpiryAlertEmail({
    to: 'partner@test.com',
    restaurantName: 'Test Diner',
    planName: 'Growth',
    daysLeft: 3,
  });
  assert.equal(alertRes.success, true);

  const graceRes = await mailer.sendGracePeriodEmail({
    to: 'partner@test.com',
    restaurantName: 'Test Diner',
    planName: 'Growth',
    graceDaysLeft: 2,
  });
  assert.equal(graceRes.success, true);
});

test('Subscription Grace Period: Free Trial expires immediately upon end date', () => {
  const r = {
    id: 'rest-trial-test',
    name: 'Trial Place',
    isActive: true,
    subscription: {
      plan: 'growth',
      status: 'trial',
      trialEndsAt: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
      paidUntil: null,
    },
  };
  const st = S.subscriptionState(r);
  assert.equal(st.status, 'expired');
  assert.equal(st.inGrace, false);
  assert.equal(S.isMenuLive(r), false);
});

test('Subscription Grace Period: Paid Plan gets strictly 3 days grace period with menu staying live', () => {
  const ONE_DAY_MS = 24 * 3600 * 1000;
  const r = {
    id: 'rest-paid-test',
    name: 'Paid Place',
    isActive: true,
    subscription: {
      plan: 'growth',
      status: 'active',
      trialEndsAt: null,
      paidUntil: new Date(Date.now() - ONE_DAY_MS).toISOString(), // expired 1 day ago
    },
  };
  const st = S.subscriptionState(r);
  assert.equal(st.status, 'grace_period');
  assert.equal(st.inGrace, true);
  assert.equal(st.graceDaysLeft, 2); // 3 - 1 = 2 days left
  assert.equal(S.isMenuLive(r), true); // Menu is STILL live!

  // Now test after 4 days (grace period ended)
  r.subscription.paidUntil = new Date(Date.now() - 4 * ONE_DAY_MS).toISOString();
  const stExpired = S.subscriptionState(r);
  assert.equal(stExpired.status, 'expired');
  assert.equal(stExpired.inGrace, false);
  assert.equal(S.isMenuLive(r), false); // Menu is now suspended
});

test('Restaurant Creation: stores email correctly in lower-case', () => {
  const r = S.createRestaurant({
    name: 'Biryani Express',
    ownerName: 'Piyush',
    phone: '9413879444',
    city: 'Jaipur',
    email: 'Piyush@Example.Com ',
  });
  assert.equal(r.email, 'piyush@example.com');
});

test('Restaurant Creation: startTrial=false creates pending subscription without free trial', () => {
  const r = S.createRestaurant({
    name: 'Direct Pay Restro',
    ownerName: 'Piyush',
    phone: '9413879445',
    city: 'Jaipur',
    email: 'direct@example.com',
    plan: 'growth',
    startTrial: false,
  });
  assert.equal(r.subscription.status, 'pending');
  assert.equal(r.subscription.trialStartedAt, null);
  assert.equal(r.subscription.trialEndsAt, null);
  assert.equal(r.subscription.paidUntil, null);
  assert.equal(S.isMenuLive(r), false); // Menu is locked until paid
});

test('UPI Screenshot Auto-Check: verifies genuine, rejects wrong amount, and blocks reused hashes', async () => {
  const sharp = require('sharp');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const payProof = require('../src/services/payProof');

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const svg = `
    <svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <text x="50" y="100" font-size="24" fill="#111111" font-family="sans-serif">Payment Successful</text>
      <text x="50" y="160" font-size="20" fill="#444444" font-family="sans-serif">Paid to Piyush Assudani</text>
      <text x="50" y="200" font-size="18" fill="#666666" font-family="sans-serif">UPI ID: 9413879444@yespop</text>
      <text x="50" y="280" font-size="36" font-weight="bold" fill="#000000" font-family="sans-serif">Rs. 559.00</text>
      <text x="50" y="350" font-size="16" fill="#555555" font-family="sans-serif">Date: ${dateStr} at ${timeStr}</text>
      <text x="50" y="400" font-size="16" fill="#555555" font-family="sans-serif">UPI Ref No: 412345678901</text>
    </svg>
  `;

  const tmpImg = path.join(os.tmpdir(), `test_ss_${Date.now()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(tmpImg);

  try {
    const payee = {
      amount: 559,
      payeeName: 'Piyush Assudani',
      upiId: '9413879444@yespop',
      usedHashes: new Set(),
      usedUtrs: new Set(),
    };

    // 1. Sahi screenshot (passes instantly)
    const valid = await payProof.check(tmpImg, payee);
    assert.equal(valid.ok, true, `Expected valid proof, got: ${valid.reasons?.join(', ')}`);
    assert.ok(valid.hash);

    // 2. Galat amount screenshot (fails)
    const wrongAmt = await payProof.check(tmpImg, { ...payee, amount: 999 });
    assert.equal(wrongAmt.ok, false);
    assert.ok(wrongAmt.reasons.some((r) => r.includes('Amount ₹999 not found')));

    // 3. Dohraya hua screenshot / Reused hash (fails)
    const reused = await payProof.check(tmpImg, { ...payee, usedHashes: new Set([valid.hash]) });
    assert.equal(reused.ok, false);
    assert.ok(reused.reasons.some((r) => r.includes('already used')));
  } finally {
    if (fs.existsSync(tmpImg)) fs.unlinkSync(tmpImg);
  }
});
