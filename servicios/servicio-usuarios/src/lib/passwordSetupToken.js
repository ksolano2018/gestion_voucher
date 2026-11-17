'use strict';
// Enlace de un solo uso para que el estudiante cree su propia contraseña de Moodle,
// en vez de que el correo de bienvenida la traiga en texto plano (QA-08).
const crypto = require('crypto');
const pool = require('../db/pool');

const TOKEN_TTL_DAYS = 7;

// Genera y guarda el token; devuelve la URL completa a incluir en el correo.
// Si moodleUserId falta (no debería pasar cuando createdNewUser=true), devuelve null
// y el correo cae de nuevo a no mostrar ni contraseña ni link (mejor que romper el envío).
async function createPasswordSetupUrl(moodleUserId, email) {
  if (!moodleUserId) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO moodle_password_setup_tokens (token, moodle_user_id, email, expires_at) VALUES ($1,$2,$3,$4)`,
    [token, moodleUserId, email, expiresAt]
  );
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  return `${base}/set-password?token=${token}`;
}

module.exports = { createPasswordSetupUrl };
