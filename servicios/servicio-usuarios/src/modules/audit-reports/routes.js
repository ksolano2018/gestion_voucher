'use strict';
// Módulo Audit & Reports (solo lectura): eventos de sistema, auditoría unificada
// de movimientos (system_events + transaction_events + stripe_events + activations + purchases)
// y reportería (KPIs, mensual, top partners/cursos, compras) con export CSV.
const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate, requirePermission, requireAnyPermission } = require('../../lib/auth');
const { apiLimiter } = require('../../lib/rateLimit');

// Helper: convierte filas a CSV.
function convertToCSV(data) {
  if (!data || data.length === 0) return '';

  const headers = Object.keys(data[0]).join(',');
  const rows = data.map(item => {
    return Object.values(item)
      .map(value => {
        if (value === null) return '';
        if (typeof value === 'object') return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
        if (typeof value === 'string') return `"${value.replace(/"/g, '""')}"`;
        return value;
      })
      .join(',');
  });

  return [headers, ...rows].join('\n');
}

function buildAuditMovementsCTE() {
  return `
    WITH movements AS (
      SELECT
        CONCAT('sys-', se.id) AS movement_id,
        'SYSTEM'::varchar AS source,
        se.event_type::varchar AS movement_type,
        se.event_category::varchar AS category,
        COALESCE(se.status, 'UNKNOWN')::varchar AS status,
        se.created_at AS occurred_at,
        se.user_id,
        COALESCE(p.partner_id, u.partner_id) AS partner_id,
        se.purchase_id,
        NULL::varchar AS stripe_event_id,
        NULL::varchar AS payment_intent_id,
        CONCAT('Evento ', se.event_type, ' (', se.event_category, ')')::text AS summary,
        jsonb_build_object(
          'event_data', se.event_data,
          'error_message', se.error_message,
          'ip_address', se.ip_address,
          'user_agent', se.user_agent,
          'stripe_customer_id', se.stripe_customer_id
        ) AS details
      FROM system_events se
      LEFT JOIN purchases p ON p.id = se.purchase_id
      LEFT JOIN users u ON u.id = se.user_id

      UNION ALL

      SELECT
        CONCAT('tx-', te.id) AS movement_id,
        'TRANSACTION'::varchar AS source,
        te.event_type::varchar AS movement_type,
        'PAYMENT'::varchar AS category,
        COALESCE(te.new_status, 'UNKNOWN')::varchar AS status,
        te.created_at AS occurred_at,
        NULL::integer AS user_id,
        te.partner_id,
        te.purchase_id,
        te.stripe_event_id,
        te.payment_intent_id,
        CONCAT('Transacción ', COALESCE(te.previous_status, 'N/A'), ' → ', COALESCE(te.new_status, 'N/A'))::text AS summary,
        jsonb_build_object(
          'previous_status', te.previous_status,
          'new_status', te.new_status,
          'metadata', te.metadata,
          'stripe_event_data', te.stripe_event_data
        ) AS details
      FROM transaction_events te

      UNION ALL

      SELECT
        CONCAT('st-', st.id) AS movement_id,
        'STRIPE'::varchar AS source,
        st.event_type::varchar AS movement_type,
        'WEBHOOK'::varchar AS category,
        (CASE WHEN st.processed THEN 'PROCESSED' ELSE 'PENDING' END)::varchar AS status,
        st.created_at AS occurred_at,
        NULL::integer AS user_id,
        NULL::integer AS partner_id,
        NULL::integer AS purchase_id,
        st.stripe_event_id,
        NULL::varchar AS payment_intent_id,
        CONCAT('Webhook ', st.event_type)::text AS summary,
        jsonb_build_object(
          'processed', st.processed,
          'processed_at', st.processed_at,
          'event_data', st.event_data
        ) AS details
      FROM stripe_events st

      UNION ALL

      SELECT
        CONCAT('ac-', a.id) AS movement_id,
        'ACTIVATION'::varchar AS source,
        'VOUCHER_ACTIVATED'::varchar AS movement_type,
        'VOUCHER'::varchar AS category,
        'SUCCESS'::varchar AS status,
        a.activated_at AS occurred_at,
        NULL::integer AS user_id,
        v.partner_id,
        v.purchase_id,
        NULL::varchar AS stripe_event_id,
        NULL::varchar AS payment_intent_id,
        CONCAT('Voucher activado por ', COALESCE(a.user_email, a.user_name, 'usuario'))::text AS summary,
        jsonb_build_object(
          'voucher_id', a.voucher_id,
          'voucher_code', v.code,
          'course_id', a.course_id,
          'user_name', a.user_name,
          'user_email', a.user_email,
          'final_client', a.final_client
        ) AS details
      FROM activations a
      LEFT JOIN vouchers v ON v.id = a.voucher_id

      UNION ALL

      SELECT
        CONCAT('pu-', p.id) AS movement_id,
        'PURCHASE'::varchar AS source,
        'PURCHASE_CREATED'::varchar AS movement_type,
        'PURCHASE'::varchar AS category,
        COALESCE(p.status, 'PENDING')::varchar AS status,
        p.created_at AS occurred_at,
        NULL::integer AS user_id,
        p.partner_id,
        p.id AS purchase_id,
        NULL::varchar AS stripe_event_id,
        p.payment_intent_id,
        CONCAT('Compra #', p.id, ' creada')::text AS summary,
        jsonb_build_object(
          'qty', p.qty,
          'total_price', p.total_price,
          'stripe_status', p.stripe_status,
          'stripe_session_id', p.stripe_session_id,
          'pricing_details', p.pricing_details
        ) AS details
      FROM purchases p
    )`;
}

