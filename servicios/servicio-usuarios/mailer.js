'use strict';

/**
 * Wraps SMTP email delivery via nodemailer.
 * All public functions return a result object; they NEVER throw.
 *
 * Required env vars (todas configurables por entorno del host):
 *   MAIL_ENABLED   'true' para enviar; 'false' deshabilita (solo loguea)
 *   SMTP_HOST      host SMTP (local: 'mailpit'; QA/PD: smtp real)
 *   SMTP_PORT      puerto SMTP (local: 1025; smtp real: 465/587)
 *   SMTP_SECURE    'true' para TLS implícito (puerto 465)
 *   SMTP_USER      usuario SMTP (vacío en local)
 *   SMTP_PASS      contraseña/app-password SMTP (vacío en local)
 *   MAIL_FROM      dirección remitente (e.g. no-reply@certjoin.com)
 *   MAIL_FROM_NAME nombre visible del remitente
 *   MAIL_REPLY_TO  dirección Reply-To opcional
 */

const nodemailer = require('nodemailer');

const MAIL_ENABLED   = process.env.MAIL_ENABLED === 'true';
const SMTP_HOST      = process.env.SMTP_HOST || '';
const SMTP_PORT      = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE    = process.env.SMTP_SECURE === 'true';
const SMTP_USER      = process.env.SMTP_USER || '';
const SMTP_PASS      = process.env.SMTP_PASS || '';
const MAIL_FROM      = process.env.MAIL_FROM || 'no-reply@certjoin.com';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'CertJOIN Platform';
const MAIL_REPLY_TO  = process.env.MAIL_REPLY_TO || '';

let _transport = null;

/** Devuelve true si el envío real está habilitado y configurado. */
function isEnabled() {
  return MAIL_ENABLED && Boolean(SMTP_HOST);
}

/** Crea (perezosamente) y cachea el transporte nodemailer. */
function getTransport() {
  if (_transport) return _transport;

  const opts = {
    host:   SMTP_HOST,
    port:   SMTP_PORT,
    secure: SMTP_SECURE
  };
  // Mailpit/relays locales no requieren auth; solo añadir credenciales si existen
  if (SMTP_USER || SMTP_PASS) {
    opts.auth = { user: SMTP_USER, pass: SMTP_PASS };
  }
  _transport = nodemailer.createTransport(opts);
  return _transport;
}

/** Construye el header "From" con nombre visible. */
function fromHeader() {
  return MAIL_FROM_NAME ? `"${MAIL_FROM_NAME}" <${MAIL_FROM}>` : MAIL_FROM;
}

/**
 * Envía un correo. Nunca lanza.
 * Returns:
 *   { sent: true, messageId }       — enviado
 *   { skipped: true, reason }       — deshabilitado o sin configuración
 *   { error }                       — fallo de envío
 */
async function sendMail({ to, subject, html, text }) {
  if (!to) {
    return { error: 'destinatario (to) requerido' };
  }
  if (!isEnabled()) {
    const reason = !MAIL_ENABLED ? 'mail_disabled' : 'no_smtp_host';
    console.log(`[MAIL] ${reason} → to=${to} subject="${subject || ''}" (no enviado)`);
    return { skipped: true, reason };
  }

  try {
    const message = {
      from:    fromHeader(),
      to,
      subject: subject || '(sin asunto)',
      text:    text || undefined,
      html:    html || undefined
    };
    if (MAIL_REPLY_TO) message.replyTo = MAIL_REPLY_TO;

    const info = await getTransport().sendMail(message);
    console.log(`[MAIL] enviado → to=${to} subject="${subject || ''}" messageId=${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[MAIL] error enviando a ${to}: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Verifica la conexión SMTP (para health/test). Nunca lanza.
 * Returns { ok: true } | { skipped, reason } | { error }
 */
async function verifyConnection() {
  if (!isEnabled()) {
    return { skipped: true, reason: !MAIL_ENABLED ? 'mail_disabled' : 'no_smtp_host' };
  }
  try {
    await getTransport().verify();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  isEnabled,
  sendMail,
  verifyConnection
};
