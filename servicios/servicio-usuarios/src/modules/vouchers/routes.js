'use strict';
// Módulo de vouchers + activación (el flujo más acoplado del sistema).
// Orquesta varios dominios: vouchers, compras (backfill), cursos, Moodle (matrícula)
// y notificaciones (correo al estudiante). Publica eventos de dominio in-process
// (VOUCHER_ACTIVATED, EMAIL_RESEND_REQUESTED) vía src/lib/events — la costura que en
// la Fase 3 se sustituye por un bus real. El comportamiento (rutas/respuestas) es
// idéntico al monolito; sólo cambia de archivo y se añaden emits no bloqueantes.
//
// Rutas:
//   GET  /partner/:id/vouchers                                  listado de vouchers del partner
//   GET  /partner/:id/activation-eligibility                    ¿hay vouchers pagados para activar?
//   POST /partner/:id/activate                                  activa un voucher (consume + matrícula + correo)
//   POST /partner/:id/activations/:activationId/resend-email    reenvío del correo (partner, con tope+cooldown)
//   POST /admin/activations/:activationId/resend-email          reenvío del correo (admin, escalación sin límites)
//   GET  /admin/activations                                     contexto completo de activaciones (admin)
const express = require('express');
const { body, param } = require('express-validator');

const pool = require('../../db/pool');
const { logSecurityEvent, logSystemEvent } = require('../../lib/audit');
const { apiLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { authenticate, requireRole } = require('../../lib/auth');
const { sendStudentWelcomeEmail } = require('../../integrations/notifications');
// El backfill de vouchers vive ahora en servicio-compras (cliente HTTP).
const { backfillPaidPurchaseVouchers } = require('../../integrations/purchases');
const { emitDomainEvent } = require('../../lib/events');
const moodleService = require('../../integrations/moodle');

// Controles anti-spam del reenvío del partner (configurables por entorno).
const MAX_PARTNER_EMAIL_RETRIES = parseInt(process.env.MAX_PARTNER_EMAIL_RETRIES) || 1;
const EMAIL_RESEND_COOLDOWN_MIN = parseInt(process.env.EMAIL_RESEND_COOLDOWN_MIN) || 10;

const router = express.Router();

// Partner: list vouchers (protected) - only owner or admin
router.get('/partner/:id/vouchers', authenticate, async (req,res)=>{
  const pid = req.params.id;
  // allow if requestor is admin or belongs to the partner
  if(req.user && req.user.role !== 'admin'){
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid)){
      return res.status(403).json({ error: 'forbidden' });
    }
  }
  try{
    await backfillPaidPurchaseVouchers(pid);

    const r = await pool.query(
      `SELECT v.id, v.partner_id, v.purchase_id, v.code, v.status, v.course_id, c.name AS course_name,
              v.consumed_by, v.consumed_at, v.created_at,
              v.voucher_type, v.complimentary_reason,
              a.final_client, a.user_name AS activation_user_name,
              a.moodle_status, a.moodle_user_id, a.moodle_error, a.moodle_enrolled_at,
              a.moodle_completed_at, a.expires_at,
              a.id AS activation_id,
              a.email_status, a.email_error, a.email_sent_at,
              a.email_retry_count, a.email_last_attempt_at
       FROM vouchers v
       LEFT JOIN courses c ON c.id = v.course_id
       LEFT JOIN activations a ON a.voucher_id = v.id
       WHERE v.partner_id=$1
       ORDER BY v.created_at DESC`,
      [pid]
    );
    res.json(r.rows);
  }catch(e){ res.status(400).json({error:e.message}); }
});

router.get('/partner/:id/activation-eligibility', authenticate, apiLimiter, async (req, res) => {
  const pid = req.params.id;
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    await backfillPaidPurchaseVouchers(pid);

    const result = await pool.query(
      `SELECT COUNT(*) AS available_paid
       FROM vouchers v
       INNER JOIN purchases p ON p.id = v.purchase_id
       WHERE v.partner_id=$1
         AND v.status='AVAILABLE'
         AND v.course_id IS NULL
         AND (p.status='PAID' OR p.stripe_status IN ('succeeded', 'paid'))`,
      [pid]
    );

    const availablePaid = parseInt(result.rows[0].available_paid, 10) || 0;
    return res.json({
      can_activate: availablePaid > 0,
      available_paid_vouchers: availablePaid,
      message: availablePaid > 0
        ? 'Puedes activar vouchers.'
        : 'No hay vouchers pagados disponibles para activar.'
    });
  } catch (e) {
    return res.status(400).json({ error: 'Error al validar elegibilidad de activación' });
  }
});

