'use strict';
// Módulo Roles & Permisos (RBAC): CRUD de roles y asignación de permisos.
const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate, requireRole } = require('../../lib/auth');
const { apiLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { logSystemEvent } = require('../../lib/audit');
const {
  ROLE_TYPES, ROLE_TYPE_LABELS, ROLE_PERMISSION_MODULES, ROLE_PERMISSION_LEVELS,
  getDefaultPermissionsForRole, sanitizeRolePermissions, normalizeRoleName,
} = require('../../lib/rbac');

// Config endpoint — el frontend lo lee para construir la UI de permisos dinámicamente
router.get('/admin/roles/config', authenticate, requireRole('admin'), apiLimiter, (req, res) => {
  res.json({
    types:       ROLE_TYPES,
    type_labels: ROLE_TYPE_LABELS,
    modules:     ROLE_PERMISSION_MODULES,
    levels:      ROLE_PERMISSION_LEVELS
  });
});

router.get('/admin/roles', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, display_name, active, is_system,
              COALESCE(role_type, 'system_role') AS role_type,
              COALESCE(permissions, '{}'::jsonb) AS permissions
       FROM roles
       ORDER BY is_system DESC, name ASC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('❌ Error fetching roles:', e);
    res.status(500).json({ error: 'Error al obtener roles' });
  }
});

router.post('/admin/roles', authenticate, requireRole('admin'), apiLimiter,
  body('name').trim().isLength({ min: 2, max: 50 }).withMessage('Nombre de rol inválido'),
  body('display_name').optional().trim().isLength({ min: 2, max: 100 }).withMessage('Nombre visible inválido'),
  body('role_type').optional().isIn(ROLE_TYPES).withMessage('Tipo de rol inválido'),
  handleValidationErrors,
  async (req, res) => {
    const name      = normalizeRoleName(req.body.name);
    const displayName = (req.body.display_name || name).toString().trim();
    const roleType  = ROLE_TYPES.includes(req.body.role_type) ? req.body.role_type : 'client_role';
    const permissions = sanitizeRolePermissions(req.body.permissions || getDefaultPermissionsForRole(name), roleType);

    if (!name) return res.status(400).json({ error: 'Nombre de rol inválido' });
    try {
      const created = await pool.query(
        `INSERT INTO roles (name, display_name, permissions, active, is_system, role_type, updated_at)
         VALUES ($1, $2, $3::jsonb, TRUE, FALSE, $4, NOW())
         RETURNING name, display_name, active, is_system, role_type, permissions`,
        [name, displayName, JSON.stringify(permissions), roleType]
      );
      await logSystemEvent('ROLE_CREATED', 'ROLE_MANAGEMENT', req.user.sub, null, null, {
        role_name: created.rows[0].name,
        display_name: created.rows[0].display_name,
        role_type: roleType
      }, 'SUCCESS', null, req);
      res.status(201).json(created.rows[0]);
    } catch (e) {
      if (e.code === '23505') {
        await logSystemEvent('ROLE_CREATE_ERROR', 'ROLE_MANAGEMENT', req.user.sub, null, null, { role_name: name }, 'FAILED', 'El rol ya existe', req);
        return res.status(409).json({ error: 'El rol ya existe' });
      }
      await logSystemEvent('ROLE_CREATE_ERROR', 'ROLE_MANAGEMENT', req.user.sub, null, null, { role_name: name }, 'FAILED', e.message, req);
      console.error('❌ Error creating role:', e);
      res.status(500).json({ error: 'Error al crear rol' });
    }
  }
);

