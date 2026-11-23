/**
 * Idempotency Key Middleware
 * Prevents race conditions, double-billing, and duplicate order submission
 * when users double-tap, network retries, or spams concurrent clicks.
 */

// In-memory idempotency cache with TTL (Can be swapped with Redis for multi-region clustering)
const idempotencyStore = new Map();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours

// Periodic cleanup of expired keys every hour to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of idempotencyStore.entries()) {
    if (now - record.timestamp > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
    }
  }
}, 60 * 60 * 1000).unref();

function idempotency(options = {}) {
  const required = options.required || false;

  return (req, res, next) => {
    // Check standard header
    const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      if (required) {
        return res.status(400).json({
          status: 400,
          error: 'Bad Request',
          message: 'Missing required header: Idempotency-Key',
        });
      }
      return next();
    }

    // Sanitize key
    const sanitizedKey = String(idempotencyKey).trim().substring(0, 128);

    // If key exists and is processed, return cached response directly
    if (idempotencyStore.has(sanitizedKey)) {
      const record = idempotencyStore.get(sanitizedKey);

      if (record.status === 'in_flight') {
        // Concurrency lock: another identical request is currently processing!
        return res.status(409).json({
          status: 409,
          error: 'Conflict',
          message: 'A concurrent request with the same Idempotency-Key is currently being processed. Please wait.',
        });
      }

      // Return stored response with cached header
      res.setHeader('Idempotent-Replayed', 'true');
      res.setHeader('X-Cache-Lookup', 'HIT');
      return res.status(record.statusCode).json(record.body);
    }

    // Mark as in-flight
    idempotencyStore.set(sanitizedKey, {
      status: 'in_flight',
      timestamp: Date.now(),
    });

    // Intercept res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 500) {
        // Do not cache server errors; allow user to retry
        idempotencyStore.delete(sanitizedKey);
      } else {
        idempotencyStore.set(sanitizedKey, {
          status: 'completed',
          statusCode: res.statusCode,
          body,
          timestamp: Date.now(),
        });
      }
      return originalJson(body);
    };

    // If client disconnects or connection closes before response, release lock
    res.on('close', () => {
      const record = idempotencyStore.get(sanitizedKey);
      if (record && record.status === 'in_flight') {
        idempotencyStore.delete(sanitizedKey);
      }
    });

    next();
  };
}

module.exports = {
  idempotency,
  idempotencyStore,
};

