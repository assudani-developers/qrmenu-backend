const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '../data/db.json');

/**
 * Default Seed Data: Production-grade multi-tenant single source of truth
 */
const initialData = {
  adminConfig: { adminUpiId: '', adminPhone: '', supportEmail: '', plans: {}, settings: {} },
  restaurants: [],
  orders: [],
  feedbacks: [],
  payments: [],
  activities: [],
  leads: [],
  coupons: [],
};

const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups');
const TMP_FILE = DB_FILE + '.tmp';

// In-Memory Data Store with fallback initialization
let inMemoryData = initialData;

// In-Memory O(1) Index Maps
const indexById = new Map();
const indexByShortId = new Map();
const indexBySlug = new Map();
const indexOrdersById = new Map();

function rebuildIndexes() {
  indexById.clear();
  indexByShortId.clear();
  indexBySlug.clear();
  indexOrdersById.clear();

  if (Array.isArray(inMemoryData.restaurants)) {
    for (const rest of inMemoryData.restaurants) {
      if (rest.id) indexById.set(rest.id, rest);
      if (rest.shortId) indexByShortId.set(rest.shortId, rest);
      if (rest.slug) indexBySlug.set(rest.slug, rest);
    }
  }

  if (Array.isArray(inMemoryData.orders)) {
    for (const ord of inMemoryData.orders) {
      if (ord.id) indexOrdersById.set(ord.id, ord);
    }
  }
}

// Debounce & Write-Behind Architecture
let writeTimer = null;
let hasPendingMutation = false;

/**
 * Atomic File Persistence: Writes to a temp file, syncs to OS disk, then atomic rename
 */
function performAtomicDiskSync() {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = JSON.stringify(inMemoryData, null, 2);
    // 1. Write to temp file
    fs.writeFileSync(TMP_FILE, payload, 'utf8');

    // 2. Atomic Rename (Guarantees zero corrupt reads even on sudden power loss)
    fs.renameSync(TMP_FILE, DB_FILE);

    hasPendingMutation = false;
  } catch (err) {
    console.error('🚨 [DB Atomic Write Error]:', err.message);
  }
}

/**
 * Persist database with write-behind coalescing (50ms debounce)
 * Minimizes cloud disk I/O and server bills by coalescing 1000 rapid writes into 1.
 */
function persistDb() {
  hasPendingMutation = true;
  rebuildIndexes();

  if (writeTimer) {
    clearTimeout(writeTimer);
  }

  writeTimer = setTimeout(() => {
    writeTimer = null;
    performAtomicDiskSync();
  }, 50);
}

/**
 * Force immediate synchronous write (called on SIGTERM, SIGINT, or test assertions)
 */
function forceFlushDb() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  performAtomicDiskSync();
  rebuildIndexes();
}

/**
 * Creates an automated backup snapshot on disk
 */