router.put('/admin/roles/:name', authenticate, requireRole('admin'), apiLimiter,
  body('display_name').optional().trim().isLength({ min: 1, max: 100 }),
  body('role_type').optional().isIn(ROLE_TYPES).withMessage('Tipo de rol inválido'),
  handleValidationErrors,
  async (req, res) => {
    const roleName = normalizeRoleName(req.params.name);
    if (!roleName) return res.status(400).json({ error: 'Rol inválido' });
    const { display_name, role_type } = req.body;
    if (!display_name && !role_type) return res.status(400).json({ error: 'Nada que actualizar' });
    try {
      const existing = await pool.query('SELECT name, is_system, role_type, permissions FROM roles WHERE name=$1', [roleName]);
      if (existing.rowCount === 0) return res.status(404).json({ error: 'Rol no encontrado' });
      const cur = existing.rows[0];

      // Si cambia role_type, re-sanitize permissions para limpiar módulos prohibidos
      let newPermissions = cur.permissions;
      if (role_type && role_type !== cur.role_type) {
        newPermissions = sanitizeRolePermissions(cur.permissions, role_type);
      }

      const updated = await pool.query(
        `UPDATE roles
         SET display_name = COALESCE($1, display_name),
             role_type    = COALESCE($2, role_type),
             permissions  = $3::jsonb,
             updated_at   = NOW()
         WHERE name = $4
         RETURNING name, display_name, active, is_system, role_type, permissions`,
        [display_name || null, role_type || null, JSON.stringify(newPermissions), roleName]
      );
      await logSystemEvent('ROLE_UPDATED', 'ROLE_MANAGEMENT', req.user.sub, null, null, {
        role_name: roleName, display_name, role_type, permissions_sanitized: !!role_type
      }, 'SUCCESS', null, req);
      res.json({ ok: true, role: updated.rows[0] });
    } catch (e) {
      console.error('❌ Error updating role:', e);
      res.status(500).json({ error: 'Error al actualizar rol' });
    }
  }
);

router.delete('/admin/roles/:name', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const roleName = normalizeRoleName(req.params.name);
  if (!roleName) return res.status(400).json({ error: 'Rol inválido' });

  try {
    const existing = await pool.query('SELECT name FROM roles WHERE name=$1', [roleName]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Rol no encontrado' });
    if (roleName === 'admin') return res.status(400).json({ error: 'No se puede eliminar el rol administrador' });

    const usersWithRole = await pool.query('SELECT COUNT(*) FROM users WHERE role=$1', [roleName]);
    if (parseInt(usersWithRole.rows[0].count, 10) > 0) {
      return res.status(400).json({ error: 'No se puede eliminar el rol porque tiene usuarios asignados' });
    }

    await pool.query('DELETE FROM roles WHERE name=$1', [roleName]);
    await logSystemEvent('ROLE_DELETED', 'ROLES', req.user.sub, null, null, { role_name: roleName }, 'SUCCESS', null, req);
    res.json({ message: `Rol "${roleName}" eliminado correctamente` });
  } catch (e) {
    console.error('Error al eliminar rol:', e.message);
    res.status(500).json({ error: 'Error al eliminar rol' });
  }
});

router.put('/admin/roles/:name/permissions', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const roleName = normalizeRoleName(req.params.name);
  if (!roleName) return res.status(400).json({ error: 'Rol inválido' });

  try {
    // Lee el role_type actual para aplicar las restricciones correctas
    const roleRow = await pool.query('SELECT role_type FROM roles WHERE name=$1', [roleName]);
    if (roleRow.rowCount === 0) return res.status(404).json({ error: 'Rol no encontrado' });
    const roleType = roleRow.rows[0].role_type || 'system_role';

    const permissions = sanitizeRolePermissions(req.body.permissions, roleType);

    const updated = await pool.query(
      `UPDATE roles
       SET permissions=$1::jsonb, updated_at=NOW()
       WHERE name=$2
       RETURNING name, display_name, active, is_system, role_type, permissions`,
      [JSON.stringify(permissions), roleName]
    );
    await logSystemEvent('ROLE_PERMISSIONS_UPDATED', 'ROLE_MANAGEMENT', req.user.sub, null, null, {
      role_name: roleName,
      role_type: roleType,
      permissions
    }, 'SUCCESS', null, req);
    res.json({ ok: true, role: updated.rows[0] });
  } catch (e) {
    await logSystemEvent('ROLE_PERMISSIONS_UPDATE_ERROR', 'ROLE_MANAGEMENT', req.user.sub, null, null, {
      role_name: roleName
    }, 'FAILED', e.message, req);
    console.error('❌ Error updating role permissions:', e);
    res.status(500).json({ error: 'Error al actualizar permisos del rol' });
  }
});

module.exports = router;
