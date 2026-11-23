'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/services/saas');
const mailer = require('../src/services/mailer');

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
