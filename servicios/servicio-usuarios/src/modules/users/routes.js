'use strict';
// Módulo Users: CRUD de usuarios (admin). Auto-crea/asocia partner para rol 'partner'
// y sincroniza con Stripe. La eliminación maneja FKs (refresh_tokens + system_events).
const express = require('express');
const bcrypt = require('bcrypt');
const { body, param } = require('express-validator');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate, requireRole } = require('../../lib/auth');
const { apiLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { logSystemEvent, logSecurityEvent } = require('../../lib/audit');
const { normalizeRoleName } = require('../../lib/rbac');
const { getDefaultPricingProfileId } = require('../pricing/service');
const { syncUserWithStripe } = require('../../integrations/stripe');

router.post('/admin/users',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('password')
    .isLength({ min: 8 }).withMessage('Contraseña debe tener al menos 8 caracteres')
    .matches(/[A-Z]/).withMessage('Contraseña debe contener al menos una mayúscula')
    .matches(/[a-z]/).withMessage('Contraseña debe contener al menos una minúscula')
    .matches(/[0-9]/).withMessage('Contraseña debe contener al menos un número')
    .matches(/[!@#$%^&*]/).withMessage('Contraseña debe contener al menos un caracter especial (!@#$%^&*)'),
  body('role').trim().isLength({ min: 2, max: 50 }).withMessage('Rol inválido'),
  body('partner_id').optional().isInt().withMessage('Partner ID debe ser un número'),
  body('first_name').optional().trim().isLength({ max: 100 }).withMessage('Nombre debe tener máximo 100 caracteres'),
  body('last_name').optional().trim().isLength({ max: 100 }).withMessage('Apellido debe tener máximo 100 caracteres'),
  handleValidationErrors,
  async (req,res)=>{
  const email = req.body.email;
  const password = req.body.password;
  const role = normalizeRoleName(req.body.role);
  const { partner_id, first_name, last_name, password_expires_days } = req.body;
  try{
        const roleExists = await pool.query('SELECT name FROM roles WHERE name=$1 AND active=TRUE', [role]);
        if (roleExists.rowCount === 0) {
          return res.status(400).json({ error: 'Rol inválido o desactivado' });
        }

    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email=$1',[email]);
    if(existing.rowCount > 0) {
      await logSystemEvent('USER_CREATE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, { email, role }, 'FAILED', 'Email ya registrado', req);
      return res.status(400).json({error:'Email ya registrado'});
    }

    let resolvedPartnerId = partner_id;

    if (resolvedPartnerId !== undefined && resolvedPartnerId !== null) {
      const partnerExists = await pool.query('SELECT id FROM partners WHERE id=$1', [resolvedPartnerId]);
      if (partnerExists.rowCount === 0) {
        await logSystemEvent('USER_CREATE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, { email, role, partner_id: resolvedPartnerId }, 'FAILED', 'Partner no encontrado', req);
        return res.status(400).json({ error: 'Partner no encontrado' });
      }
    }

    if (role === 'partner' && (resolvedPartnerId === undefined || resolvedPartnerId === null || resolvedPartnerId === '')) {
      const existingPartnerByEmail = await pool.query('SELECT id FROM partners WHERE LOWER(email)=LOWER($1) LIMIT 1', [email]);
      if (existingPartnerByEmail.rowCount > 0) {
        resolvedPartnerId = existingPartnerByEmail.rows[0].id;
      } else {
        const defaultPricingProfileId = await getDefaultPricingProfileId();
        const partnerName = [first_name, last_name].filter(Boolean).join(' ').trim() || email.split('@')[0];
        const createdPartner = await pool.query(
          'INSERT INTO partners (name,email,pricing_profile_id) VALUES ($1,$2,$3) RETURNING id',
          [partnerName, email, defaultPricingProfileId]
        );
        resolvedPartnerId = createdPartner.rows[0].id;
      }
    }

    const hash = await bcrypt.hash(password, 10);
    // Siempre forzar cambio en primer inicio para usuarios nuevos
    const mustChangePassword = true;

    // Calcular password_expires_at: usar días del request, o bien la política global
    let expiryDays = parseInt(password_expires_days) || 0;
    if (expiryDays === 0) {
      const policyR = await pool.query("SELECT value FROM system_settings WHERE key='password_expiry_days'");
      expiryDays = policyR.rows.length ? parseInt(policyR.rows[0].value) || 0 : 0;
    }

    const r = await pool.query(
      `INSERT INTO users (email,password,role,partner_id,first_name,last_name,must_change_password,password_expires_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8>0 THEN NOW() + ($8 * INTERVAL '1 day') ELSE NULL END, NOW())
       RETURNING id,email,role,partner_id,first_name,last_name,must_change_password,password_expires_at`,
      [email, hash, role, resolvedPartnerId || null, first_name||null, last_name||null, mustChangePassword, expiryDays]
    );
    const userId = r.rows[0].id;

    if (role === 'partner') {
      // Solo usuarios partner se sincronizan con Stripe.
      try {
        const displayName = [first_name, last_name].filter(Boolean).join(' ') || email.split('@')[0];
        const stripeCustomerId = await syncUserWithStripe(email, displayName, userId);
        await logSystemEvent('USER_CREATED', 'USER_MANAGEMENT', userId, stripeCustomerId, null, { email, role, partnerId: resolvedPartnerId || null }, 'SUCCESS', null, req);

        // Return user with stripe customer id
        const userWithStripe = await pool.query('SELECT id, email, role, partner_id, stripe_customer_id FROM users WHERE id=$1', [userId]);
        res.json(userWithStripe.rows[0]);
      } catch (stripeError) {
        console.error('⚠️ Advertencia: Usuario partner creado pero sincronización con Stripe falló:', stripeError.message);
        await logSystemEvent('USER_CREATED_STRIPE_SYNC_FAILED', 'USER_MANAGEMENT', userId, null, null, { email, role, error: stripeError.message }, 'PARTIAL_SUCCESS', stripeError.message, req);

        // Return user anyway (Stripe sync is not critical)
        const userWithoutStripe = await pool.query('SELECT id, email, role, partner_id, stripe_customer_id FROM users WHERE id=$1', [userId]);
        res.json(userWithoutStripe.rows[0]);
      }
    } else {
      await logSystemEvent('USER_CREATED', 'USER_MANAGEMENT', userId, null, null, { email, role, partnerId: resolvedPartnerId || null }, 'SUCCESS', null, req);
      const userCreated = await pool.query('SELECT id, email, role, partner_id, stripe_customer_id FROM users WHERE id=$1', [userId]);
      res.json(userCreated.rows[0]);
    }

    logSecurityEvent('USER_CREATED', { userId, email, role, adminId: req.user.sub });
  }catch(e){
    await logSystemEvent('USER_CREATE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, { email, role }, 'FAILED', e.message, req);
    logSecurityEvent('USER_CREATE_ERROR', { error: e.message, adminId: req.user.sub });
    res.status(400).json({error:'Error al crear usuario'});
  }
});

// List all users (admin)
router.get('/admin/users', authenticate, requireRole('admin'), apiLimiter, async (req,res)=>{
  try{
    const r = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.partner_id, u.stripe_customer_id,
              u.must_change_password, u.first_login_at, u.created_at,
              u.password_expires_at, COALESCE(u.active, TRUE) AS active,
              COALESCE(r.permissions, '{}'::jsonb) AS role_permissions,
              p.name AS partner_name,
              base.name AS pricing_profile_name,
              base.code AS pricing_profile_code,
              special.name AS special_pricing_profile_name,
              special.code AS special_pricing_profile_code
       FROM users u
       LEFT JOIN roles r ON r.name = u.role
       LEFT JOIN partners p ON p.id = u.partner_id
       LEFT JOIN pricing_profiles base ON base.id = p.pricing_profile_id
       LEFT JOIN pricing_profiles special ON special.id = p.special_pricing_profile_id
       ORDER BY u.created_at DESC`
    );
    res.json(r.rows);
  }catch(e){ console.error('GET /admin/users error:', e); res.status(400).json({error:'Error al obtener usuarios'}); }
});

// Get specific user (admin)
router.get('/admin/users/:id', authenticate, requireRole('admin'), apiLimiter,
  param('id').isInt().withMessage('User ID inválido'),
  handleValidationErrors,
  async (req,res)=>{
  try{
    const r = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.partner_id, u.stripe_customer_id, u.must_change_password, u.first_login_at, u.created_at,
              COALESCE(rol.permissions, '{}'::jsonb) AS role_permissions,
              p.name AS partner_name,
              base.name AS pricing_profile_name,
              base.code AS pricing_profile_code,
              special.name AS special_pricing_profile_name,
              special.code AS special_pricing_profile_code
       FROM users u
       LEFT JOIN roles rol ON rol.name = u.role
       LEFT JOIN partners p ON p.id = u.partner_id
       LEFT JOIN pricing_profiles base ON base.id = p.pricing_profile_id
       LEFT JOIN pricing_profiles special ON special.id = p.special_pricing_profile_id
       WHERE u.id=$1`,
      [req.params.id]
    );
    if(r.rowCount === 0) return res.status(404).json({error:'Usuario no encontrado'});
    res.json(r.rows[0]);
  }catch(e){ res.status(400).json({error:'Error al obtener usuario'}); }
});

// Update user (admin) - can change password, role, partner_id, first_name, last_name, expiry
router.put('/admin/users/:id', authenticate, requireRole('admin'), async (req,res)=>{
  const userId = req.params.id;
  const { password, partner_id, first_name, last_name, active, must_change_password, password_expires_days } = req.body;
  const role = req.body.role !== undefined ? normalizeRoleName(req.body.role) : '';
  try{
    const currentUserQ = await pool.query('SELECT id, role, partner_id, email, first_name, last_name FROM users WHERE id=$1', [userId]);
    if(currentUserQ.rowCount === 0) return res.status(404).json({error:'User not found'});

    const currentUser = currentUserQ.rows[0];
    const nextRole = role || currentUser.role;
    let nextPartnerId = partner_id !== undefined ? (partner_id || null) : currentUser.partner_id;

    if (role) {
      const roleExists = await pool.query('SELECT name FROM roles WHERE name=$1 AND active=TRUE', [role]);
      if (roleExists.rowCount === 0) return res.status(400).json({ error: 'Rol inválido o desactivado' });
    }

    if (nextRole === 'partner' && !nextPartnerId) {
      // Auto-crear registro de partner si no existe
      const userEmail = currentUser.email;
      const existingByEmail = await pool.query('SELECT id FROM partners WHERE email=$1 LIMIT 1', [userEmail]);
      if(existingByEmail.rowCount > 0){
        nextPartnerId = existingByEmail.rows[0].id;
      } else {
        const partnerName = [first_name || currentUser.first_name, last_name || currentUser.last_name].filter(Boolean).join(' ').trim() || userEmail.split('@')[0];
        const defaultPricingProfileId = await getDefaultPricingProfileId();
        const newPartner = await pool.query(
          'INSERT INTO partners (name, email, pricing_profile_id) VALUES ($1, $2, $3) RETURNING id',
          [partnerName, userEmail, defaultPricingProfileId]
        );
        nextPartnerId = newPartner.rows[0].id;
      }
    }

    if(partner_id !== undefined && partner_id !== null){
      const partnerExists = await pool.query('SELECT id FROM partners WHERE id=$1', [partner_id]);
      if(partnerExists.rowCount === 0) return res.status(400).json({error:'Partner no encontrado'});
    }

    let query = 'UPDATE users SET ';
    let updates = [];
    let params = [];
    let paramNum = 1;

    if(password){
      const hash = await bcrypt.hash(password, 10);
      updates.push(`password = $${paramNum}`);
      params.push(hash);
      paramNum++;
    }
    if(role){
      updates.push(`role = $${paramNum}`);
      params.push(role);
      paramNum++;
    }
    if(partner_id !== undefined || nextPartnerId !== currentUser.partner_id){
      updates.push(`partner_id = $${paramNum}`);
      params.push(nextPartnerId || null);
      paramNum++;
    }
    if(first_name !== undefined){
      updates.push(`first_name = $${paramNum}`);
      params.push(first_name ? first_name.trim() : null);
      paramNum++;
    }
    if(last_name !== undefined){
      updates.push(`last_name = $${paramNum}`);
      params.push(last_name ? last_name.trim() : null);
      paramNum++;
    }
    if(active !== undefined){
      const nextActive = active === true || active === 'true';
      // Protección: no desactivar si es el único admin activo
      if (!nextActive && currentUser.role === 'admin') {
        const activeAdmins = await pool.query(
          "SELECT COUNT(*) FROM users WHERE role='admin' AND active=TRUE AND id != $1", [userId]
        );
        if (parseInt(activeAdmins.rows[0].count, 10) === 0) {
          return res.status(400).json({ error: 'No puedes desactivar al único administrador activo del sistema.' });
        }
      }
      updates.push(`active = $${paramNum}`);
      params.push(nextActive);
      paramNum++;
    }
    if(must_change_password !== undefined){
      updates.push(`must_change_password = $${paramNum}`);
      params.push(must_change_password === true || must_change_password === 'true');
      paramNum++;
    }
    if(password_expires_days !== undefined){
      const days = parseInt(password_expires_days) || 0;
      if(days > 0){
        updates.push(`password_expires_at = NOW() + ($${paramNum} * INTERVAL '1 day')`);
        params.push(days);
      } else {
        updates.push(`password_expires_at = NULL`);
      }
      paramNum++;
    }

    if(updates.length === 0) return res.status(400).json({error:'No fields to update'});

    query += updates.join(', ') + `, updated_at=NOW() WHERE id = $${paramNum} RETURNING id,email,role,partner_id,first_name,last_name`;
    params.push(userId);

    const r = await pool.query(query, params);
    if(r.rowCount === 0) return res.status(404).json({error:'User not found'});
    await logSystemEvent('USER_UPDATED', 'USER_MANAGEMENT', req.user.sub, null, null, {
      updated_user_id: parseInt(userId, 10),
      changed_fields: Object.keys(req.body || {})
    }, 'SUCCESS', null, req);
    res.json(r.rows[0]);
  }catch(e){
    await logSystemEvent('USER_UPDATE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, {
      updated_user_id: parseInt(userId, 10)
    }, 'FAILED', e.message, req);
    res.status(400).json({error:e.message});
  }
});

// Delete user (admin) - also delete refresh tokens + system_events (FK)
router.delete('/admin/users/:id', authenticate, requireRole('admin'), async (req,res)=>{
  const userId = req.params.id;
  const client = await pool.connect();
  try{
    console.log('Deleting user:', userId);

    // Protección: no eliminar si es el único admin activo
    const targetUser = await client.query('SELECT role, active FROM users WHERE id=$1', [userId]);
    if (targetUser.rowCount > 0 && targetUser.rows[0].role === 'admin') {
      const activeAdmins = await client.query(
        "SELECT COUNT(*) FROM users WHERE role='admin' AND active=TRUE"
      );
      if (parseInt(activeAdmins.rows[0].count, 10) <= 1) {
        client.release();
        return res.status(400).json({ error: 'No puedes eliminar al único administrador activo del sistema.' });
      }
    }

    // Start transaction
    await client.query('BEGIN');

    // First delete all refresh tokens for this user
    const delTokens = await client.query('DELETE FROM refresh_tokens WHERE user_id=$1',[userId]);
    console.log('Deleted refresh tokens:', delTokens.rowCount);

    // Delete system_events for this user (FK constraint)
    const delEvents = await client.query('DELETE FROM system_events WHERE user_id=$1',[userId]);
    console.log('Deleted system events:', delEvents.rowCount);

    // Then delete the user
    const r = await client.query('DELETE FROM users WHERE id=$1 RETURNING id,email,role',[userId]);
    console.log('Delete result rows:', r.rowCount);

    if(r.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({error:'User not found'});
    }

    // Commit transaction
    await client.query('COMMIT');
    await logSystemEvent('USER_DELETED', 'USER_MANAGEMENT', req.user.sub, null, null, {
      deleted_user_id: parseInt(userId, 10),
      deleted_user_email: r.rows[0].email,
      deleted_user_role: r.rows[0].role
    }, 'SUCCESS', null, req);
    res.json({ok:true,user:r.rows[0]});
  }catch(e){
    try { await client.query('ROLLBACK'); } catch(rollbackErr) {}
    await logSystemEvent('USER_DELETE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, {
      deleted_user_id: parseInt(userId, 10)
    }, 'FAILED', e.message, req);
    console.error('Delete error:', e);
    res.status(400).json({error:e.message});
  }finally{
    client.release();
  }
});

module.exports = router;