function buildAuditFilters(req) {
  const whereParts = [];
  const params = [];

  const addFilter = (condition, value) => {
    params.push(value);
    whereParts.push(condition.replace('?', `$${params.length}`));
  };

  const source = req.query.source ? String(req.query.source).trim().toUpperCase() : '';
  const status = req.query.status ? String(req.query.status).trim().toUpperCase() : '';
  const category = req.query.category ? String(req.query.category).trim().toUpperCase() : '';
  const eventType = req.query.event_type ? String(req.query.event_type).trim().toUpperCase() : '';
  const partnerId = req.query.partner_id ? parseInt(req.query.partner_id, 10) : null;
  const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  const purchaseId = req.query.purchase_id ? parseInt(req.query.purchase_id, 10) : null;
  const search = req.query.search ? String(req.query.search).trim().toLowerCase() : '';
  const startDate = req.query.start_date ? new Date(req.query.start_date) : null;
  const endDate = req.query.end_date ? new Date(req.query.end_date) : null;

  if (source) addFilter('m.source = ?', source);
  if (status) addFilter('UPPER(m.status) = ?', status);
  if (category) addFilter('UPPER(m.category) = ?', category);
  if (eventType) addFilter('UPPER(m.movement_type) = ?', eventType);
  if (Number.isInteger(partnerId)) addFilter('m.partner_id = ?', partnerId);
  if (Number.isInteger(userId)) addFilter('m.user_id = ?', userId);
  if (Number.isInteger(purchaseId)) addFilter('m.purchase_id = ?', purchaseId);
  if (startDate && !Number.isNaN(startDate.getTime())) addFilter('m.occurred_at >= ?', startDate);
  if (endDate && !Number.isNaN(endDate.getTime())) addFilter('m.occurred_at <= ?', endDate);
  if (search) {
    const searchParam = `%${search}%`;
    const base = params.length + 1;
    whereParts.push(`(
      LOWER(COALESCE(m.summary, '')) LIKE $${base} OR
      LOWER(COALESCE(m.movement_type, '')) LIKE $${base + 1} OR
      LOWER(COALESCE(m.category, '')) LIKE $${base + 2} OR
      LOWER(COALESCE(m.status, '')) LIKE $${base + 3} OR
      CAST(COALESCE(m.purchase_id, 0) AS TEXT) LIKE $${base + 4} OR
      CAST(COALESCE(m.partner_id, 0) AS TEXT) LIKE $${base + 5}
    )`);
    params.push(searchParam, searchParam, searchParam, searchParam, searchParam, searchParam);
  }

  return {
    whereClause: whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '',
    params
  };
}

