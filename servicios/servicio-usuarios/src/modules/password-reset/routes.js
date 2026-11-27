'use strict';
// "Olvidé mi contraseña" para usuarios de la plataforma (partner/admin/soporte/…).
// Los estudiantes NO entran por aquí: su contraseña es la de Moodle (ver /oauth/set-moodle-password).
//
// Flujo: POST /oauth/forgot-password {email} → correo con enlace de un solo uso (1 h)
//        GET  /oauth/reset-password/:token   → valida el enlace antes de mostrar el formulario
//        POST /oauth/reset-password {token,password} → fija la contraseña y cierra las sesiones.
// Endpoints públicos a propósito (como /oauth/token); los protegen el token (aleatorio, de un
// solo uso, expira) y los límites de peticiones.
const crypto = require('crypto');
const express = require('express');
const { body } = require('express-validator');
const bcrypt = require('bcrypt');
const router = express.Router();
const pool = require('../../db/pool');
const { authLimiter, passwordResetLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { logSystemEvent, logSecurityEvent } = require('../../lib/audit');
const { sendPasswordResetEmail } = require('../../integrations/notifications');

const TOKEN_TTL_MINUTES = 60;
const MAX_REQUESTS_PER_HOUR = 3; // por usuario: evita usar la función para inundar un buzón

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

const GENERIC_OK = {
  ok: true,
  message: 'Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña. Revisa tu bandeja (y spam).'
};

router.post('/oauth/forgot-password',
  passwordResetLimiter,
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  handleValidationErrors,
  async (req, res) => {
    const email = req.body.email;
    try {
      const u = await pool.query(
        'SELECT id, email, first_name, last_name, COALESCE(active, TRUE) AS active FROM users WHERE email=$1',
        [email]
      );
      const user = u.rows[0];

      if (!user || user.active === false) {
        // Misma respuesta que el caso exitoso: no se revela si la cuenta existe/está activa.
        await logSystemEvent('PASSWORD_RESET_REQUESTED', 'AUTH', user ? user.id : null, null, null,
          { email, result: user ? 'inactive_account' : 'unknown_email' }, 'SUCCESS', null, req);
        return res.json(GENERIC_OK);
      }

      const recent = await pool.query(
        `SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [user.id]
      );
      if (recent.rows[0].n >= MAX_REQUESTS_PER_HOUR) {
        await logSystemEvent('PASSWORD_RESET_REQUESTED', 'AUTH', user.id, null, null,
          { email, result: 'throttled' }, 'SUCCESS', null, req);
        return res.json(GENERIC_OK);
      }

      // Un solo enlace vigente por usuario: invalida los anteriores sin usar.
      await pool.query('UPDATE password_reset_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL', [user.id]);

      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
         VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'), $4)`,
        [user.id, hashToken(token), TOKEN_TTL_MINUTES, String(req.ip || '').slice(0, 64)]
      );

      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const resetUrl = `${base}/reset-password?token=${token}`;
      const userName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();

      await logSystemEvent('PASSWORD_RESET_REQUESTED', 'AUTH', user.id, null, null,
        { email, result: 'sent' }, 'SUCCESS', null, req);
      logSecurityEvent('PASSWORD_RESET_REQUESTED', { userId: user.id, email, ip: req.ip });

      // No bloqueante: el resultado del envío no cambia la respuesta (no filtra información).
      sendPasswordResetEmail({ to: user.email, userName, resetUrl, userId: user.id }).catch(() => {});

      return res.json(GENERIC_OK);
    } catch (e) {
      console.error('forgot-password error:', e.message);
      // Respuesta genérica también ante errores internos.
      return res.json(GENERIC_OK);
    }
  }
);

async function findValidToken(token) {
  const r = await pool.query(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email, u.password AS current_hash
       FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash=$1`,
    [hashToken(token)]
  );
  if (r.rowCount === 0) return { error: 'invalid_token' };
  const t = r.rows[0];
  if (t.used_at) return { error: 'token_already_used' };
  if (new Date(t.expires_at) < new Date()) return { error: 'token_expired' };
  return { row: t };
}

router.get('/oauth/reset-password/:token', authLimiter, async (req, res) => {
  try {
    const v = await findValidToken(String(req.params.token || ''));
    if (v.error) return res.status(400).json({ error: v.error });
    return res.json({ valid: true, email: v.row.email });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

router.post('/oauth/reset-password',
  authLimiter,
  body('token').isLength({ min: 10 }).withMessage('Token inválido'),
  body('password')
    .isLength({ min: 8 }).withMessage('Contraseña debe tener al menos 8 caracteres')
    .matches(/[A-Z]/).withMessage('Contraseña debe contener al menos una mayúscula')
    .matches(/[a-z]/).withMessage('Contraseña debe contener al menos una minúscula')
    .matches(/[0-9]/).withMessage('Contraseña debe contener al menos un número')
    .matches(/[!@#$%^&*]/).withMessage('Contraseña debe contener al menos un caracter especial (!@#$%^&*)'),
  handleValidationErrors,
  async (req, res) => {
    const { token, password } = req.body;
    const client = await pool.connect();
    try {
      const v = await findValidToken(String(token));
      if (v.error) return res.status(400).json({ error: v.error });
      const t = v.row;

      // No se permite reutilizar la contraseña vigente (informe QA 1.4). El token no se consume:
      // el usuario puede reintentar con otra contraseña desde el mismo enlace.
      if (t.current_hash && await bcrypt.compare(password, t.current_hash)) {
        return res.status(400).json({ error: 'same_password', message: 'La nueva contraseña no puede ser igual a la actual.' });
      }

      const hash = await bcrypt.hash(password, 10);
      const policyR = await pool.query("SELECT value FROM system_settings WHERE key='password_expiry_days'");
      const policyDays = policyR.rows.length ? parseInt(policyR.rows[0].value) || 0 : 0;

      await client.query('BEGIN');
      // Marcar usado de forma atómica: si dos peticiones llegan a la vez, solo una gana.
      const claim = await client.query(
        'UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1 AND used_at IS NULL RETURNING id',
        [t.id]
      );
      if (claim.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'token_already_used' }); }

      await client.query(
        `UPDATE users
            SET password=$1, must_change_password=FALSE,
                password_expires_at = CASE WHEN $3>0 THEN NOW() + ($3 * INTERVAL '1 day') ELSE NULL END,
                updated_at=NOW()
          WHERE id=$2`,
        [hash, t.user_id, policyDays]
      );
      // Cierra todas las sesiones abiertas (si alguien más tenía acceso, deja de tenerlo).
      await client.query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [t.user_id]);
      await client.query('UPDATE password_reset_tokens SET used_at=COALESCE(used_at, NOW()) WHERE user_id=$1', [t.user_id]);
      await client.query('COMMIT');

      await logSystemEvent('PASSWORD_RESET_COMPLETED', 'AUTH', t.user_id, null, null, { email: t.email }, 'SUCCESS', null, req);
      logSecurityEvent('PASSWORD_RESET_COMPLETED', { userId: t.user_id, email: t.email, ip: req.ip });

      return res.json({ ok: true, message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('reset-password error:', e.message);
      return res.status(500).json({ error: 'server_error' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
