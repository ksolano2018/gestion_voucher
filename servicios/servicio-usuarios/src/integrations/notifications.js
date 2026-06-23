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

// ── Soporte al editor de plantillas: proxys al microservicio de notificaciones ──
function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_API_TOKEN) headers['x-internal-token'] = INTERNAL_API_TOKEN;
  return headers;
}

async function getTemplateDefault(key) {
  const resp = await fetch(`${NOTIFICATIONS_URL}/internal/template-default/${encodeURIComponent(key)}`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`notificaciones ${resp.status}`);
  return resp.json();
}

async function previewTemplate(payload) {
  const resp = await fetch(`${NOTIFICATIONS_URL}/internal/template-preview`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) { const err = new Error(data.message || 'render_error'); err.status = resp.status; throw err; }
  return data;
}

async function testTemplate(payload) {
  const resp = await fetch(`${NOTIFICATIONS_URL}/internal/template-test`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) { const err = new Error(data.message || 'test_error'); err.status = resp.status; throw err; }
  return data;
}

// Best-effort: invalida la caché de plantillas del microservicio tras guardar/activar.
async function invalidateTemplateCache(key) {
  try {
    await fetch(`${NOTIFICATIONS_URL}/internal/template-cache-invalidate`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ key })
    });
  } catch (e) { /* no crítico: la caché expira sola en ~60s */ }
}

module.exports = {
  sendStudentWelcomeEmail,
  getTemplateDefault, previewTemplate, testTemplate, invalidateTemplateCache
};