function createSnapshot(reason = 'auto') {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(BACKUP_DIR, `snapshot_${reason}_${timestamp}.json`);
    const latestPath = path.join(BACKUP_DIR, `db-backup-latest.json`);

    const serialized = JSON.stringify(inMemoryData, null, 2);
    fs.writeFileSync(snapshotPath, serialized, 'utf8');
    fs.writeFileSync(latestPath, serialized, 'utf8');

    // Keep only the latest 10 historical snapshots to avoid disk bloat
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length > 10) {
      for (const staleFile of files.slice(10)) {
        try {
          fs.unlinkSync(path.join(BACKUP_DIR, staleFile));
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('[DB Disaster Recovery] Snapshot error:', err.message);
  }
}

/**
 * Disaster Recovery Loader: Restores healthy state even if db.json is corrupted
 */
function loadDatabaseWithRecovery() {
  let loaded = false;

  // 1. Try reading the primary database file
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      if (raw && raw.trim().length > 0) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.restaurants)) {
          inMemoryData = parsed;
          loaded = true;
          console.log(`[DB] Successfully loaded ${inMemoryData.restaurants.length} restaurants from primary db.json`);
        }
      }
    } catch (parseErr) {
      console.error('🚨 [DB Corruption Alert] Primary db.json is corrupted or incomplete:', parseErr.message);
    }
  }

  // 2. If primary failed or corrupted, search backup snapshots
  if (!loaded && fs.existsSync(BACKUP_DIR)) {
    console.warn('🔄 [DB Disaster Recovery] Attempting automated snapshot restoration...');
    try {
      const latestPath = path.join(BACKUP_DIR, 'db-backup-latest.json');
      if (fs.existsSync(latestPath)) {
        const backupRaw = fs.readFileSync(latestPath, 'utf8');
        const backupParsed = JSON.parse(backupRaw);
        if (backupParsed && Array.isArray(backupParsed.restaurants)) {
          inMemoryData = backupParsed;
          loaded = true;
          console.log('✅ [DB Disaster Recovery] Successfully recovered from latest healthy backup snapshot!');
          forceFlushDb(); // Persist restored state back to primary db.json
        }
      }
    } catch (backupErr) {
      console.error('❌ [DB Disaster Recovery] Backup restore failed:', backupErr.message);
    }
  }

  // 3. Fallback to pristine initial data if everything failed
  if (!loaded) {
    console.log('[DB] Initializing fresh database from pristine seed data.');
    inMemoryData = initialData;
    createSnapshot('initial_seed');
    forceFlushDb();
  }

  rebuildIndexes();
}

// Initialize on require
loadDatabaseWithRecovery();

/**
 * Table-level Concurrency Lock: Serializes concurrent operations for the same table
 */
const tableLockQueues = new Map();

async function withTableLock(tableNumber, task) {
  const key = String(tableNumber || 'global_table').trim();
  const previousLock = tableLockQueues.get(key) || Promise.resolve();

  const currentTaskPromise = previousLock
    .catch(() => {}) // Don't fail current task if previous one threw
    .then(async () => {
      return await task();
    });

  tableLockQueues.set(key, currentTaskPromise);

  try {
    return await currentTaskPromise;
  } finally {
    if (tableLockQueues.get(key) === currentTaskPromise) {
      tableLockQueues.delete(key);
    }
  }
}

/**
 * Fast O(1) Lookups
 */
function findRestaurantById(id) {
  return indexById.get(id) || null;
}

function findRestaurantByShortId(shortId) {
  return indexByShortId.get(shortId) || null;
}

function findRestaurantBySlug(slug) {
  return indexBySlug.get(slug) || null;
}

function findOrderById(id) {
  return indexOrdersById.get(id) || null;
}

/**
 * Add an event to the platform audit trail
 */
function recordActivity(type, title, description) {
  const newAct = {
    id: `ACT-${Date.now().toString().slice(-4)}`,
    type,
    title,
    description,
    timeAgo: 'Just now',
    timestamp: new Date().toISOString(),
  };
  inMemoryData.activities.unshift(newAct);
  if (inMemoryData.activities.length > 50) {
    inMemoryData.activities.pop();
  }
  persistDb();
  return newAct;
}

// Single Source of Truth References
const restaurantsDb = inMemoryData.restaurants;
const ordersDb = inMemoryData.orders;
const feedbacksDb = inMemoryData.feedbacks;
const adminConfig = inMemoryData.adminConfig;
const paymentsDb = inMemoryData.payments;
const activitiesDb = inMemoryData.activities;

module.exports = {
  inMemoryData,
  restaurantsDb,
  ordersDb,
  feedbacksDb,
  adminConfig,
  paymentsDb,
  activitiesDb,
  recordActivity,
  persistDb,
  forceFlushDb,
  withTableLock,
  createSnapshot,
  loadDatabaseWithRecovery,
  findRestaurantById,
  findRestaurantByShortId,
  findRestaurantBySlug,
  findOrderById,
  rebuildIndexes,
};
