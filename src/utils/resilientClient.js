/**
 * Resilient Outbound Client, Circuit Breaker & Asynchronous Job Queue
 * Designed to strictly protect third-party API quotas (free tier optimization),
 * prevent thread starvation, and eliminate timezone drift.
 */

// ==========================================
// 1. CIRCUIT BREAKER (Outbound Quota Shield)
// ==========================================

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5; // Open circuit after 5 consecutive failures
    this.cooldownPeriodMs = options.cooldownPeriodMs || 15000; // Wait 15s before half-open probe
    this.state = 'CLOSED'; // 'CLOSED' (healthy), 'OPEN' (blocked), 'HALF_OPEN' (probing)
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.name = options.name || 'ExternalService';
  }

  async execute(actionFn) {
    const now = Date.now();

    // Check if circuit should transition from OPEN to HALF_OPEN
    if (this.state === 'OPEN') {
      if (now - this.lastFailureTime > this.cooldownPeriodMs) {
        this.state = 'HALF_OPEN';
        console.log(`[Circuit Breaker] ${this.name}: Cooldown elapsed. Entering HALF_OPEN probe state.`);
      } else {
        const remainingCooldown = Math.ceil((this.cooldownPeriodMs - (now - this.lastFailureTime)) / 1000);
        throw new Error(
          `Circuit breaker OPEN for ${this.name}. Outbound request blocked to protect quota and prevent thread stall. Retry in ${remainingCooldown}s.`
        );
      }
    }

    try {
      const result = await actionFn();
      // On success, reset circuit
      if (this.state === 'HALF_OPEN') {
        console.log(`[Circuit Breaker] ${this.name}: Probe successful. Reclosing circuit to CLOSED.`);
      }
      this.state = 'CLOSED';
      this.failureCount = 0;
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.failureThreshold || this.state === 'HALF_OPEN') {
        this.state = 'OPEN';
        console.warn(
          `🚨 [Circuit Breaker Alert] ${this.name} tripped to OPEN state! Failures: ${this.failureCount}/${this.failureThreshold}`
        );
      }
      throw error;
    }
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

// ==========================================
// 2. EXPONENTIAL BACKOFF WITH JITTER
// ==========================================

async function fetchWithBackoff(taskFn, maxRetries = 3, baseDelayMs = 100) {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      return await taskFn();
    } catch (error) {
      attempt++;

      // Do not retry client 4xx errors (400, 401, 403, 404, 422)
      if (error.status >= 400 && error.status < 500) {
        throw error;
      }

      if (attempt >= maxRetries) {
        throw error;
      }

      // Exponential backoff formula with randomized jitter
      const jitter = Math.floor(Math.random() * 50);
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      console.warn(`[Outbound Retry] Attempt ${attempt} failed. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ==========================================
// 3. IN-MEMORY ASYNCHRONOUS JOB QUEUE
// ==========================================

class AsyncJobQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.runningCount = 0;
    this.queue = [];
  }

  enqueue(jobFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ jobFn, resolve, reject, enqueuedAt: Date.now() });
      this._processNext();
    });
  }

  _processNext() {
    if (this.runningCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const { jobFn, resolve, reject } = this.queue.shift();
    this.runningCount++;

    Promise.resolve()
      .then(() => jobFn())
      .then((result) => {
        this.runningCount--;
        resolve(result);
        this._processNext();
      })
      .catch((err) => {
        this.runningCount--;
        reject(err);
        this._processNext();
      });
  }

  getQueueStats() {
    return {
      pendingJobs: this.queue.length,
      activeWorkers: this.runningCount,
      concurrencyLimit: this.concurrency,
    };
  }
}

// ==========================================
// 4. TIMEZONE & DATE RESILIENCE
// ==========================================

/**
 * Normalizes input date to UTC ISO-8601 string
 */
function toUtcIso(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) {
    return new Date().toISOString();
  }
  return d.toISOString();
}

/**
 * Formats ISO date to restaurant local timezone cleanly without desync
 */
function formatRestaurantDate(isoString, timeZone = 'Asia/Kolkata') {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'Invalid Date';

    return new Intl.DateTimeFormat('en-IN', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(d);
  } catch (_) {
    return String(isoString);
  }
}

module.exports = {
  CircuitBreaker,
  fetchWithBackoff,
  AsyncJobQueue,
  toUtcIso,
  formatRestaurantDate,
};
