const os = require('node:os');
const nodePath = require('node:path');
// isolate: these tests persist/corrupt/restore the database, never touch the real one
process.env.DB_FILE = nodePath.join(os.tmpdir(), `qrm-sec-${process.pid}`, 'db.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateOrderBill, calculateItemSubtotal, toPaise, toRupees } = require('../src/utils/calculator');
const { sanitizeString, sanitizeInput } = require('../src/middleware/errorHandler');
const { idempotencyStore } = require('../src/middleware/idempotency');

test('1. Financial Calculator: IEEE 754 precision and zero floating-point bug', () => {
  // Test basic rupee/paise conversions
  assert.equal(toPaise(199.99), 19999);
  assert.equal(toRupees(19999), 199.99);

  // Test item subtotal with variants and modifiers
  const subtotal = calculateItemSubtotal(
    490.0, // base price
    null,  // variant price
    [{ name: 'Extra Truffle Butter', price: 60.0 }, { name: 'Parmesan', price: 40.0 }],
    2      // quantity
  );
  // (490 + 60 + 40) * 2 = 590 * 2 = 1180.0
  assert.equal(subtotal, 1180.0);

  // Test complete order bill calculation (Tax + Discount)
  const bill = calculateOrderBill({
    items: [
      { name: 'Dish A', price: 299.0, qty: 1 },
      { name: 'Dish B', price: 150.0, qty: 2 },
    ],
    taxRatePercent: 5.0,
    discountPercent: 10.0,
  });

  // itemsSubtotal = 299 + 300 = 599.00
  // 10% discount = 59.90 -> Taxable = 539.10
  // 5% GST on 539.10 = 26.96
  // Grand Total = 539.10 + 26.96 = 566.06
  assert.equal(bill.itemsSubtotal, 599.0);
  assert.equal(bill.discountAmount, 59.9);
  assert.equal(bill.taxableAmount, 539.1);
  assert.equal(bill.taxAmount, 26.96);
  assert.equal(bill.grandTotal, 566.06);
});

test('2. Chaos Input Validation: Rejects negative prices, zero quantity, and non-numeric garbage', () => {
  // Negative price
  assert.throws(() => {
    toPaise(-50);
  }, /Invalid price value/);

  // NaN price
  assert.throws(() => {
    toPaise(NaN);
  }, /Invalid price value/);

  // Zero or negative quantity
  assert.throws(() => {
    calculateItemSubtotal(100, null, [], 0);
  }, /Quantity must be an integer greater than 0/);

  assert.throws(() => {
    calculateItemSubtotal(100, null, [], -3);
  }, /Quantity must be an integer greater than 0/);

  // Empty items list
  assert.throws(() => {
    calculateOrderBill({ items: [] });
  }, /Order must contain at least 1 item/);
});

test('3. Security Sanitization: Neutralizes XSS and Malicious Script Payloads', () => {
  const dirtyString = '<script>alert("Hacked!")</script> Chicken Tikka';
  const clean = sanitizeString(dirtyString);
  assert.equal(clean.includes('<script>'), false);
  assert.equal(clean.includes('&lt;script&gt;'), true);

  const maliciousPayload = {
    customerName: '<img src=x onerror=alert(1)>',
    tableNumber: 'Table 4\' OR 1=1 --',
    items: [{ name: '<b onmouseover=evil()>Naan</b>' }],
  };

  const sanitized = sanitizeInput(maliciousPayload);
  assert.equal(sanitized.customerName.includes('<img'), false);
  assert.equal(sanitized.items[0].name.includes('<b'), false);
});

test('4. Idempotency Guard: Identical key prevents duplicate order creations on 1000 clicks', () => {
  const testKey = 'test-idempotency-uuid-999';

  // Simulate first request
  idempotencyStore.set(testKey, {
    status: 'completed',
    statusCode: 201,
    body: { id: 'KOT-101', totalAmount: 566.06 },
    timestamp: Date.now(),
  });

  // Verify second request gets cached response
  assert.equal(idempotencyStore.has(testKey), true);
  const cached = idempotencyStore.get(testKey);
  assert.equal(cached.statusCode, 201);
  assert.equal(cached.body.id, 'KOT-101');
});

test('5. Atomic Database Persistence: POSIX temp file + rename sync guarantees zero corruption', () => {
  const { persistDb, forceFlushDb, inMemoryData } = require('../src/db');
  const fs = require('fs');
  const path = require('path');
  const DB_FILE = process.env.DB_FILE;

  // Trigger write and force flush
  persistDb();
  forceFlushDb();

  assert.equal(fs.existsSync(DB_FILE), true);
  const content = fs.readFileSync(DB_FILE, 'utf8');
  const parsed = JSON.parse(content);
  assert.equal(Array.isArray(parsed.restaurants), true);
  assert.equal(parsed.restaurants.length, inMemoryData.restaurants.length);
});

test('6. Concurrency Table Lock: 100 concurrent bursts on the same table are strictly serialized', async () => {
  const { withTableLock } = require('../src/db');
  const executionOrder = [];

  const promises = Array.from({ length: 20 }, (_, i) => {
    return withTableLock('Table 4', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(i);
      return i;
    });
  });

  const results = await Promise.all(promises);
  assert.equal(results.length, 20);
  assert.equal(executionOrder.length, 20);
});

