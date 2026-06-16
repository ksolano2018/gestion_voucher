'use strict';
// Helpers y constantes de RBAC (roles y permisos), compartidos por los módulos
// roles y users. Único lugar donde se declaran los módulos de permisos.
const pool = require('../db/pool');

const ROLE_TYPES = ['system_role', 'client_role'];
const ROLE_TYPE_LABELS = { system_role: 'Sistema', client_role: 'Cliente' };

// Cada módulo declara qué tipos de rol pueden tener un permiso distinto de 'none'.
// Agregar nuevos módulos aquí — no hace falta tocar nada más.
const ROLE_PERMISSION_MODULES = [
  { key: 'dashboard',     label: 'Dashboard',          types: ['system_role', 'client_role'] },
  { key: 'purchases',     label: 'Compras',            types: ['system_role', 'client_role'] },
  { key: 'users',         label: 'Usuarios',           types: ['system_role'] },
  { key: 'courses',       label: 'Certificaciones',    types: ['system_role', 'client_role'] },
  { key: 'pricing',       label: 'Pricing',            types: ['system_role'] },
  { key: 'stats',         label: 'Estadísticas',       types: ['system_role', 'client_role'] },
  { key: 'audit',         label: 'Auditoría',          types: ['system_role'] },
  { key: 'reports',       label: 'Reportería',         types: ['system_role'] },
  { key: 'financial_ops', label: 'Ops Financieras',    types: ['system_role'] },
];
const ROLE_PERMISSION_LEVELS = ['none', 'view', 'edit'];

function buildRolePermissionsDefault(level = 'none') {
  return ROLE_PERMISSION_MODULES.reduce((acc, mod) => {
    acc[mod.key] = level;
    return acc;
  }, {});
}

function getDefaultPermissionsForRole(roleName) {
  if (roleName === 'admin') return buildRolePermissionsDefault('edit');
  return buildRolePermissionsDefault('none');
}

// roleType controla qué módulos pueden tener valores distintos de 'none'.
function sanitizeRolePermissions(permissions, roleType = 'system_role') {
  const source = permissions && typeof permissions === 'object' && !Array.isArray(permissions) ? permissions : {};
  const sanitized = {};
  for (const mod of ROLE_PERMISSION_MODULES) {
    const value = source[mod.key] || 'none';
    const allowed = mod.types.includes(roleType);
    sanitized[mod.key] = (allowed && ROLE_PERMISSION_LEVELS.includes(value)) ? value : 'none';
  }
  return sanitized;
}

function normalizeRoleName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function getPermissionsByRole(roleName) {
  const result = await pool.query('SELECT permissions FROM roles WHERE name=$1 AND active=TRUE', [roleName]);
  if (result.rowCount === 0) return {};
  return result.rows[0].permissions || {};
}

module.exports = {
  ROLE_TYPES, ROLE_TYPE_LABELS, ROLE_PERMISSION_MODULES, ROLE_PERMISSION_LEVELS,
  buildRolePermissionsDefault, getDefaultPermissionsForRole, sanitizeRolePermissions,
  normalizeRoleName, getPermissionsByRole,
};
