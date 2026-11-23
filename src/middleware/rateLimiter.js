const rateLimit = require('express-rate-limit');

/**
 * Dynamic IP Quarantine & Security Blocklist
 * Mitigates DDoS, credential stuffing, and abusive API scraping
 */
const blockedIps = new Map(); // ip -> banExpiresAt
const violationTracker = new Map(); // ip -> { count, lastViolation }
const BAN_DURATION_MS = 10 * 60 * 1000; // 10 minutes ban
const MAX_VIOLATIONS_BEFORE_BAN = 6;

// Periodic cleanup of expired bans (prevents memory leaks)
setInterval(() => {
  const now = Date.now();
  for (const [ip, expiry] of blockedIps.entries()) {
    if (now >= expiry) {
      blockedIps.delete(ip);
      violationTracker.delete(ip);
    }
  }
}, 60 * 1000).unref();

function recordViolation(ip) {
  const now = Date.now();
  const record = violationTracker.get(ip) || { count: 0, lastViolation: now };

  if (now - record.lastViolation > 60 * 1000) {
    record.count = 1;
  } else {
    record.count += 1;
  }
  record.lastViolation = now;
  violationTracker.set(ip, record);

  if (record.count >= MAX_VIOLATIONS_BEFORE_BAN) {
    blockedIps.set(ip, now + BAN_DURATION_MS);
    console.warn(`🚨 [Security Firewall] IP ${ip} has been quarantined for 10 minutes due to abusive rate-limit violations.`);
  }
}

const ipBlockerMiddleware = (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const banExpiry = blockedIps.get(clientIp);

  if (banExpiry) {
    const now = Date.now();
    if (now < banExpiry) {
      const remainingSecs = Math.ceil((banExpiry - now) / 1000);
      return res.status(403).json({
        status: 403,
        error: 'Forbidden',
        message: 'Your IP has been quarantined due to excessive abnormal traffic or attack patterns.',
        quarantineRemainingSeconds: remainingSecs,
      });
    } else {
      blockedIps.delete(clientIp);
      violationTracker.delete(clientIp);
    }
  }
  next();
};

const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number(process.env.RATE_LIMIT_MAX) || 120, // requests per minute per IP (tests raise it)
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (req) => req.path === '/api/health' || req.path === '/health',
  handler: (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    recordViolation(clientIp);
    return res.status(429).json({
      status: 429,
      error: 'Too Many Requests',
      message: 'Global rate limit exceeded. Please wait a moment before sending more requests.',
      retryAfterSeconds: 60,
    });
  },
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // max 30 order requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    recordViolation(clientIp);
    return res.status(429).json({
      status: 429,
      error: 'Too Many Requests',
      message: 'Order submission rate limit exceeded. Please wait a few seconds before trying again.',
    });
  },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 image uploads per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    recordViolation(clientIp);
    return res.status(429).json({
      status: 429,
      error: 'Too Many Requests',
      message: 'Image upload limit exceeded. You can only upload up to 10 images per minute.',
    });
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // max 15 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    recordViolation(clientIp);
    return res.status(429).json({
      status: 429,
      error: 'Too Many Requests',
      message: 'Too many authentication attempts. Please try again after 15 minutes.',
    });
  },
});

module.exports = {
  globalLimiter,
  orderLimiter,
  uploadLimiter,
  authLimiter,
  ipBlockerMiddleware,
  blockedIps,
};

