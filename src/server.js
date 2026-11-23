const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const dotenv = require('dotenv');
const path = require('path');
const { Server } = require('socket.io');

dotenv.config({ path: path.join(__dirname, '../.env') });

const { globalLimiter, ipBlockerMiddleware } = require('./middleware/rateLimiter');
const { sanitizeMiddleware, notFoundHandler, globalErrorHandler } = require('./middleware/errorHandler');
const { forceFlushDb } = require('./db');

const app = express();
const server = http.createServer(app);

// Real-Time WebSockets Engine
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 30000,
});

app.set('io', io);
require('./services/realtime').init(io);

const PORT = process.env.PORT || 5007;

// Security & Optimization Middlewares
app.use(ipBlockerMiddleware); // Active IP Quarantine & Abuse Firewall
app.use(helmet({
  crossOriginResourcePolicy: false,
  hidePoweredBy: true,
})); // HTTP security headers, no tech stack leak
app.use(compression()); // Gzip compression to minimize bandwidth & cloud server bills
app.use(cors({
  origin: true, // Echo origin for seamless Next.js admin, website, and Flutter access
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Idempotency-Key', 'If-None-Match'],
  exposedHeaders: ['ETag', 'Idempotent-Replayed', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 86400, // 24h preflight cache saves cloud compute on every API call
}));
app.use(globalLimiter); // Protect against abuse & DDoS
app.use(express.json({ limit: '25mb' })); // Protect against huge payload attacks
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sanitizeMiddleware); // Deep input sanitization

// Serve static compressed webp uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), {
  maxAge: '7d', // 7-day browser caching for compressed images
  immutable: true,
}));

// Routes
const ownerRoutes = require('./routes/owner');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
require('./services/saas').migrateAll();
require('./services/menuScanner').warmup();

app.use('/api/owner', ownerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', publicRoutes);

// Root Service Verification
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'Autonomous QR Digital Menu SaaS Operating System',
    version: '2.0.0',
    status: 'healthy',
    developerCredit: {
      creator: 'Piyush Assudani',
      role: 'Founder',
      company: 'Assudani Developers',
    },
    documentation: '/api/health',
  });
});

// 404 & Centralized Exception Handlers
app.use(notFoundHandler);
app.use(globalErrorHandler);

// Graceful Shutdown Handler (Zero data loss or abrupt connection drops)
function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Flushing pending DB state to disk...`);
  forceFlushDb(); // Atomic flush to disk to guarantee zero data loss
  server.close(() => {
    console.log('[Server] HTTP and WebSocket connections closed cleanly. Exiting.');
    process.exit(0);
  });

  // Force shutdown after 10s if connections fail to close
  setTimeout(() => {
    console.error('[Server] Forced shutdown timeout reached.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (process.env.NODE_ENV !== 'test') {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const fallbackPort = Number(PORT) === 5007 ? 5008 : Number(PORT) + 1;
      console.warn(`\n⚠️  [Server Warning] Port ${PORT} is occupied.`);
      console.log(`🔄 [Server] Auto-binding to fallback port ${fallbackPort}...`);
      server.listen(fallbackPort, '0.0.0.0', () => {
        console.log(`✅ [Server] Autonomous QR Menu Backend running on port ${fallbackPort}`);
        console.log(`🩺 [Server] Health Check available at http://localhost:${fallbackPort}/api/health`);
      });
    } else {
      console.error('[Server Error]', err);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Autonomous QR Menu Backend running on port ${PORT}`);
    console.log(`[Server] Health Check available at http://localhost:${PORT}/api/health`);
  });
}

module.exports = { app, server };
