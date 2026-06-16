'use strict';
// Módulo Partners: alta/listado de partners y estadísticas (vouchers/activaciones).
const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate, requireRole } = require('../../lib/auth');
const { apiLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { logSystemEvent, logSecurityEvent } = require('../../lib/audit');
const { getDefaultPricingProfileId } = require('../pricing/service');

// Admin: create partner with validation
router.post('/admin/partners',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nombre debe tener entre 2 y 100 caracteres'),
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  handleValidationErrors,
  async (req,res)=>{
  const { name, email } = req.body;
  try{
    // Check if email already exists
    const existing = await pool.query('SELECT id FROM partners WHERE email=$1',[email]);
    if(existing.rowCount > 0) {
      await logSystemEvent('PARTNER_CREATE_ERROR', 'PARTNER_MANAGEMENT', req.user.sub, null, null, { email, reason: 'email_exists' }, 'FAILED', 'Email ya registrado', req);
      return res.status(400).json({error:'Email ya registrado'});
    }
    const defaultProfileId = await getDefaultPricingProfileId();
    const r = await pool.query(
      'INSERT INTO partners (name,email,pricing_profile_id) VALUES ($1,$2,$3) RETURNING *',
      [name, email, defaultProfileId]
    );
    await logSystemEvent('PARTNER_CREATED', 'PARTNER_MANAGEMENT', req.user.sub, null, null, {
      partner_id: r.rows[0].id,
      partner_name: r.rows[0].name,
      partner_email: r.rows[0].email
    }, 'SUCCESS', null, req);
    logSecurityEvent('PARTNER_CREATED', { partnerId: r.rows[0].id, email, adminId: req.user.sub });
    res.json(r.rows[0]);
  }catch(e){
    await logSystemEvent('PARTNER_CREATE_ERROR', 'PARTNER_MANAGEMENT', req.user.sub, null, null, { name, email }, 'FAILED', e.message, req);
    logSecurityEvent('PARTNER_CREATE_ERROR', { error: e.message, adminId: req.user.sub });
    res.status(400).json({error:'Error al crear partner'});
  }
});

// Admin: list partners
router.get('/admin/partners', authenticate, requireRole('admin'), apiLimiter, async (req,res)=>{
  try{
    console.log('📋 GET /admin/partners - Query params:', req.query);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const countResult = await pool.query('SELECT COUNT(*) FROM partners');
    const totalCount = parseInt(countResult.rows[0].count);

    const r = await pool.query(
      `SELECT p.id, p.name, p.email, p.created_at,
              p.pricing_profile_id, p.special_pricing_profile_id,
              base.name AS pricing_profile_name, base.code AS pricing_profile_code,
              special.name AS special_pricing_profile_name, special.code AS special_pricing_profile_code
       FROM partners p
       LEFT JOIN pricing_profiles base ON base.id = p.pricing_profile_id
       LEFT JOIN pricing_profiles special ON special.id = p.special_pricing_profile_id
       ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      data: r.rows,
      pagination: {
        page,
        limit,
        total: totalCount,
        pages: Math.ceil(totalCount / limit)
      }
    });
  }catch(e){
    console.error('❌ Error getting partners:', e);
    res.status(400).json({error:'Error al obtener partners'});
  }
});

// Partner: stats/statistics
router.get('/partner/:id/stats', authenticate, async (req,res)=>{
  const pid = req.params.id;
  try{
    const r = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS total,
        COUNT(*) FILTER (WHERE v.status='CONSUMED')::int                       AS used,
        COUNT(*) FILTER (WHERE v.status='AVAILABLE')::int                      AS available,
        COUNT(*) FILTER (WHERE v.voucher_type='COMPLIMENTARY')::int            AS complimentary,
        (SELECT COUNT(*)::int FROM activations a
           INNER JOIN vouchers vv ON vv.id = a.voucher_id
           WHERE vv.partner_id = $1 AND a.moodle_status = 'COMPLETED')        AS completed_courses,
        (SELECT COUNT(DISTINCT a.course_id)::int FROM activations a
           INNER JOIN vouchers vv ON vv.id = a.voucher_id
           WHERE vv.partner_id = $1 AND a.moodle_status = 'COMPLETED')        AS completed_unique_courses
      FROM vouchers v WHERE v.partner_id = $1
    `, [pid]);
    const row = r.rows[0] || {};
    res.json({
      total:                   row.total                   || 0,
      used:                    row.used                    || 0,
      available:               row.available               || 0,
      complimentary:           row.complimentary           || 0,
      completed_courses:       row.completed_courses       || 0,
      completed_unique_courses:row.completed_unique_courses|| 0
    });
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

// Admin: vouchers by partner summary
router.get('/admin/partners/:id/summary', async (req,res)=>{
  const pid = req.params.id;
  const total = await pool.query('SELECT count(*) FROM vouchers WHERE partner_id=$1',[pid]);
  const consumed = await pool.query("SELECT count(*) FROM vouchers WHERE partner_id=$1 AND status='CONSUMED'",[pid]);
  res.json({ total: parseInt(total.rows[0].count), consumed: parseInt(consumed.rows[0].count), available: parseInt(total.rows[0].count)-parseInt(consumed.rows[0].count) });
});

// Admin: partner stats (alias for summary with different response format)
router.get('/admin/partners/:id/stats', authenticate, requireRole('admin'), async (req,res)=>{
  const pid = req.params.id;
  try{
    const r = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS total,
        COUNT(*) FILTER (WHERE v.status='CONSUMED')::int                       AS used,
        COUNT(*) FILTER (WHERE v.status='AVAILABLE')::int                      AS available,
        COUNT(*) FILTER (WHERE v.voucher_type='COMPLIMENTARY')::int            AS complimentary,
        (SELECT COUNT(*)::int FROM activations a
           INNER JOIN vouchers vv ON vv.id = a.voucher_id
           WHERE vv.partner_id = $1 AND a.moodle_status = 'COMPLETED')        AS completed_courses,
        (SELECT COUNT(DISTINCT a.course_id)::int FROM activations a
           INNER JOIN vouchers vv ON vv.id = a.voucher_id
           WHERE vv.partner_id = $1 AND a.moodle_status = 'COMPLETED')        AS completed_unique_courses
      FROM vouchers v WHERE v.partner_id = $1
    `, [pid]);
    const row = r.rows[0] || {};
    res.json({
      total:                   row.total                   || 0,
      used:                    row.used                    || 0,
      available:               row.available               || 0,
      complimentary:           row.complimentary           || 0,
      completed_courses:       row.completed_courses       || 0,
      completed_unique_courses:row.completed_unique_courses|| 0
    });
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

module.exports = router;
