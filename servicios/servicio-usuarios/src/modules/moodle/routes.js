'use strict';
// Módulo Moodle: webhook de cursos, matrículas (pending/retry/retry-all),
// sincronización (completaciones/cursos), test de conexión, preview de cursos y mapping.
const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const pool = require('../../db/pool');
const moodleService = require('../../../moodle-service');
const { authenticate, requireRole } = require('../../lib/auth');
const { apiLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { logSystemEvent } = require('../../lib/audit');
const { sendStudentWelcomeEmail } = require('../../integrations/notifications');
const { syncMoodleCompletions, syncMoodleCourses } = require('./service');

// ── Moodle webhook: receptor de eventos push de cursos ───────────────────────
// Moodle llama este endpoint cuando crea, actualiza o elimina un curso.
// Requiere configurar el plugin "local_webhooks" en Moodle y definir
// MOODLE_WEBHOOK_SECRET en el .env (token Bearer que Moodle enviará en el header).
router.post('/webhook/moodle/course-event', async (req, res) => {
  const secret = process.env.MOODLE_WEBHOOK_SECRET;
  const auth   = req.headers['authorization'];

  if (secret) {
    if (!auth || auth !== `Bearer ${secret}`) {
      console.warn('⚠️ [MOODLE WEBHOOK] Token inválido o ausente');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('❌ [MOODLE WEBHOOK] MOODLE_WEBHOOK_SECRET no configurado en producción. Webhook rechazado.');
    return res.status(500).json({ error: 'Webhook configuration error' });
  } else {
    console.warn('⚠️ [MOODLE WEBHOOK] MOODLE_WEBHOOK_SECRET no configurado (dev — verificación omitida)');
  }

  const { event } = req.body || {};
  const eventStr  = typeof event === 'string' ? event : '';
  console.log(`📨 [MOODLE WEBHOOK] Evento recibido: ${eventStr}`);

  const isCourseEvent = [
    'course_created', 'course_updated', 'course_deleted',
    '\\core\\event\\course_created', '\\core\\event\\course_updated', '\\core\\event\\course_deleted'
  ].includes(eventStr);

  if (!isCourseEvent) {
    return res.json({ ok: true, action: 'ignored', event: eventStr });
  }

  try {
    const syncResult = await syncMoodleCourses();
    if (!syncResult.ok) {
      console.error(`❌ [MOODLE WEBHOOK] Sync falló: ${syncResult.error}`);
      return res.status(502).json({ ok: false, error: syncResult.error });
    }

    console.log(`✓ [MOODLE WEBHOOK] Sync post-evento: +${syncResult.created.length} nuevas, ~${syncResult.updated.length} actualizadas, -${syncResult.deactivated.length} desactivadas`);

    logSystemEvent(
      'MOODLE_WEBHOOK_COURSE_SYNC', 'MOODLE', null, null, null,
      { event: eventStr, created: syncResult.created.length, updated: syncResult.updated.length, deactivated: syncResult.deactivated.length },
      'SUCCESS', null, req
    ).catch(() => {});

    return res.json({
      ok:          true,
      action:      'synced',
      event:       eventStr,
      created:     syncResult.created.length,
      updated:     syncResult.updated.length,
      deactivated: syncResult.deactivated.length
    });
  } catch (e) {
    console.error('❌ [MOODLE WEBHOOK] Error inesperado:', e.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// Admin: list activations with FAILED or PENDING Moodle enrollment
router.get('/admin/moodle/pending-enrollments',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    try {
      const { status = 'FAILED', limit = 50, offset = 0 } = req.query;
      const validStatuses = ['FAILED', 'PENDING'];
      const safeStatus = validStatuses.includes((status || '').toUpperCase())
        ? status.toUpperCase() : 'FAILED';

      const result = await pool.query(
        `SELECT a.id, a.voucher_id, a.course_id, a.user_name, a.user_email,
                a.final_client, a.activated_at,
                a.moodle_status, a.moodle_user_id, a.moodle_error,
                a.moodle_retry_count, a.moodle_retried_at,
                c.name AS course_name, c.moodle_course_id
         FROM activations a
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.moodle_status = $1
         ORDER BY a.activated_at DESC
         LIMIT $2 OFFSET $3`,
        [safeStatus, parseInt(limit, 10), parseInt(offset, 10)]
      );
      const total = await pool.query(
        'SELECT COUNT(*) FROM activations WHERE moodle_status = $1',
        [safeStatus]
      );
      res.json({
        enrollments: result.rows,
        total: parseInt(total.rows[0].count, 10),
        status: safeStatus
      });
    } catch (e) {
      console.error('❌ Error fetching pending Moodle enrollments:', e);
      res.status(500).json({ error: 'Error al obtener matrículas pendientes' });
    }
  }
);

// Admin: retry a single failed Moodle enrollment
router.post('/admin/moodle/enrollments/:activationId/retry',
  authenticate, requireRole('admin'), apiLimiter,
  param('activationId').isInt({ min: 1 }).withMessage('activationId inválido'),
  handleValidationErrors,
  async (req, res) => {
    const { activationId } = req.params;
    try {
      const actResult = await pool.query(
        `SELECT a.id, a.user_name, a.user_email, a.moodle_status, a.expires_at,
                a.moodle_retry_count, c.moodle_course_id, c.name AS course_name
         FROM activations a
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.id = $1`,
        [activationId]
      );
      if (actResult.rowCount === 0) {
        return res.status(404).json({ error: 'Activation no encontrada' });
      }
      const act = actResult.rows[0];
      if (act.moodle_status === 'ENROLLED') {
        return res.status(400).json({ error: 'Ya matriculado', moodle_status: act.moodle_status });
      }
      if (!act.moodle_course_id) {
        return res.status(400).json({ error: 'El curso no tiene moodle_course_id mapeado' });
      }

      await pool.query(
        `UPDATE activations
         SET moodle_status='PENDING', moodle_retried_at=NOW(),
             moodle_retry_count = moodle_retry_count + 1
         WHERE id=$1`,
        [activationId]
      );

      const nameParts = (act.user_name || '').trim().split(/\s+/);
      const moodleResult = await moodleService.enrollStudent({
        email:          act.user_email,
        firstName:      nameParts[0] || act.user_email.split('@')[0],
        lastName:       nameParts.slice(1).join(' ') || 'Student',
        moodleCourseId: act.moodle_course_id,
        expiresAt:      act.expires_at
      });

      let moodleStatus, moodleUserId, moodleError, moodleEnrolledAt;
      let moodleUsername = null, moodleTempPassword = null;

      if (moodleResult.enrolled || moodleResult.mocked) {
        moodleStatus     = moodleResult.mocked ? 'MOCKED' : 'ENROLLED';
        moodleUserId     = moodleResult.moodleUserId;
        moodleEnrolledAt = new Date();
        moodleUsername    = moodleResult.moodleUsername    || null;
        moodleTempPassword = moodleResult.moodleTempPassword || null;
      } else {
        moodleStatus = 'FAILED';
        moodleError  = moodleResult.error;
        moodleUserId = moodleResult.moodleUserId || null;
      }

      await pool.query(
        `UPDATE activations
         SET moodle_status=$1, moodle_user_id=$2, moodle_error=$3, moodle_enrolled_at=$4,
             moodle_username=COALESCE($5, moodle_username),
             moodle_temp_password=COALESCE($6, moodle_temp_password)
         WHERE id=$7`,
        [moodleStatus, moodleUserId || null, moodleError || null, moodleEnrolledAt || null,
         moodleUsername, moodleTempPassword, activationId]
      );

      await logSystemEvent(
        `MOODLE_ENROLL_RETRY_${moodleStatus}`,
        'MOODLE', req.user.sub, null, null,
        { activation_id: parseInt(activationId, 10), moodle_course_id: act.moodle_course_id, user_email: act.user_email },
        moodleStatus === 'FAILED' ? 'FAILED' : 'SUCCESS',
        moodleError || null, req
      );

      // Correo al estudiante (no bloqueante):
      //  - cuenta nueva en Moodle        → bienvenida con credenciales
      //  - cuenta existente, curso nuevo → aviso de nueva certificación (sin contraseña)
      if (moodleResult.createdNewUser && moodleTempPassword) {
        await sendStudentWelcomeEmail({
          activationId: parseInt(activationId, 10),
          to:           act.user_email,
          studentName:  act.user_name,
          courseName:   act.course_name,
          username:     moodleUsername,
          tempPassword: moodleTempPassword,
          expiresAt:    act.expires_at,
          userId:       req.user.sub,
          req
        });
      } else if ((moodleStatus === 'ENROLLED' || moodleStatus === 'MOCKED') && !moodleResult.createdNewUser) {
        await sendStudentWelcomeEmail({
          activationId: parseInt(activationId, 10),
          to:           act.user_email,
          studentName:  act.user_name,
          courseName:   act.course_name,
          expiresAt:    act.expires_at,
          userId:       req.user.sub,
          isNewEnrollment: true,
          req
        });
      }

      res.json({
        ok:             moodleStatus !== 'FAILED',
        activation_id:  parseInt(activationId, 10),
        moodle_status:  moodleStatus,
        moodle_user_id: moodleUserId || null,
        error:          moodleError  || null
      });
    } catch (e) {
      console.error('❌ Error retrying Moodle enrollment:', e);
      res.status(500).json({ error: 'Error al reintentar matrícula en Moodle' });
    }
  }
);

// Admin: bulk retry all FAILED Moodle enrollments (up to 100 at a time)
router.post('/admin/moodle/enrollments/retry-all-failed',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    try {
      const failed = await pool.query(
        `SELECT a.id FROM activations a
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.moodle_status = 'FAILED'
           AND c.moodle_course_id IS NOT NULL
         ORDER BY a.activated_at DESC
         LIMIT 100`
      );

      const results = { attempted: 0, succeeded: 0, failed: 0 };

      for (const row of failed.rows) {
        const actResult = await pool.query(
          `SELECT a.user_name, a.user_email, a.expires_at, c.moodle_course_id, c.name AS course_name
           FROM activations a
           LEFT JOIN courses c ON c.id = a.course_id
           WHERE a.id=$1`, [row.id]
        );
        if (actResult.rowCount === 0) continue;
        const act = actResult.rows[0];

        const nameParts = (act.user_name || '').trim().split(/\s+/);
        const moodleResult = await moodleService.enrollStudent({
          email:          act.user_email,
          firstName:      nameParts[0] || act.user_email.split('@')[0],
          lastName:       nameParts.slice(1).join(' ') || 'Student',
          moodleCourseId: act.moodle_course_id,
          expiresAt:      act.expires_at
        });

        results.attempted++;
        const ok = moodleResult.enrolled || moodleResult.mocked;
        if (ok) results.succeeded++;
        else    results.failed++;

        await pool.query(
          `UPDATE activations
           SET moodle_status=$1, moodle_user_id=$2, moodle_error=$3,
               moodle_enrolled_at=$4, moodle_retried_at=NOW(),
               moodle_retry_count = moodle_retry_count + 1,
               moodle_username=COALESCE($5, moodle_username),
               moodle_temp_password=COALESCE($6, moodle_temp_password)
           WHERE id=$7`,
          [
            ok ? (moodleResult.mocked ? 'MOCKED' : 'ENROLLED') : 'FAILED',
            moodleResult.moodleUserId || null,
            ok ? null : moodleResult.error,
            ok ? new Date() : null,
            ok ? (moodleResult.moodleUsername    || null) : null,
            ok ? (moodleResult.moodleTempPassword || null) : null,
            row.id
          ]
        );

        // Correo al estudiante (no bloqueante):
        //  - cuenta nueva en Moodle        → bienvenida con credenciales
        //  - cuenta existente, curso nuevo → aviso de nueva certificación (sin contraseña)
        if (moodleResult.createdNewUser && moodleResult.moodleTempPassword) {
          await sendStudentWelcomeEmail({
            activationId: row.id,
            to:           act.user_email,
            studentName:  act.user_name,
            courseName:   act.course_name,
            username:     moodleResult.moodleUsername,
            tempPassword: moodleResult.moodleTempPassword,
            expiresAt:    act.expires_at,
            userId:       req.user.sub,
            req
          });
        } else if (ok && !moodleResult.createdNewUser) {
          await sendStudentWelcomeEmail({
            activationId: row.id,
            to:           act.user_email,
            studentName:  act.user_name,
            courseName:   act.course_name,
            expiresAt:    act.expires_at,
            userId:       req.user.sub,
            isNewEnrollment: true,
            req
          });
        }
      }

      await logSystemEvent('MOODLE_BULK_RETRY', 'MOODLE', req.user.sub, null, null,
        results, 'SUCCESS', null, req);
      res.json({ ok: true, ...results });
    } catch (e) {
      console.error('❌ Error en bulk Moodle retry:', e);
      res.status(500).json({ error: 'Error en reintento masivo' });
    }
  }
);

// Admin: sync completion status for all ENROLLED activations
router.post('/admin/moodle/sync-completions',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    try {
      const force = req.query.force === 'true' || req.body?.force === true;
      const syncResult = await syncMoodleCompletions({ force });

      await logSystemEvent(
        'MOODLE_COMPLETION_SYNC', 'MOODLE', req.user.sub, null, null,
        syncResult, 'SUCCESS', null, req
      );

      res.json({ ok: true, ...syncResult });
    } catch (e) {
      console.error('❌ Error syncing Moodle completions:', e);
      res.status(500).json({ error: 'Error al sincronizar completaciones de Moodle' });
    }
  }
);

// Admin: test Moodle connection
router.get('/admin/moodle/test-connection',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    const result = await moodleService.testConnection();
    if (result.error) return res.status(502).json({ ok: false, error: result.error });
    res.json({ ok: true, sitename: result.sitename, username: result.username, mock: moodleService.isMockMode() });
  }
);

// Admin: preview courses available in Moodle (no DB changes)
router.get('/admin/moodle/courses',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    const result = await moodleService.getCourses();
    if (result.error) return res.status(502).json({ ok: false, error: result.error });
    res.json({ ok: true, courses: result.courses, total: result.courses.length });
  }
);

// Admin: sync Moodle courses into platform courses table
router.post('/admin/moodle/sync-courses',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    const result = await syncMoodleCourses();
    if (!result.ok) return res.status(502).json(result);
    await logSystemEvent('MOODLE_COURSES_SYNCED', 'MOODLE', req.user.sub, null, null,
      { created: result.created.length, updated: result.updated.length, deactivated: result.deactivated.length },
      'SUCCESS', null, req);
    res.json(result);
  }
);

// Admin: map a platform course to a Moodle course ID
router.put('/admin/courses/:id/moodle-mapping',
  authenticate, requireRole('admin'), apiLimiter,
  param('id').isInt({ min: 1 }).withMessage('Course ID inválido'),
  body('moodle_course_id').isInt({ min: 1 }).withMessage('moodle_course_id debe ser un entero positivo'),
  handleValidationErrors,
  async (req, res) => {
    const { id } = req.params;
    const { moodle_course_id } = req.body;
    try {
      const result = await pool.query(
        'UPDATE courses SET moodle_course_id=$1 WHERE id=$2 RETURNING id, name, moodle_course_id',
        [moodle_course_id, id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Curso no encontrado' });
      }
      await logSystemEvent('COURSE_MOODLE_MAPPING_UPDATED', 'MOODLE', req.user.sub, null, null,
        { course_id: parseInt(id, 10), moodle_course_id }, 'SUCCESS', null, req);
      res.json({ ok: true, course: result.rows[0] });
    } catch (e) {
      res.status(500).json({ error: 'Error al actualizar mapping de Moodle' });
    }
  }
);

module.exports = router;
