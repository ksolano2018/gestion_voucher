'use strict';
// Módulo Settings: configuración global del sistema (system_settings).
//  - Política de contraseñas (password_expiry_days)
//  - Configuración de activación (max_activation_months): admin escribe, partner lee
const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate, requireRole } = require('../../lib/auth');
const { logSystemEvent } = require('../../lib/audit');

// Política global de contraseñas
router.get('/admin/password-policy', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query("SELECT key, value FROM system_settings WHERE key='password_expiry_days'");
    const expiryDays = r.rows.length ? parseInt(r.rows[0].value) || 0 : 0;
    res.json({ expiry_days: expiryDays });
  } catch(e) { res.status(500).json({ error: 'Error al obtener política de contraseñas' }); }
});

router.put('/admin/password-policy', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const expiryDays = Math.max(0, parseInt(req.body.expiry_days) || 0);
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('password_expiry_days', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [String(expiryDays)]
    );
    await logSystemEvent('PASSWORD_POLICY_UPDATED', 'USER_MANAGEMENT', req.user.sub, null, null,
      { expiry_days: expiryDays }, 'SUCCESS', null, req);
    res.json({ ok: true, expiry_days: expiryDays });
  } catch(e) { res.status(500).json({ error: 'Error al guardar política de contraseñas' }); }
});

// Configuración de activación (partner la lee, admin la escribe)
router.get('/partner/settings', authenticate, requireRole('partner'), async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='max_activation_months'");
    const maxMonths = r.rows.length ? (parseInt(r.rows[0].value) || 12) : 12;
    res.json({ max_activation_months: maxMonths });
  } catch(e) { res.status(500).json({ error: 'Error al obtener configuración' }); }
});

router.get('/admin/settings/activation', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='max_activation_months'");
    const maxMonths = r.rows.length ? (parseInt(r.rows[0].value) || 12) : 12;
    res.json({ max_activation_months: maxMonths });
  } catch(e) { res.status(500).json({ error: 'Error al obtener configuración' }); }
});

router.put('/admin/settings/activation', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const maxMonths = Math.min(120, Math.max(1, parseInt(req.body.max_activation_months) || 12));
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('max_activation_months', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [String(maxMonths)]
    );
    await logSystemEvent('ACTIVATION_SETTINGS_UPDATED', 'USER_MANAGEMENT', req.user.sub, null, null,
      { max_activation_months: maxMonths }, 'SUCCESS', null, req);
    res.json({ ok: true, max_activation_months: maxMonths });
  } catch(e) { res.status(500).json({ error: 'Error al guardar configuración' }); }
});

module.exports = router;
