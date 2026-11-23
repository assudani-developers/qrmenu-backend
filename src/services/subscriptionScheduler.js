'use strict';
/**
 * Subscription Expiry & Grace Period Scheduler
 * Automated daily monitoring for trial & paid subscriptions
 * Handles:
 *  - 3-day pre-expiry alerts
 *  - 1-day pre-expiry alerts
 *  - 3-day grace period courtesy alerts (strictly for paid plans)
 */

const { inMemoryData, persistDb } = require('../db');
const S = require('./saas');
const mailer = require('./mailer');

async function scanAndSendSubscriptionAlerts() {
  const restaurants = inMemoryData.restaurants || [];
  const todayStr = new Date().toISOString().slice(0, 10); // e.g. "2026-11-23"

  for (const r of restaurants) {
    if (!r.email || !r.email.includes('@')) continue;

    const sub = S.subscriptionState(r);
    r.alertLog = r.alertLog || {};

    const plans = S.getPlans();
    const planName = plans[sub.plan]?.name || sub.plan;
    const renewUrl = `${S.menuBaseUrl()}/pricing`;

    // 1. Paid Plan Grace Period (Strictly for paid plans, 3 days duration)
    if (sub.inGrace && sub.status === 'grace_period') {
      const graceKey = `grace_${sub.graceDaysLeft}_${todayStr}`;
      if (!r.alertLog[graceKey]) {
        r.alertLog[graceKey] = true;
        await mailer.sendGracePeriodEmail({
          to: r.email,
          restaurantName: r.name,
          planName,
          graceDaysLeft: sub.graceDaysLeft,
          renewUrl,
        }).catch((e) => console.error(`[Scheduler:Grace:Err] ${r.name}:`, e.message));

        S.notify(r, {
          type: 'subscription',
          title: '3-Day Grace Period Active',
          body: `Your paid plan has expired. Courtesy grace period active: ${sub.graceDaysLeft} day(s) left before menu suspension.`,
        });
      }
      continue;
    }

    // 2. 3 Days Before Expiry Alert (Trial & Paid)
    if ((sub.status === 'trial' || sub.status === 'active') && sub.daysLeft === 3) {
      const key3 = `exp3_${todayStr}`;
      if (!r.alertLog[key3]) {
        r.alertLog[key3] = true;
        await mailer.sendExpiryAlertEmail({
          to: r.email,
          restaurantName: r.name,
          planName,
          daysLeft: 3,
          isTrial: sub.status === 'trial',
          renewUrl,
        }).catch((e) => console.error(`[Scheduler:Exp3:Err] ${r.name}:`, e.message));

        S.notify(r, {
          type: 'subscription',
          title: 'Subscription Expiring Soon',
          body: `Your ${planName} ${sub.status === 'trial' ? 'trial' : 'subscription'} expires in 3 days. Renew to avoid downtime.`,
        });
      }
    }

    // 3. 1 Day Before Expiry Alert (Trial & Paid)
    if ((sub.status === 'trial' || sub.status === 'active') && sub.daysLeft === 1) {
      const key1 = `exp1_${todayStr}`;
      if (!r.alertLog[key1]) {
        r.alertLog[key1] = true;
        await mailer.sendExpiryAlertEmail({
          to: r.email,
          restaurantName: r.name,
          planName,
          daysLeft: 1,
          isTrial: sub.status === 'trial',
          renewUrl,
        }).catch((e) => console.error(`[Scheduler:Exp1:Err] ${r.name}:`, e.message));

        S.notify(r, {
          type: 'subscription',
          title: 'Subscription Expiring Tomorrow',
          body: `Your ${planName} ${sub.status === 'trial' ? 'trial' : 'subscription'} expires tomorrow. Renew now to keep your menu live.`,
        });
      }
    }
  }

  persistDb();
}

let schedulerTimer = null;

function startSubscriptionScheduler(intervalMs = 3600 * 1000) {
  if (schedulerTimer) clearInterval(schedulerTimer);
  // Initial run after brief 5s warmup
  setTimeout(() => {
    scanAndSendSubscriptionAlerts().catch((err) => console.error('[Scheduler:BootScan:Err]', err.message));
  }, 5000).unref();

  schedulerTimer = setInterval(() => {
    scanAndSendSubscriptionAlerts().catch((err) => console.error('[Scheduler:PeriodicScan:Err]', err.message));
  }, intervalMs);
  schedulerTimer.unref();
}

module.exports = {
  scanAndSendSubscriptionAlerts,
  startSubscriptionScheduler,
};
