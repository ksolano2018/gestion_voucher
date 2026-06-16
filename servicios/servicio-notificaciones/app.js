'use strict';
/**
 * servicio-notificaciones — microservicio de notificaciones por correo.
 *
 * Responsabilidad única: construir y enviar los correos al estudiante
 * (bienvenida con credenciales, o aviso de nueva certificación) y registrar el
 * resultado en activations.email_* y system_events.
 *
 * Contrato interno (no público; solo red interna de Docker):
 *   POST /internal/send   body = { activationId, to, studentName, courseName,
 *                                  username, tempPassword, months, expiresAt,
 *                                  userId, isNewEnrollment, force }
 *     → { email_status: 'SENT' | 'FAILED' | 'SKIPPED' | null }
 *   GET  /health
 *
 * Postgres es compartido con servicio-usuarios (decisión de arquitectura).
 */
const express = require('express');
const { Pool } = require('pg');
const mailer = require('./mailer');
const { buildStudentWelcomeEmail } = require('./email-templates');

const app = express();
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432,
  database: process.env.DB_NAME || 'proyectodb',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'admin123',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const CAMPUS_URL = process.env.CAMPUS_URL
  || (process.env.MOODLE_PUBLIC_URL ? `${process.env.MOODLE_PUBLIC_URL.replace(/\/$/, '')}/login/index.php` : 'https://campus.certjoin.com/');

// Registro de evento de sistema (auditoría). No lanza.
async function logSystemEvent(eventType, eventCategory, userId, stripeCustomerId, purchaseId, eventData, status = 'SUCCESS', errorMessage = null) {
  try {
    await pool.query(
      `INSERT INTO system_events (event_type, event_category, user_id, stripe_customer_id, purchase_id, event_data, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [eventType, eventCategory, userId, stripeCustomerId, purchaseId, JSON.stringify(eventData), status, errorMessage]
    );
  } catch (e) {
    console.error('❌ Error logging system event:', e.message);
  }
}

/**
 * Envía el correo al estudiante. Idempotente (no reenvía si email_status ya es
 * 'SENT', salvo force) y no bloqueante (nunca lanza). Devuelve el estado del envío.
 */
async function sendStudentWelcomeEmail({ activationId, to, studentName, courseName, username, tempPassword, months = null, expiresAt, userId = null, isNewEnrollment = false, force = false }) {
  try {
    if (!to) return null;

    if (!force) {
      const prev = await pool.query('SELECT email_status FROM activations WHERE id=$1', [activationId]);
      if (prev.rowCount > 0 && prev.rows[0].email_status === 'SENT') return null;
    }

    const { subject, html, text } = buildStudentWelcomeEmail({
      studentName, email: to, courseName, username, tempPassword, months, expiresAt, campusUrl: CAMPUS_URL, isNewEnrollment
    });

    const result = await mailer.sendMail({ to, subject, html, text });

    let emailStatus, emailError = null;
    if (result.sent)        emailStatus = 'SENT';
    else if (result.skipped) emailStatus = 'SKIPPED';
    else                     { emailStatus = 'FAILED'; emailError = result.error || 'error desconocido'; }

    const sentAt = result.sent ? new Date() : null;
    await pool.query(
      `UPDATE activations
       SET email_status=$1, email_error=$2, email_to=$3,
           email_sent_at = COALESCE($4::timestamp, email_sent_at)
       WHERE id=$5`,
      [emailStatus, emailError, to, sentAt, activationId]
    );

    const eventBase = isNewEnrollment ? 'STUDENT_NEW_COURSE_EMAIL' : 'STUDENT_WELCOME_EMAIL';
    await logSystemEvent(
      `${eventBase}_${emailStatus}`,
      'EMAIL', userId, null, null,
      { activation_id: activationId, to, course_name: courseName, reason: result.reason || null, new_enrollment: isNewEnrollment, forced: force },
      emailStatus === 'FAILED' ? 'FAILED' : 'SUCCESS',
      emailError
    );

    return emailStatus;
  } catch (e) {
    console.error(`❌ Error enviando correo (activation ${activationId}):`, e.message);
    return 'FAILED';
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'servicio-notificaciones', mail_enabled: mailer.isEnabled() });
});

// Guarda del endpoint interno: si hay token configurado, exigir el header coincidente.
// (Defensa adicional; el servicio además no se expone fuera de la red interna de Docker.)
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';
function requireInternalToken(req, res, next) {
  if (!INTERNAL_API_TOKEN) return next(); // sin token configurado: no se exige (dev)
  if (req.get('x-internal-token') === INTERNAL_API_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized_internal' });
}

app.post('/internal/send', requireInternalToken, async (req, res) => {
  const emailStatus = await sendStudentWelcomeEmail(req.body || {});
  res.json({ email_status: emailStatus });
});

const PORT = process.env.PORT || 8083;
/* istanbul ignore next */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✓ servicio-notificaciones escuchando en puerto: ${PORT} (mail_enabled=${mailer.isEnabled()})`);
  });
}

module.exports = { app, pool };