// Partner: activate voucher with validation
router.post('/partner/:id/activate',
  authenticate,
  requireRole('partner'),
  apiLimiter,
  param('id').isInt().withMessage('Partner ID inválido'),
  body('course_id').isInt({ min: 1 }).withMessage('Curso inválido'),
  body('user_name').trim().isLength({ min: 2, max: 100 }).withMessage('Nombre debe tener entre 2 y 100 caracteres'),
  body('user_email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('final_client').trim().isLength({ min: 2, max: 200 }).withMessage('Cliente final es obligatorio'),
  body('activation_months').optional().isInt({ min: 1, max: 120 }).withMessage('Meses de activación inválidos'),
  handleValidationErrors,
  async (req, res) => {
    const pid = req.params.id;
    const { course_id, user_name, user_email, final_client, activation_months } = req.body;

    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    try {
      await backfillPaidPurchaseVouchers(pid);

      // Resolve max activation months from system settings
      const settingRow = await pool.query("SELECT value FROM system_settings WHERE key='max_activation_months'");
      const maxMonths = settingRow.rows.length ? (parseInt(settingRow.rows[0].value) || 12) : 12;
      const reqMonths = activation_months ? parseInt(activation_months) : maxMonths;
      if (reqMonths < 1 || reqMonths > maxMonths) {
        return res.status(400).json({ error: `El tiempo de disponibilidad debe estar entre 1 y ${maxMonths} meses` });
      }

      const course = await pool.query(
        'SELECT id, name, moodle_course_id FROM courses WHERE id=$1',
        [course_id]
      );
      if (course.rowCount === 0) {
        return res.status(404).json({ error: 'Certificación no encontrada' });
      }

      const voucherQuery = await pool.query(
        `SELECT v.id, v.code, v.purchase_id
         FROM vouchers v
         INNER JOIN purchases p ON p.id = v.purchase_id
         WHERE v.partner_id=$1
           AND v.status='AVAILABLE'
           AND v.course_id IS NULL
           AND (p.status='PAID' OR p.stripe_status IN ('succeeded', 'paid'))
         ORDER BY v.created_at ASC
         LIMIT 1`,
        [pid]
      );

      if (voucherQuery.rowCount === 0) {
        logSecurityEvent('VOUCHER_ACTIVATION_FAILED', { partnerId: pid, reason: 'no_available_paid_voucher', userId: req.user.sub });
        await logSystemEvent('VOUCHER_ACTIVATION_ERROR', 'VOUCHER', req.user.sub, null, null, {
          partner_id: parseInt(pid, 10),
          reason: 'no_available_paid_voucher'
        }, 'FAILED', 'No hay vouchers disponibles con pago exitoso', req);
        return res.status(400).json({ error: 'No hay vouchers disponibles con pago exitoso' });
      }

      const voucher = voucherQuery.rows[0];
      const moodleCourseId = course.rows[0].moodle_course_id || null;

      await pool.query(
        'UPDATE vouchers SET status=$1, consumed_by=$2, consumed_at=NOW(), course_id=$3 WHERE id=$4',
        ['CONSUMED', user_email, course_id, voucher.id]
      );

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + reqMonths);

      const activationResult = await pool.query(
        `INSERT INTO activations (voucher_id, course_id, user_name, user_email, final_client, moodle_status, expires_at, activation_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [voucher.id, course_id, user_name, user_email, final_client,
         moodleCourseId ? 'PENDING' : 'SKIPPED', expiresAt, 'ACTIVE']
      );
      const activationId = activationResult.rows[0].id;

      await logSystemEvent('VOUCHER_ACTIVATED', 'VOUCHER', req.user.sub, null, voucher.purchase_id, {
        partner_id: parseInt(pid, 10),
        voucher_id: voucher.id,
        voucher_code: voucher.code,
        course_id,
        user_email,
        final_client,
        moodle_course_id: moodleCourseId
      }, 'SUCCESS', null, req);

      logSecurityEvent('VOUCHER_ACTIVATED', {
        voucherId: voucher.id,
        code: voucher.code,
        courseId: course_id,
        partnerId: pid,
        userEmail: user_email,
        finalClient: final_client,
        userId: req.user.sub
      });

      // Evento de dominio (costura strangler, sin consumidores obligatorios todavía).
      emitDomainEvent('VOUCHER_ACTIVATED', {
        activationId, voucherId: voucher.id, purchaseId: voucher.purchase_id,
        partnerId: parseInt(pid, 10), courseId: parseInt(course_id, 10),
        userEmail: user_email, finalClient: final_client
      });

      // Moodle enrollment — non-blocking: activation already persisted above
      const nameParts = (user_name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || user_email.split('@')[0];
      const lastName  = nameParts.slice(1).join(' ') || 'Student';

      const moodleResult = await moodleService.enrollStudent({
        email: user_email,
        firstName,
        lastName,
        moodleCourseId,
        expiresAt
      });

      let moodleStatus, moodleUserId, moodleError, moodleEnrolledAt;
      let moodleUsername = null, moodleTempPassword = null;

      if (moodleResult.skipped) {
        moodleStatus = 'SKIPPED';
      } else if (moodleResult.mocked) {
        moodleStatus     = 'MOCKED';
        moodleUserId     = moodleResult.moodleUserId;
        moodleEnrolledAt = new Date();
        moodleUsername    = moodleResult.moodleUsername    || null;
        moodleTempPassword = moodleResult.moodleTempPassword || null;
      } else if (moodleResult.enrolled) {
        moodleStatus      = 'ENROLLED';
        moodleUserId      = moodleResult.moodleUserId;
        moodleEnrolledAt  = new Date();
        moodleUsername    = moodleResult.moodleUsername    || null;
        moodleTempPassword = moodleResult.moodleTempPassword || null;
      } else {
        moodleStatus = 'FAILED';
        moodleError  = moodleResult.error;
        moodleUserId = moodleResult.moodleUserId || null;
        console.error(`❌ Moodle enrollment failed for activation ${activationId}:`, moodleResult.error);
      }

      await pool.query(
        `UPDATE activations
         SET moodle_status=$1, moodle_user_id=$2, moodle_error=$3, moodle_enrolled_at=$4,
             moodle_username=$5, moodle_temp_password=$6
         WHERE id=$7`,
        [moodleStatus, moodleUserId || null, moodleError || null, moodleEnrolledAt || null,
         moodleUsername, moodleTempPassword, activationId]
      );

      await logSystemEvent(
        moodleStatus === 'ENROLLED' ? 'MOODLE_ENROLLED' : `MOODLE_ENROLL_${moodleStatus}`,
        'MOODLE',
        req.user.sub,
        null,
        voucher.purchase_id,
        {
          activation_id:    activationId,
          voucher_id:       voucher.id,
          moodle_course_id: moodleCourseId,
          moodle_user_id:   moodleUserId || null,
          user_email,
          mock_mode:        moodleService.isMockMode()
        },
        moodleStatus === 'FAILED' ? 'FAILED' : 'SUCCESS',
        moodleError || null,
        req
      );

      // Correo al estudiante (no bloqueante):
      //  - cuenta nueva en Moodle        → bienvenida con credenciales (usuario + contraseña temporal)
      //  - cuenta existente, curso nuevo → aviso de nueva certificación (misma plantilla, sin contraseña)
      if (moodleResult.createdNewUser && moodleTempPassword) {
        await sendStudentWelcomeEmail({
          activationId,
          to:           user_email,
          studentName:  user_name,
          courseName:   course.rows[0].name,
          username:     moodleUsername,
          tempPassword: moodleTempPassword,
          months:       reqMonths,
          expiresAt,
          userId:       req.user.sub,
          req
        });
      } else if ((moodleStatus === 'ENROLLED' || moodleStatus === 'MOCKED') && !moodleResult.createdNewUser) {
        await sendStudentWelcomeEmail({
          activationId,
          to:           user_email,
          studentName:  user_name,
          courseName:   course.rows[0].name,
          months:       reqMonths,
          expiresAt,
          userId:       req.user.sub,
          isNewEnrollment: true,
          req
        });
      }

      res.json({
        ok: true,
        voucher_id:           voucher.id,
        voucher_code:         voucher.code,
        course_id,
        course_name:          course.rows[0].name,
        moodle_status:        moodleStatus,
        moodle_user_id:       moodleUserId || null,
        moodle_username:      moodleUsername || null,
        moodle_temp_password: moodleTempPassword || null,
        expires_at:           expiresAt.toISOString(),
        activation_months:    reqMonths
      });

    } catch (e) {
      await logSystemEvent('VOUCHER_ACTIVATION_ERROR', 'VOUCHER', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10),
        course_id,
        user_email
      }, 'FAILED', e.message, req);
      logSecurityEvent('VOUCHER_ACTIVATION_ERROR', { error: e.message, partnerId: pid, userId: req.user.sub });
      res.status(400).json({ error: 'Error al activar voucher' });
    }
  }
);

// Reenvío manual del correo de notificación al estudiante, desde el partner.
//
// Controles anti-abuso/anti-spam (todos en backend, no en el botón):
//  - Tope: máx. MAX_PARTNER_EMAIL_RETRIES reenvíos por activación (luego solo admin).
//  - Cooldown: mínimo EMAIL_RESEND_COOLDOWN_MIN minutos entre intentos.
//  - Solo aplica a correos ya intentados (email_status FAILED o SENT).
//  - Ownership: la activación debe pertenecer al partner autenticado.
//  - Cada intento queda auditado en system_events (EMAIL_MANUAL_RESEND_*).
router.post('/partner/:id/activations/:activationId/resend-email',
  authenticate, requireRole('partner'), apiLimiter,
  param('id').isInt().withMessage('Partner ID inválido'),
  param('activationId').isInt({ min: 1 }).withMessage('activationId inválido'),
  handleValidationErrors,
  async (req, res) => {
    const pid = req.params.id;
    const { activationId } = req.params;

    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    try {
      const r = await pool.query(
        `SELECT a.id, a.user_name, a.user_email, a.expires_at,
                a.moodle_status, a.moodle_username, a.moodle_temp_password,
                a.email_status, a.email_retry_count, a.email_last_attempt_at,
                c.name AS course_name, v.partner_id
         FROM activations a
         JOIN vouchers v ON v.id = a.voucher_id
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.id = $1`,
        [activationId]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Activación no encontrada' });
      }
      const act = r.rows[0];

      // Ownership: el voucher de la activación debe ser de este partner
      if (String(act.partner_id) !== String(pid)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      // Solo se reenvía un correo que ya se intentó antes (FAILED o SENT)
      if (!['FAILED', 'SENT'].includes(act.email_status)) {
        return res.status(400).json({
          error: 'No hay un correo de notificación para reenviar en esta activación.',
          code: 'NOTHING_TO_RESEND'
        });
      }

      // Tope de reintentos del partner
      const retryCount = act.email_retry_count || 0;
      if (retryCount >= MAX_PARTNER_EMAIL_RETRIES) {
        await logSystemEvent('EMAIL_MANUAL_RESEND_BLOCKED', 'EMAIL', req.user.sub, null, null,
          { activation_id: parseInt(activationId, 10), reason: 'retry_limit', retry_count: retryCount }, 'FAILED', 'retry_limit_reached', req);
        return res.status(429).json({
          error: `Alcanzaste el máximo de reenvíos (${MAX_PARTNER_EMAIL_RETRIES}). Si el estudiante aún no recibe el correo, contacta a un administrador.`,
          code: 'RETRY_LIMIT_REACHED'
        });
      }

      // Cooldown entre intentos
      if (act.email_last_attempt_at) {
        const elapsedMin = (Date.now() - new Date(act.email_last_attempt_at).getTime()) / 60000;
        if (elapsedMin < EMAIL_RESEND_COOLDOWN_MIN) {
          const wait = Math.max(1, Math.ceil(EMAIL_RESEND_COOLDOWN_MIN - elapsedMin));
          return res.status(429).json({
            error: `Debes esperar ${wait} min antes de reenviar de nuevo.`,
            code: 'COOLDOWN',
            retry_after_minutes: wait
          });
        }
      }

      // Registrar el intento ya (el cooldown se mide por intento, exitoso o no)
      await pool.query('UPDATE activations SET email_last_attempt_at = NOW() WHERE id=$1', [activationId]);

      // Variante: con credenciales (cuenta nueva) o aviso de nueva certificación (cuenta existente)
      const isNewEnrollment = !act.moodle_temp_password;

      const emailStatus = await sendStudentWelcomeEmail({
        activationId:  parseInt(activationId, 10),
        to:            act.user_email,
        studentName:   act.user_name,
        courseName:    act.course_name,
        username:      act.moodle_username,
        tempPassword:  act.moodle_temp_password,
        expiresAt:     act.expires_at,
        userId:        req.user.sub,
        isNewEnrollment,
        force:         true,
        req
      });

      // El tope solo consume un reintento cuando el correo SÍ se entregó (anti-spam:
      // limita notificaciones efectivas, no castiga fallos transitorios de SMTP).
      let newRetryCount = retryCount;
      if (emailStatus === 'SENT') {
        const upd = await pool.query(
          'UPDATE activations SET email_retry_count = email_retry_count + 1 WHERE id=$1 RETURNING email_retry_count',
          [activationId]
        );
        newRetryCount = upd.rows[0].email_retry_count;
      }

      await logSystemEvent(
        `EMAIL_MANUAL_RESEND_${emailStatus || 'SKIPPED'}`,
        'EMAIL', req.user.sub, null, null,
        { activation_id: parseInt(activationId, 10), to: act.user_email, new_enrollment: isNewEnrollment, retry_count: newRetryCount },
        emailStatus === 'SENT' ? 'SUCCESS' : 'FAILED',
        emailStatus === 'SENT' ? null : `email_status=${emailStatus}`, req
      );

      if (emailStatus !== 'SENT') {
        return res.status(502).json({
          error: 'No se pudo reenviar el correo en este momento. Intenta de nuevo más tarde.',
          code: 'SEND_FAILED',
          email_status: emailStatus
        });
      }

      emitDomainEvent('EMAIL_RESEND_REQUESTED', {
        activationId: parseInt(activationId, 10), source: 'partner',
        partnerId: parseInt(pid, 10), to: act.user_email, newEnrollment: isNewEnrollment
      });

      return res.json({
        ok: true,
        email_status: emailStatus,
        email_retry_count: newRetryCount,
        retries_remaining: Math.max(0, MAX_PARTNER_EMAIL_RETRIES - newRetryCount)
      });
    } catch (e) {
      console.error('❌ Error en reenvío de correo del partner:', e);
      res.status(500).json({ error: 'Error al reenviar el correo' });
    }
  }
);

// Reenvío del correo de notificación al estudiante, desde el admin (vía de escalación).
// A diferencia del partner: NO aplica tope ni cooldown, y puede enviar aunque el correo
// nunca se haya intentado (útil para activaciones previas a esta función), siempre que
// la matrícula en Moodle esté activa (ENROLLED/MOCKED). Queda auditado en system_events.
router.post('/admin/activations/:activationId/resend-email',
  authenticate, requireRole('admin'), apiLimiter,
  param('activationId').isInt({ min: 1 }).withMessage('activationId inválido'),
  handleValidationErrors,
  async (req, res) => {
    const { activationId } = req.params;
    try {
      const r = await pool.query(
        `SELECT a.id, a.user_name, a.user_email, a.expires_at,
                a.moodle_status, a.moodle_username, a.moodle_temp_password, a.email_status,
                c.name AS course_name
         FROM activations a
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.id = $1`,
        [activationId]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Activación no encontrada' });
      }
      const act = r.rows[0];

      // Debe existir acceso al curso que justifique la notificación
      const notifiableStatuses = ['ENROLLED', 'MOCKED', 'COMPLETED', 'COURSE_COMPLETED'];
      if (!notifiableStatuses.includes((act.moodle_status || '').toUpperCase())) {
        return res.status(400).json({
          error: 'La activación no tiene una matrícula activa en Moodle; no hay nada que notificar.',
          code: 'NO_ACTIVE_ENROLLMENT'
        });
      }

      await pool.query('UPDATE activations SET email_last_attempt_at = NOW() WHERE id=$1', [activationId]);

      const isNewEnrollment = !act.moodle_temp_password;

      const emailStatus = await sendStudentWelcomeEmail({
        activationId:  parseInt(activationId, 10),
        to:            act.user_email,
        studentName:   act.user_name,
        courseName:    act.course_name,
        username:      act.moodle_username,
        tempPassword:  act.moodle_temp_password,
        expiresAt:     act.expires_at,
        userId:        req.user.sub,
        isNewEnrollment,
        force:         true,
        req
      });

      await logSystemEvent(
        `EMAIL_ADMIN_RESEND_${emailStatus || 'SKIPPED'}`,
        'EMAIL', req.user.sub, null, null,
        { activation_id: parseInt(activationId, 10), to: act.user_email, new_enrollment: isNewEnrollment },
        emailStatus === 'SENT' ? 'SUCCESS' : 'FAILED',
        emailStatus === 'SENT' ? null : `email_status=${emailStatus}`, req
      );

      if (emailStatus !== 'SENT') {
        return res.status(502).json({
          error: 'No se pudo reenviar el correo en este momento. Intenta de nuevo más tarde.',
          code: 'SEND_FAILED',
          email_status: emailStatus
        });
      }

      emitDomainEvent('EMAIL_RESEND_REQUESTED', {
        activationId: parseInt(activationId, 10), source: 'admin',
        to: act.user_email, newEnrollment: isNewEnrollment
      });

      return res.json({ ok: true, email_status: emailStatus, new_enrollment: isNewEnrollment });
    } catch (e) {
      console.error('❌ Error en reenvío de correo del admin:', e);
      res.status(500).json({ error: 'Error al reenviar el correo' });
    }
  }
);

// Admin: full activations context (voucher + partner + course + moodle)
router.get('/admin/activations',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    try {
      const { partner_id, moodle_status, course_id, limit = 50, offset = 0 } = req.query;
      const filterConds = [];
      const filterVals  = [];

      if (partner_id)    { filterVals.push(parseInt(partner_id, 10)); filterConds.push(`pr.id=$${filterVals.length}`); }
      if (moodle_status) { filterVals.push(moodle_status.toUpperCase()); filterConds.push(`a.moodle_status=$${filterVals.length}`); }
      if (course_id)     { filterVals.push(parseInt(course_id, 10)); filterConds.push(`a.course_id=$${filterVals.length}`); }

      const whereClause = filterConds.length ? filterConds.join(' AND ') : '1=1';

      const result = await pool.query(
        `SELECT
           a.id                  AS activation_id,
           a.activated_at,
           a.user_name,
           a.user_email,
           a.final_client,
           a.moodle_status,
           a.moodle_user_id,
           a.moodle_error,
           a.moodle_enrolled_at,
           a.moodle_retry_count,
           a.moodle_username,
           -- moodle_temp_password NO se expone en el listado admin (dato sensible);
           -- el reenvío de credenciales lo usa solo del lado servidor.
           a.moodle_completed_at,
           a.moodle_completion_synced_at,
           a.expires_at,
           a.activation_status,
           a.email_status,
           a.email_error,
           a.email_sent_at,
           a.email_retry_count,
           v.id                  AS voucher_id,
           v.code                AS voucher_code,
           v.purchase_id,
           c.id                  AS course_id,
           c.name                AS course_name,
           c.moodle_course_id,
           pr.id                 AS partner_id,
           pr.name               AS partner_name,
           pr.email              AS partner_email
         FROM activations a
         JOIN vouchers v  ON v.id = a.voucher_id
         JOIN courses  c  ON c.id = a.course_id
         JOIN partners pr ON pr.id = v.partner_id
         WHERE ${whereClause}
         ORDER BY a.activated_at DESC
         LIMIT $${filterVals.length + 1} OFFSET $${filterVals.length + 2}`,
        [...filterVals, parseInt(limit, 10), parseInt(offset, 10)]
      );

      const countRes = await pool.query(
        `SELECT COUNT(*) FROM activations a
         JOIN vouchers v  ON v.id = a.voucher_id
         JOIN courses  c  ON c.id = a.course_id
         JOIN partners pr ON pr.id = v.partner_id
         WHERE ${whereClause}`,
        filterVals
      );

      res.json({
        activations: result.rows,
        total: parseInt(countRes.rows[0].count, 10)
      });
    } catch (e) {
      console.error('❌ Error fetching admin activations:', e);
      res.status(500).json({ error: 'Error al obtener activaciones' });
    }
  }
);

module.exports = router;