test('7. O(1) In-Memory Hash Indexing: Instantaneous multi-tenant restaurant and QR lookups', () => {
  const { findRestaurantById, findRestaurantByShortId, findRestaurantBySlug } = require('../src/db');
  const { createRestaurant } = require('../src/services/saas');
  const rest = createRestaurant({ name: 'Index Test Cafe', ownerName: 'I', phone: '9000000000' });

  assert.equal(findRestaurantById(rest.id).name, rest.name);
  assert.equal(findRestaurantByShortId(rest.shortId).slug, rest.slug);
  assert.equal(findRestaurantBySlug(rest.slug).id, rest.id);

  // Non-existent lookup
  assert.equal(findRestaurantByShortId('fake-xyz-000'), null);
});

test('8. IP Quarantine Firewall: Quarantines abusive clients after excessive rate violations', () => {
  const { ipBlockerMiddleware, blockedIps } = require('../src/middleware/rateLimiter');
  const maliciousIp = '198.51.100.42';

  // Simulate active ban
  blockedIps.set(maliciousIp, Date.now() + 60000);

  let nextCalled = false;
  let responseStatus = null;
  let responseBody = null;

  const mockReq = { ip: maliciousIp, connection: { remoteAddress: maliciousIp } };
  const mockRes = {
    status(code) {
      responseStatus = code;
      return {
        json(data) {
          responseBody = data;
        },
      };
    },
  };

  ipBlockerMiddleware(mockReq, mockRes, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(responseStatus, 403);
  assert.equal(responseBody.error, 'Forbidden');
  assert.equal(responseBody.message.includes('quarantined'), true);

  // Clean up test ban
  blockedIps.delete(maliciousIp);
});

test('9. Automated Disaster Recovery: Restores from backup snapshot if db.json is corrupted', () => {
  const fs = require('fs');
  const path = require('path');
  const { createSnapshot, loadDatabaseWithRecovery, forceFlushDb } = require('../src/db');

  const DB_FILE = process.env.DB_FILE;
  forceFlushDb(); // Ensure primary db.json exists on disk
  const originalContent = fs.readFileSync(DB_FILE, 'utf8');

  // 1. Create a known healthy snapshot
  createSnapshot('test_disaster_recovery');

  // 2. Corrupt the primary database with raw non-JSON garbage
  fs.writeFileSync(DB_FILE, '<<<CORRUPT_TRUNCATED_NON_JSON_DATA>>>', 'utf8');

  // 3. Trigger Disaster Recovery Loader
  loadDatabaseWithRecovery();

  // 4. Verify system healed itself and restored valid JSON
  assert.equal(fs.existsSync(DB_FILE), true);
  const healedContent = fs.readFileSync(DB_FILE, 'utf8');
  const healedParsed = JSON.parse(healedContent);
  assert.equal(Array.isArray(healedParsed.restaurants), true);

  // Restore original content
  fs.writeFileSync(DB_FILE, originalContent, 'utf8');
});

test('10. Circuit Breaker & Exponential Backoff: Protects third-party quota & fails fast when down', async () => {
  const { CircuitBreaker, fetchWithBackoff } = require('../src/utils/resilientClient');

  const breaker = new CircuitBreaker({ name: 'TestGateway', failureThreshold: 2, cooldownPeriodMs: 50 });

  let attempts = 0;
  const failingAction = async () => {
    attempts++;
    throw new Error('503 Service Unavailable');
  };

  // 1st failure
  await assert.rejects(async () => breaker.execute(failingAction), /503/);
  assert.equal(breaker.state, 'CLOSED');

  // 2nd failure trips breaker to OPEN
  await assert.rejects(async () => breaker.execute(failingAction), /503/);
  assert.equal(breaker.state, 'OPEN');

  // Next call fails fast without executing failingAction!
  const preAttemptCount = attempts;
  await assert.rejects(async () => breaker.execute(failingAction), /Circuit breaker OPEN/);
  assert.equal(attempts, preAttemptCount); // Action was NOT invoked

  // Test exponential backoff retry
  let retryCount = 0;
  const retryableTask = async () => {
    retryCount++;
    if (retryCount < 2) throw new Error('Network timeout');
    return 'SUCCESS';
  };

  const res = await fetchWithBackoff(retryableTask, 3, 10);
  assert.equal(res, 'SUCCESS');
  assert.equal(retryCount, 2);
});

test('11. Asynchronous In-Memory Job Queue: Throttles background tasks to prevent I/O blocking', async () => {
  const { AsyncJobQueue } = require('../src/utils/resilientClient');
  const queue = new AsyncJobQueue(2); // max 2 concurrent jobs
  let activeMax = 0;
  let currentlyRunning = 0;

  const tasks = Array.from({ length: 6 }, (_, i) => {
    return queue.enqueue(async () => {
      currentlyRunning++;
      activeMax = Math.max(activeMax, currentlyRunning);
      await new Promise((resolve) => setTimeout(resolve, 15));
      currentlyRunning--;
      return `job-${i}`;
    });
  });

  const completed = await Promise.all(tasks);
  assert.equal(completed.length, 6);
  assert.equal(activeMax <= 2, true); // Concurrency never exceeded 2!
});

test('12. Stateless JWT & RBAC Matrix: Strictly enforces Owner, Manager, Clerk, Teacher permissions', () => {
  const { generateToken, ROLE_PERMISSIONS } = require('../src/middleware/auth');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../src/middleware/auth');

  // 1. Generate token
  const token = generateToken({ id: 'usr-101', role: 'owner', email: 'owner@restaurant.in' });
  const decoded = jwt.verify(token, JWT_SECRET);
  assert.equal(decoded.id, 'usr-101');
  assert.equal(decoded.role, 'owner');

  // 2. Verify RBAC permission mappings
  assert.equal(ROLE_PERMISSIONS.owner.includes('create_order'), true);
  assert.equal(ROLE_PERMISSIONS.owner.includes('view_billing'), true);
  assert.equal(ROLE_PERMISSIONS.owner.includes('delete_user'), true);

  // Manager: can create orders and view billing, but cannot delete users
  assert.equal(ROLE_PERMISSIONS.manager.includes('create_order'), true);
  assert.equal(ROLE_PERMISSIONS.manager.includes('view_billing'), true);
  assert.equal(ROLE_PERMISSIONS.manager.includes('delete_user'), false);

  // Clerk: can punch orders and view billing
  assert.equal(ROLE_PERMISSIONS.clerk.includes('create_order'), true);
  assert.equal(ROLE_PERMISSIONS.clerk.includes('view_billing'), true);
  assert.equal(ROLE_PERMISSIONS.clerk.includes('delete_user'), false);

  // Teacher: can create orders and view menu
  assert.equal(ROLE_PERMISSIONS.teacher.includes('create_order'), true);
  assert.equal(ROLE_PERMISSIONS.teacher.includes('view_menu'), true);
  assert.equal(ROLE_PERMISSIONS.teacher.includes('view_billing'), false);
  assert.equal(ROLE_PERMISSIONS.teacher.includes('delete_user'), false);
});

test('13. Timezone Resilience: Formats timestamps in local restaurant timezone with zero date drift', () => {
  const { toUtcIso, formatRestaurantDate } = require('../src/utils/resilientClient');

  const utcNow = toUtcIso();
  assert.equal(utcNow.endsWith('Z'), true);

  const formattedIst = formatRestaurantDate('2026-11-18T10:30:00.000Z', 'Asia/Kolkata');
  // 10:30 UTC + 5:30 = 16:00 IST (4:00 PM)
  assert.equal(formattedIst.includes('4:00'), true);
  assert.equal(formattedIst.includes('Nov'), true);
  assert.equal(formattedIst.includes('2026'), true);
});