// ── Eventos de sistema ─────────────────────────────────────────────────────────
router.get('/admin/events', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const eventType = req.query.event_type;
    const eventCategory = req.query.event_category;
    const userId = req.query.user_id;
    const status = req.query.status;

    let query = 'SELECT * FROM system_events WHERE 1=1';
    let params = [];
    let paramNum = 1;

    if (eventType) {
      query += ` AND event_type = $${paramNum}`;
      params.push(eventType);
      paramNum++;
    }
    if (eventCategory) {
      query += ` AND event_category = $${paramNum}`;
      params.push(eventCategory);
      paramNum++;
    }
    if (userId) {
      query += ` AND user_id = $${paramNum}`;
      params.push(userId);
      paramNum++;
    }
    if (status) {
      query += ` AND status = $${paramNum}`;
      params.push(status);
      paramNum++;
    }

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM system_events WHERE 1=1 ${eventType ? `AND event_type=$${paramNum - (params.length - 1)}` : ''} ${eventCategory ? `AND event_category=$${paramNum - (params.length - 2)}` : ''} ${userId ? `AND user_id=$${paramNum - (params.length - 3)}` : ''} ${status ? `AND status=$${paramNum - (params.length - 4)}` : ''}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    query += ` ORDER BY created_at DESC LIMIT $${paramNum} OFFSET $${paramNum + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      events: result.rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (e) {
    console.error('❌ Error fetching events:', e);
    res.status(400).json({ error: 'Error al obtener eventos' });
  }
});

router.get('/admin/events/user/:userId', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const userId = req.params.userId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT * FROM system_events
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM system_events WHERE user_id=$1',
      [userId]
    );
    const total = parseInt(countResult.rows[0].count);

    res.json({
      events: result.rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (e) {
    console.error('❌ Error fetching user events:', e);
    res.status(400).json({ error: 'Error al obtener eventos del usuario' });
  }
});

router.get('/admin/events/stats/dashboard', authenticate, requireAnyPermission(['dashboard', 'audit'], 'view'), apiLimiter, async (req, res) => {
  try {
    const totalEvents = await pool.query('SELECT COUNT(*) FROM system_events');
    const successfulEvents = await pool.query(`SELECT COUNT(*) FROM system_events WHERE status='SUCCESS'`);
    const failedEvents = await pool.query(`SELECT COUNT(*) FROM system_events WHERE status='FAILED'`);
    const partialEvents = await pool.query(`SELECT COUNT(*) FROM system_events WHERE status='PARTIAL_SUCCESS'`);

    const eventsByCategory = await pool.query(`
      SELECT event_category, COUNT(*) as count
      FROM system_events
      GROUP BY event_category
      ORDER BY count DESC
    `);

    const eventsByType = await pool.query(`
      SELECT event_type, COUNT(*) as count
      FROM system_events
      GROUP BY event_type
      ORDER BY count DESC
      LIMIT 10
    `);

    const recentEvents = await pool.query(`
      SELECT * FROM system_events
      ORDER BY created_at DESC
      LIMIT 10
    `);

    res.json({
      summary: {
        total: parseInt(totalEvents.rows[0].count),
        successful: parseInt(successfulEvents.rows[0].count),
        failed: parseInt(failedEvents.rows[0].count),
        partial: parseInt(partialEvents.rows[0].count)
      },
      by_category: eventsByCategory.rows,
      by_type: eventsByType.rows,
      recent: recentEvents.rows
    });
  } catch (e) {
    console.error('❌ Error fetching event stats:', e);
    res.status(400).json({ error: 'Error al obtener estadísticas de eventos' });
  }
});

router.get('/admin/events/export/:format', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const format = req.params.format.toLowerCase();
    const eventType = req.query.event_type;
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;

    let query = 'SELECT * FROM system_events WHERE 1=1';
    let params = [];
    let paramNum = 1;

    if (eventType) {
      query += ` AND event_type=$${paramNum++}`;
      params.push(eventType);
    }
    if (startDate) {
      query += ` AND created_at >= $${paramNum++}`;
      params.push(new Date(startDate));
    }
    if (endDate) {
      query += ` AND created_at <= $${paramNum++}`;
      params.push(new Date(endDate));
    }

    query += ' ORDER BY created_at DESC';
    const events = await pool.query(query, params);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=events.json');
      res.json({ events: events.rows, exported_at: new Date().toISOString() });
    } else if (format === 'csv') {
      const csv = convertToCSV(events.rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=events.csv');
      res.send(csv);
    } else {
      res.status(400).json({ error: 'Formato no válido. Use json o csv' });
    }
  } catch (e) {
    console.error('❌ Error exporting events:', e);
    res.status(400).json({ error: 'Error al exportar eventos' });
  }
});

// ── Auditoría unificada de movimientos ─────────────────────────────────────────
router.get('/admin/audit/movements', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const cte = buildAuditMovementsCTE();
    const { whereClause, params } = buildAuditFilters(req);

    const countQuery = `${cte}
      SELECT COUNT(*)::int AS total
      FROM movements m
      ${whereClause}`;

    const countResult = await pool.query(countQuery, params);
    const total = countResult.rows[0] ? parseInt(countResult.rows[0].total, 10) : 0;

    const listParams = [...params, limit, offset];
    const listQuery = `${cte}
      SELECT
        m.movement_id,
        m.source,
        m.movement_type,
        m.category,
        m.status,
        m.occurred_at,
        m.user_id,
        m.partner_id,
        m.purchase_id,
        m.stripe_event_id,
        m.payment_intent_id,
        m.summary,
        m.details
      FROM movements m
      ${whereClause}
      ORDER BY m.occurred_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}`;

    const movementsResult = await pool.query(listQuery, listParams);

    res.json({
      movements: movementsResult.rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (e) {
    console.error('❌ Error fetching unified audit movements:', e);
    res.status(400).json({ error: 'Error al obtener movimientos de auditoría' });
  }
});

router.get('/admin/audit/movements/summary', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const cte = buildAuditMovementsCTE();
    const { whereClause, params } = buildAuditFilters(req);

    const summaryQuery = `${cte}
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE m.occurred_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
        COUNT(*) FILTER (
          WHERE UPPER(COALESCE(m.status, '')) IN ('FAILED', 'ERROR', 'CANCELED', 'CANCELLED')
        )::int AS failed
      FROM movements m
      ${whereClause}`;

    const sourceQuery = `${cte}
      SELECT m.source, COUNT(*)::int AS count
      FROM movements m
      ${whereClause}
      GROUP BY m.source
      ORDER BY count DESC`;

    const [summaryResult, sourceResult] = await Promise.all([
      pool.query(summaryQuery, params),
      pool.query(sourceQuery, params)
    ]);

    const summary = summaryResult.rows[0] || { total: 0, last_24h: 0, failed: 0 };

    res.json({
      summary: {
        total: parseInt(summary.total, 10) || 0,
        last_24h: parseInt(summary.last_24h, 10) || 0,
        failed: parseInt(summary.failed, 10) || 0
      },
      by_source: sourceResult.rows
    });
  } catch (e) {
    console.error('❌ Error fetching audit summary:', e);
    res.status(400).json({ error: 'Error al obtener resumen de auditoría' });
  }
});

router.get('/admin/audit/movements/export/csv', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const cte = buildAuditMovementsCTE();
    const { whereClause, params } = buildAuditFilters(req);

    const query = `${cte}
      SELECT
        m.movement_id,
        m.source,
        m.movement_type,
        m.category,
        m.status,
        m.occurred_at,
        m.user_id,
        m.partner_id,
        m.purchase_id,
        m.stripe_event_id,
        m.payment_intent_id,
        m.summary,
        m.details
      FROM movements m
      ${whereClause}
      ORDER BY m.occurred_at DESC
      LIMIT 10000`;

    const result = await pool.query(query, params);
    const csv = convertToCSV(result.rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=auditoria_movimientos.csv');
    res.send(csv);
  } catch (e) {
    console.error('❌ Error exporting audit movements CSV:', e);
    res.status(400).json({ error: 'Error al exportar auditoría en CSV' });
  }
});

// ── Reportería ─────────────────────────────────────────────────────────────────
router.get('/admin/reports/summary', authenticate, requireAnyPermission(['dashboard', 'stats', 'reports'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date, partner_id } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`p.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (partner_id && /^\d+$/.test(partner_id)) { params.push(parseInt(partner_id, 10)); conditions.push(`p.partner_id = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const purchasesQ = await pool.query(`
      SELECT
        COUNT(*)::int                                                                                           AS total_purchases,
        COALESCE(SUM(p.total_price),0)::numeric                                                                AS total_revenue,
        COALESCE(SUM(p.qty),0)::int                                                                            AS total_vouchers_sold,
        COUNT(*) FILTER (WHERE p.status='COMPLETED')::int                                                      AS completed_purchases,
        COUNT(*) FILTER (WHERE p.status='PENDING')::int                                                        AS pending_purchases,
        COUNT(*) FILTER (WHERE p.status='CANCELLED')::int                                                      AS cancelled_purchases,
        COUNT(*) FILTER (WHERE p.payment_method='complimentary')::int                                          AS complimentary_purchases,
        COALESCE(SUM(p.total_price) FILTER (WHERE p.payment_method != 'complimentary'),0)::numeric             AS paid_revenue,
        COALESCE(SUM(p.total_price) FILTER (WHERE p.payment_method = 'stripe'),0)::numeric                     AS stripe_revenue,
        COALESCE(SUM(p.total_price) FILTER (WHERE p.payment_method NOT IN ('stripe','complimentary')),0)::numeric AS external_revenue
      FROM purchases p ${where}
    `, params);

    const vPartnerFilter = partner_id && /^\d+$/.test(partner_id) ? `WHERE v.partner_id = ${parseInt(partner_id, 10)}` : '';
    const vouchersQ = await pool.query(`
      SELECT
        COUNT(*)::int                                                      AS total_vouchers,
        COUNT(*) FILTER (WHERE v.status='AVAILABLE')::int                  AS available_vouchers,
        COUNT(*) FILTER (WHERE v.status='CONSUMED')::int                   AS consumed_vouchers,
        COUNT(*) FILTER (WHERE v.status='EXPIRED')::int                    AS expired_vouchers,
        COUNT(*) FILTER (WHERE v.voucher_type='COMPLIMENTARY')::int        AS complimentary_vouchers
      FROM vouchers v
      ${vPartnerFilter}
    `);

    const actWhere = [
      start_date ? `a.activated_at >= '${start_date}'`                               : null,
      end_date   ? `a.activated_at <= '${end_date}'::date + INTERVAL '1 day'`        : null,
      partner_id && /^\d+$/.test(partner_id)
                 ? `a.voucher_id IN (SELECT id FROM vouchers WHERE partner_id=${parseInt(partner_id,10)})` : null
    ].filter(Boolean);
    const activationsQ = await pool.query(`
      SELECT
        COUNT(*)::int                                                        AS total_activations,
        COUNT(*) FILTER (WHERE a.moodle_status='COMPLETED')::int            AS completed_courses,
        COUNT(*) FILTER (WHERE a.moodle_status='ENROLLED')::int             AS enrolled_courses,
        COUNT(DISTINCT a.course_id) FILTER (WHERE a.moodle_status='COMPLETED')::int AS completed_unique_courses
      FROM activations a
      ${actWhere.length ? 'WHERE ' + actWhere.join(' AND ') : ''}
    `);

    const partnersQ = await pool.query(`SELECT COUNT(DISTINCT id)::int AS total_partners FROM partners`);

    res.json({
      summary: {
        ...purchasesQ.rows[0],
        ...vouchersQ.rows[0],
        ...activationsQ.rows[0],
        total_partners: partnersQ.rows[0].total_partners
      }
    });
  } catch (e) {
    console.error('❌ Error en reports/summary:', e);
    res.status(500).json({ error: 'Error al obtener resumen de reportería' });
  }
});

router.get('/admin/reports/monthly', authenticate, requireAnyPermission(['dashboard', 'stats', 'reports'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date, partner_id } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    if (partner_id && /^\d+$/.test(partner_id)) { params.push(parseInt(partner_id,10)); conditions.push(`partner_id = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COUNT(*)::int                                         AS purchases,
        COALESCE(SUM(total_price),0)::numeric                 AS revenue,
        COALESCE(SUM(qty),0)::int                             AS vouchers_sold
      FROM purchases ${where}
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
      LIMIT 24
    `, params);

    res.json({ monthly: result.rows });
  } catch (e) {
    console.error('❌ Error en reports/monthly:', e);
    res.status(500).json({ error: 'Error al obtener datos mensuales' });
  }
});

router.get('/admin/reports/top-partners', authenticate, requireAnyPermission(['dashboard', 'stats', 'reports'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`p.created_at <= $${params.length}::date + INTERVAL '1 day'`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        pt.id                                  AS partner_id,
        pt.name AS partner_name,
        COUNT(p.id)::int                       AS total_purchases,
        COALESCE(SUM(p.total_price),0)::numeric AS total_revenue,
        COALESCE(SUM(p.qty),0)::int            AS vouchers_sold,
        COUNT(p.id) FILTER (WHERE p.status='COMPLETED')::int AS completed
      FROM partners pt
      LEFT JOIN purchases p ON p.partner_id = pt.id ${where.replace('WHERE','AND')}
      GROUP BY pt.id, pt.name
      ORDER BY total_revenue DESC
      LIMIT 20
    `, params);

    res.json({ top_partners: result.rows });
  } catch (e) {
    console.error('❌ Error en reports/top-partners:', e);
    res.status(500).json({ error: 'Error al obtener top partners' });
  }
});

