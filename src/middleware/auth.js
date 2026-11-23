const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'qr_menu_super_secure_stateless_secret_key_2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Standard Role Definitions & Permission Matrix
 * Supports Owner, Manager, Clerk, Teacher, Kitchen, and Waiter tiers
 */
const ROLE_PERMISSIONS = {
  owner: [
    'create_order',
    'view_billing',
    'delete_user',
    'manage_menu',
    'manage_staff',
    'view_menu',
    'admin_access',
    // Granular legacy mappings
    'menu:create',
    'menu:update',
    'menu:delete',
    'order:create',
    'order:read',
    'order:update',
    'billing:manage',
    'analytics:view',
    'staff:manage',
  ],
  manager: [
    'create_order',
    'view_billing',
    'manage_menu',
    'view_menu',
    'menu:create',
    'menu:update',
    'order:create',
    'order:read',
    'order:update',
    'analytics:view',
  ],
  clerk: [
    'create_order',
    'view_billing',
    'view_menu',
    'order:create',
    'order:read',
  ],
  teacher: [
    'create_order',
    'view_menu',
    'order:create',
    'order:read',
  ],
  kitchen: [
    'order:read',
    'order:update', // Start cooking, mark served
  ],
  waiter: [
    'create_order',
    'view_menu',
    'order:create', // Punch order
    'order:read',
  ],
};

/**
 * Generates stateless JWT token
 */
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Stateless Authentication Middleware
 * Every request carries Bearer token; zero in-memory session pinning.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({
      status: 401,
      error: 'Unauthorized',
      message: 'Access token is missing or malformed. Format: Bearer <token>',
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
    if (err) {
      return res.status(403).json({
        status: 403,
        error: 'Forbidden',
        message: 'Invalid or expired authentication token. Please sign in again.',
      });
    }

    req.user = decodedUser;
    next();
  });
}

/**
 * RBAC Permission Validator
 */
function requirePermission(requiredPermission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ status: 401, error: 'Unauthorized', message: 'User not authenticated' });
    }

    const userRole = req.user.role || 'waiter';
    const permissions = ROLE_PERMISSIONS[userRole] || [];

    if (!permissions.includes(requiredPermission)) {
      return res.status(403).json({
        status: 403,
        error: 'Forbidden',
        message: `Your role (${userRole}) lacks the required permission: ${requiredPermission}`,
      });
    }

    next();
  };
}

/**
 * RBAC Role Validator
 */
function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ status: 401, error: 'Unauthorized', message: 'User not authenticated' });
    }

    const userRole = req.user.role || 'waiter';

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        status: 403,
        error: 'Forbidden',
        message: `Access denied. Allowed roles: ${allowedRoles.join(', ')}`,
      });
    }

    next();
  };
}

module.exports = {
  JWT_SECRET,
  ROLE_PERMISSIONS,
  generateToken,
  authenticateToken,
  requirePermission,
  requireRole,
};

