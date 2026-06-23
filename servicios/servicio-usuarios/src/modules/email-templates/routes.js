'use strict';
// Módulo Email Templates: editor de plantillas de correo (panel admin).
//  - CRUD versionado sobre email_templates (una activa por clave)
//  - Vista previa y correo de prueba se delegan a servicio-notificaciones
//    (único camino de render = lo que realmente se envía).
const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../../lib/auth');
const { logSystemEvent } = require('../../lib/audit');
const svc = require('./service');
const notifications = require('../../integrations/notifications');

const adminOnly = [authenticate, requireRole('admin')];

// Lista de plantillas (clave + estado de la versión activa).
router.get('/admin/email-templates', adminOnly, async (req, res) => {
  try {
    res.json({ templates: await svc.listTemplates() });
  } catch (e) { res.status(500).json({ error: 'Error al listar plantillas' }); }
});

// Detalle de una clave: activa (o default si no hay), historial, default oficial y variables.
router.get('/admin/email-templates/:key', adminOnly, async (req, res) => {
  const { key } = req.params;
  if (!svc.isKnownKey(key)) return res.status(404).json({ error: 'unknown_template_key' });
  try {
    const [active, history] = await Promise.all([svc.getActive(key), svc.getHistory(key)]);
    let def = null, variables = [];
    try {
      const d = await notifications.getTemplateDefault(key);
      def = d.template; variables = d.variables || [];
    } catch (e) { /* el microservicio puede estar abajo; el editor aún funciona con la activa */ }
    res.json({
      key, label: svc.KNOWN_KEYS[key],
      active,                 // null si nunca se ha guardado una (se usa el default al enviar)
      default: def,           // diseño oficial (punto de partida / restaurar)
      history, variables,
      using_default: !active
    });
  } catch (e) { res.status(500).json({ error: 'Error al obtener la plantilla' }); }
});

// Cuerpo completo de una versión concreta (para ver/restaurar).
router.get('/admin/email-templates/:key/version/:version', adminOnly, async (req, res) => {
  const { key } = req.params;
  const version = parseInt(req.params.version, 10);
  if (!svc.isKnownKey(key) || !Number.isInteger(version)) return res.status(400).json({ error: 'bad_request' });
  try {
    const row = await svc.getVersion(key, version);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: 'Error al obtener la versión' }); }
});

// Guarda una versión nueva (opcionalmente activándola).
router.put('/admin/email-templates/:key', adminOnly, async (req, res) => {
  const { key } = req.params;
  if (!svc.isKnownKey(key)) return res.status(404).json({ error: 'unknown_template_key' });
  const { subject, body_html, body_text, description, activate } = req.body || {};
  if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'El asunto es obligatorio' });
  if (!body_html || !String(body_html).trim()) return res.status(400).json({ error: 'El cuerpo HTML es obligatorio' });
  try {
    const saved = await svc.saveNewVersion(key, {
      subject: String(subject), body_html: String(body_html),
      body_text: body_text != null ? String(body_text) : null,
      description: description != null ? String(description).slice(0, 500) : null,
      updated_by: req.user && (req.user.email || req.user.sub) ? String(req.user.email || req.user.sub) : null,
      activate: !!activate
    });
    if (saved.is_active) await notifications.invalidateTemplateCache(key);
    await logSystemEvent('EMAIL_TEMPLATE_SAVED', 'SETTINGS', req.user.sub, null, null,
      { template_key: key, version: saved.version, activated: saved.is_active }, 'SUCCESS', null, req);
    res.json({ ok: true, ...saved });
  } catch (e) {
    console.error('email-templates save error:', e.message);
    res.status(500).json({ error: 'Error al guardar la plantilla' });
  }
});

// Activa una versión existente (rollback / cambio de versión).
router.post('/admin/email-templates/:key/activate', adminOnly, async (req, res) => {
  const { key } = req.params;
  if (!svc.isKnownKey(key)) return res.status(404).json({ error: 'unknown_template_key' });
  const version = parseInt((req.body || {}).version, 10);
  if (!Number.isInteger(version)) return res.status(400).json({ error: 'version requerida' });
  try {
    const r = await svc.activateVersion(key, version);
    if (!r) return res.status(404).json({ error: 'version_not_found' });
    await notifications.invalidateTemplateCache(key);
    await logSystemEvent('EMAIL_TEMPLATE_ACTIVATED', 'SETTINGS', req.user.sub, null, null,
      { template_key: key, version }, 'SUCCESS', null, req);
    res.json({ ok: true, key, version });
  } catch (e) { res.status(500).json({ error: 'Error al activar la versión' }); }
});

// Vista previa del cuerpo dado (sin guardar) con datos de ejemplo.
router.post('/admin/email-templates/:key/preview', adminOnly, async (req, res) => {
  const { key } = req.params;
  if (!svc.isKnownKey(key)) return res.status(404).json({ error: 'unknown_template_key' });
  const { subject, body_html, body_text } = req.body || {};
  try {
    const out = await notifications.previewTemplate({ key, subject, body_html, body_text });
    res.json(out);
  } catch (e) {
    res.status(e.status === 400 ? 400 : 502).json({ error: 'preview_error', message: e.message });
  }
});

// Envía un correo de prueba con el cuerpo dado a una dirección.
router.post('/admin/email-templates/:key/test', adminOnly, async (req, res) => {
  const { key } = req.params;
  if (!svc.isKnownKey(key)) return res.status(404).json({ error: 'unknown_template_key' });
  const { to, subject, body_html, body_text } = req.body || {};
  if (!to || !String(to).trim()) return res.status(400).json({ error: 'Indica un correo de destino' });
  try {
    const out = await notifications.testTemplate({ key, to: String(to).trim(), subject, body_html, body_text });
    await logSystemEvent('EMAIL_TEMPLATE_TEST_SENT', 'SETTINGS', req.user.sub, null, null,
      { template_key: key, to, sent: out.sent, skipped: out.skipped }, out.sent ? 'SUCCESS' : 'FAILED', out.error || null, req);
    res.json(out);
  } catch (e) {
    res.status(e.status === 400 ? 400 : 502).json({ error: 'test_error', message: e.message });
  }
});

module.exports = router;
