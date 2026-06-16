'use strict';
// Cliente del microservicio servicio-notificaciones.
// Mantiene la MISMA firma que la antigua función local sendStudentWelcomeEmail,
// así los call-sites no cambian. Nunca lanza; devuelve el estado del envío.
const NOTIFICATIONS_URL = (process.env.NOTIFICATIONS_URL || 'http://servicio-notificaciones:8083').replace(/\/$/, '');
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';

async function sendStudentWelcomeEmail(args = {}) {
  // `req` no es serializable (referencias circulares); se descarta para el payload.
  const { req, ...payload } = args;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (INTERNAL_API_TOKEN) headers['x-internal-token'] = INTERNAL_API_TOKEN;
    const resp = await fetch(`${NOTIFICATIONS_URL}/internal/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      console.error(`❌ servicio-notificaciones respondió ${resp.status}`);
      return 'FAILED';
    }
    const data = await resp.json().catch(() => ({}));
    return data.email_status ?? null;
  } catch (e) {
    console.error('❌ Error llamando a servicio-notificaciones:', e.message);
    return 'FAILED';
  }
}

module.exports = { sendStudentWelcomeEmail };
