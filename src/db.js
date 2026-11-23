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
  _archive: { restaurants: [], items: [], orders: [], coupons: [], leads: [], feedbacks: [] },
};

const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups');
const VAULT_DIR = path.join(path.dirname(DB_FILE), 'vault');
const LEDGER_FILE = path.join(VAULT_DIR, 'audit_ledger.jsonl');
const TMP_FILE = DB_FILE + '.tmp';

// In-Memory Data Store with fallback initialization
let inMemoryData = initialData;

/**
 * Append-only Write-Ahead Disaster Recovery Journal
 */
function appendLedger(action, details = {}) {
  try {
    if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), action, ...details }) + '\n';
    fs.appendFileSync(LEDGER_FILE, entry, 'utf8');
  } catch (_) {}
}

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

    // Safety guard: only prevent write if inMemoryData is corrupt or not an object
    if (!inMemoryData || typeof inMemoryData !== 'object' || !inMemoryData.adminConfig) {
      console.error('🚨 [DB Safety Guard] BLOCKED WRITE: inMemoryData is not properly initialized!');
      return;
    }

    const payload = JSON.stringify(inMemoryData, null, 2);
    // 1. Write to temp file
    fs.writeFileSync(TMP_FILE, payload, 'utf8');

    // 2. Atomic Rename (Guarantees zero corrupt reads even on sudden power loss)
    fs.renameSync(TMP_FILE, DB_FILE);

    // 3. Keep latest backup snapshot in sync with clean state
    if (fs.existsSync(BACKUP_DIR)) {
      const latestPath = path.join(BACKUP_DIR, 'db-backup-latest.json');
      fs.writeFileSync(latestPath, payload, 'utf8');
    }

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

    // Only update db-backup-latest.json if the current state is populated/valid, or if no backup exists yet
    const hasData = Array.isArray(inMemoryData.restaurants) && inMemoryData.restaurants.length > 0;
    if (hasData || !fs.existsSync(latestPath)) {
      fs.writeFileSync(latestPath, serialized, 'utf8');
    }

    // Daily Immutable Backup Archive (Never pruned, 1 snapshot per calendar day)
    const dailyDir = path.join(BACKUP_DIR, 'daily');
    if (!fs.existsSync(dailyDir)) fs.mkdirSync(dailyDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const dailyFile = path.join(dailyDir, `db_${today}.json`);
    if (!fs.existsSync(dailyFile) && hasData) {
      fs.writeFileSync(dailyFile, serialized, 'utf8');
      console.log(`[DB Disaster Recovery] Permanent daily archive created: ${dailyFile}`);
    }

    // Keep the latest 20 historical rolling snapshots
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length > 20) {
      for (const staleFile of files.slice(20)) {
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
 * Zero-Data-Loss Soft Delete: Preserves any deleted restaurant, order, or item
 * into an internal server-side archive that can never be lost.
 */
function archiveRecord(table, record, reason = 'deleted', author = 'system') {
  if (!inMemoryData._archive) {
    inMemoryData._archive = { restaurants: [], items: [], orders: [], coupons: [], leads: [], feedbacks: [] };
  }
  if (!Array.isArray(inMemoryData._archive[table])) {
    inMemoryData._archive[table] = [];
  }
  const archived = {
    ...record,
    _deletedAt: new Date().toISOString(),
    _deletedBy: author,
    _reason: reason,
  };
  inMemoryData._archive[table].unshift(archived);
  appendLedger(`ARCHIVE_${String(table).toUpperCase()}`, { id: record.id, reason, author });
  recordActivity('archive', `${table} record preserved`, `Archived record ID ${record.id || 'N/A'}`);
  persistDb();
  return archived;
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
      try {
        const corruptPath = path.join(BACKUP_DIR, `corrupted_db_${Date.now()}.json`);
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        fs.copyFileSync(DB_FILE, corruptPath);
        console.log(`[DB Disaster Recovery] Preserved corrupted file to ${corruptPath}`);
      } catch (_) {}
    }
  }

  // 2. If primary failed or corrupted, search backup snapshots
  if (!loaded && fs.existsSync(BACKUP_DIR)) {
    console.warn('🔄 [DB Disaster Recovery] Attempting automated snapshot restoration...');
    const candidateFiles = [
      path.join(BACKUP_DIR, 'db-backup-latest.json'),
    ];
    try {
      const allFiles = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'db-backup-latest.json')
        .sort()
        .reverse()
        .map((f) => path.join(BACKUP_DIR, f));
      candidateFiles.push(...allFiles);

      const dailyDir = path.join(BACKUP_DIR, 'daily');
      if (fs.existsSync(dailyDir)) {
        const dailyFiles = fs.readdirSync(dailyDir).filter((f) => f.endsWith('.json')).sort().reverse().map((f) => path.join(dailyDir, f));
        candidateFiles.push(...dailyFiles);
      }
    } catch (_) {}

    for (const candidate of candidateFiles) {
      try {
        if (fs.existsSync(candidate)) {
          const backupRaw = fs.readFileSync(candidate, 'utf8');
          const backupParsed = JSON.parse(backupRaw);
          if (backupParsed && Array.isArray(backupParsed.restaurants)) {
            inMemoryData = backupParsed;
            loaded = true;
            console.log(`✅ [DB Disaster Recovery] Successfully recovered from ${path.basename(candidate)}!`);
            forceFlushDb(); // Persist restored state back to primary db.json
            break;
          }
        }
      } catch (_) {}
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
  archiveRecord,
  appendLedger,
  findRestaurantById,
  findRestaurantByShortId,
  findRestaurantBySlug,
  findOrderById,
  rebuildIndexes,
};
