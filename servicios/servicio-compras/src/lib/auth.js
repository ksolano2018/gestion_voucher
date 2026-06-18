'use strict';
// Middlewares de autenticación y autorización (JWT + roles + permisos RBAC).
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { logSecurityEvent } = require('./audit');

// Verifica el Bearer token y adjunta req.user.
function authenticate(req, res, next) {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) {
    logSecurityEvent('AUTH_MISSING_TOKEN', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'missing_token' });
  }
  const token = h.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    logSecurityEvent('AUTH_INVALID_TOKEN', { error: e.message, ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'invalid_token', message: e.message });
  }
}

// Exige uno de los roles indicados (admin pasa siempre).
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      logSecurityEvent('AUTHZ_MISSING_USER', { ip: req.ip, path: req.path });
      return res.status(401).json({ error: 'missing_token' });
    }
    if (req.user.role === 'admin') return next();
    if (!allowedRoles.includes(req.user.role)) {
      logSecurityEvent('AUTHZ_FORBIDDEN', { userId: req.user.sub, role: req.user.role, requiredRoles: allowedRoles, ip: req.ip, path: req.path });
      return res.status(403).json({ error: 'forbidden', message: 'No tienes permisos para acceder a este recurso' });
    }
    next();
  };
}

// Exige al menos `level` (none < view < edit) en `module`.
function requirePermission(module, level) {
  const LEVELS = { none: 0, view: 1, edit: 2 };
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'missing_token' });
    if (req.user.role === 'admin') return next();
    try {
      const roleRow = await pool.query('SELECT permissions FROM roles WHERE name=$1', [req.user.role]);
      const perms     = roleRow.rows[0]?.permissions || {};
      const userLevel = LEVELS[perms[module] || 'none'] ?? 0;
      if (userLevel >= LEVELS[level]) return next();
      logSecurityEvent('AUTHZ_PERMISSION_DENIED', {
        userId: req.user.sub, role: req.user.role, module, requiredLevel: level, ip: req.ip, path: req.path
      });
      return res.status(403).json({ error: 'forbidden', module, required: level });
    } catch (e) {
      return res.status(500).json({ error: 'Error validando permisos' });
    }
  };
}

// Igual que requirePermission pero pasa si tiene el nivel en CUALQUIERA de los módulos.
function requireAnyPermission(modules, level) {
  const LEVELS = { none: 0, view: 1, edit: 2 };
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'missing_token' });
    if (req.user.role === 'admin') return next();
    try {
      const roleRow = await pool.query('SELECT permissions FROM roles WHERE name=$1', [req.user.role]);
      const perms = roleRow.rows[0]?.permissions || {};
      const hasAny = modules.some(mod => (LEVELS[perms[mod] || 'none'] ?? 0) >= LEVELS[level]);
      if (hasAny) return next();
      logSecurityEvent('AUTHZ_PERMISSION_DENIED', {
        userId: req.user.sub, role: req.user.role, modules, requiredLevel: level, ip: req.ip, path: req.path
      });
      return res.status(403).json({ error: 'forbidden', modules, required: level });
    } catch (e) {
      return res.status(500).json({ error: 'Error validando permisos' });
    }
  };
}

module.exports = { authenticate, requireRole, requirePermission, requireAnyPermission };
