/**
 * Centralized Error Handling & Security Sanitization
 * Formats errors according to RFC 7807 (Problem Details for HTTP APIs)
 * Strips internal stack traces in production to prevent information disclosure.
 */

// Escape HTML entities to prevent XSS attacks
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .trim()
    // Only angle brackets are neutralised: clients render text safely (React/Flutter), and
    // escaping & ' " / would corrupt names like "Chai & Co", URLs and base64 menu photos.
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Deep sanitize request body / query parameters
function sanitizeInput(obj) {
  if (!obj || typeof obj !== 'object') {
    return typeof obj === 'string' ? sanitizeString(obj) : obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeInput);
  }

  const sanitized = {};
  for (const [key, val] of Object.entries(obj)) {
    // Block prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    sanitized[key] = sanitizeInput(val);
  }
  return sanitized;
}

// Sanitize middleware
function sanitizeMiddleware(req, res, next) {
  if (req.body) req.body = sanitizeInput(req.body);
  if (req.query) req.query = sanitizeInput(req.query);
  if (req.params) req.params = sanitizeInput(req.params);
  next();
}

// 404 Route Not Found Handler
function notFoundHandler(req, res, next) {
  res.status(404).json({
    type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404',
    title: 'Resource Not Found',
    status: 404,
    detail: `Cannot ${req.method} ${req.originalUrl}`,
    instance: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
}

// Global Exception Handler
function globalErrorHandler(err, req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';
  const statusCode = err.status || err.statusCode || 500;

  // Log error with correlation ID for server diagnostics
  const errorRef = `err_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  console.error(`[Error ${errorRef}] ${req.method} ${req.originalUrl}:`, err.message);
  if (!isProduction && err.stack) {
    console.error(err.stack);
  }

  // Safe client response (no raw stack traces in production)
  return res.status(statusCode).json({
    type: `https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${statusCode}`,
    title: err.title || (statusCode === 500 ? 'Internal Server Error' : 'Request Error'),
    status: statusCode,
    detail: err.message || 'An unexpected error occurred while processing your request.',
    errorReference: errorRef,
    timestamp: new Date().toISOString(),
    ...(isProduction ? {} : { stack: err.stack }),
  });
}

module.exports = {
  sanitizeString,
  sanitizeInput,
  sanitizeMiddleware,
  notFoundHandler,
  globalErrorHandler,
};