router.get('/admin/reports/top-courses', authenticate, requireAnyPermission(['dashboard', 'stats', 'reports'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`a.activated_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`a.activated_at <= $${params.length}::date + INTERVAL '1 day'`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        c.id                          AS course_id,
        c.name                        AS course_name,
        COUNT(a.id)::int              AS total_activations,
        COUNT(DISTINCT v.partner_id)::int AS partners_count
      FROM courses c
      LEFT JOIN activations a ON a.course_id = c.id ${where.replace('WHERE','AND')}
      LEFT JOIN vouchers v ON v.id = a.voucher_id
      GROUP BY c.id, c.name
      ORDER BY total_activations DESC
      LIMIT 20
    `, params);

    res.json({ top_courses: result.rows });
  } catch (e) {
    console.error('❌ Error en reports/top-courses:', e);
    res.status(500).json({ error: 'Error al obtener top cursos' });
  }
});

router.get('/admin/reports/purchases', authenticate, requireAnyPermission(['reports', 'purchases', 'financial_ops'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date, partner_id, status, page = 1, limit = 25 } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`p.created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    if (partner_id && /^\d+$/.test(partner_id)) { params.push(parseInt(partner_id,10)); conditions.push(`p.partner_id = $${params.length}`); }
    if (status)     { params.push(status.toUpperCase()); conditions.push(`p.status = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const pageNum  = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset   = (pageNum - 1) * limitNum;

    params.push(limitNum); const limitIdx  = params.length;
    params.push(offset);   const offsetIdx = params.length;

    const [dataQ, countQ] = await Promise.all([
      pool.query(`
        SELECT
          p.id,
          p.partner_id,
          pt.name AS partner_name,
          p.qty,
          p.total_price,
          p.status,
          p.stripe_status,
          p.created_at,
          p.updated_at,
          (SELECT COUNT(*)::int FROM vouchers v WHERE v.purchase_id = p.id AND v.status='CONSUMED') AS vouchers_used
        FROM purchases p
        LEFT JOIN partners pt ON pt.id = p.partner_id
        ${where}
        ORDER BY p.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, params),
      pool.query(`SELECT COUNT(*)::int AS total FROM purchases p ${where}`, params.slice(0, params.length - 2))
    ]);

    const total = countQ.rows[0].total;
    const pages = Math.ceil(total / limitNum) || 1;

    res.json({
      purchases: dataQ.rows,
      pagination: { page: pageNum, limit: limitNum, total, pages }
    });
  } catch (e) {
    console.error('❌ Error en reports/purchases:', e);
    res.status(500).json({ error: 'Error al obtener compras para reporte' });
  }
});

router.get('/admin/reports/export/csv', authenticate, requirePermission('reports', 'view'), async (req, res) => {
  try {
    const { start_date, end_date, partner_id, status } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`p.created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    if (partner_id && /^\d+$/.test(partner_id)) { params.push(parseInt(partner_id,10)); conditions.push(`p.partner_id = $${params.length}`); }
    if (status)     { params.push(status.toUpperCase()); conditions.push(`p.status = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        p.id                           AS "ID Compra",
        pt.name AS "Partner",
        p.qty                          AS "Qty Vouchers",
        p.total_price                  AS "Total (€)",
        p.status                       AS "Estado",
        p.stripe_status                AS "Stripe Status",
        TO_CHAR(p.created_at,'YYYY-MM-DD HH24:MI') AS "Fecha Creación",
        TO_CHAR(p.updated_at,'YYYY-MM-DD HH24:MI') AS "Última Actualización",
        (SELECT COUNT(*)::int FROM vouchers v WHERE v.purchase_id = p.id AND v.status='CONSUMED') AS "Vouchers Usados"
      FROM purchases p
      LEFT JOIN partners pt ON pt.id = p.partner_id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT 10000
    `, params);

    const csv = convertToCSV(result.rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=reporte_compras.csv');
    res.send(csv);
  } catch (e) {
    console.error('❌ Error exportando reporte CSV:', e);
    res.status(500).json({ error: 'Error al exportar reporte en CSV' });
  }
});

module.exports = router;
