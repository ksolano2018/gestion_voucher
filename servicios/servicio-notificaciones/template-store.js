'use strict';

/**
 * Carga y render de plantillas de correo.
 *
 * - `renderEmail(pool, key, data)` → { subject, html, text } listo para enviar.
 *   Usa la versión ACTIVA de `email_templates` (con caché corta); si no hay o el
 *   render falla, cae a la plantilla por defecto del código. El correo nunca se
 *   rompe por una plantilla editada inválida.
 * - `renderProvided(strings, data)` → render de un cuerpo SIN guardar (para la
 *   vista previa / correo de prueba del editor admin).
 */
const Mustache = require('mustache');
const { DEFAULT_TEMPLATES, buildContext } = require('./default-templates');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { row|null, ts }

function invalidateCache(key) {
  if (key) cache.delete(key); else cache.clear();
}

async function getActiveTemplate(pool, key) {
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.row;
  let row = null;
  try {
    const r = await pool.query(
      'SELECT subject, body_html, body_text FROM email_templates WHERE template_key=$1 AND is_active LIMIT 1',
      [key]
    );
    row = r.rowCount ? r.rows[0] : null;
  } catch (e) {
    console.error(`⚠ No se pudo leer email_templates(${key}): ${e.message}`);
    row = null; // se usará el default
  }
  cache.set(key, { row, ts: Date.now() });
  return row;
}

// Render seguro de un trío subject/html/text contra un contexto ya construido.
function renderStrings(tpl, ctx) {
  const subject = Mustache.render(tpl.subject || '', ctx);
  const html    = Mustache.render(tpl.body_html || '', ctx);
  const text    = tpl.body_text ? Mustache.render(tpl.body_text, ctx) : html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { subject, html, text };
}

/**
 * Render del correo para envío real. `data` son los datos crudos de la activación
 * (studentName, email, courseName, tempPassword, months, expiresAt, campusUrl, …).
 */
async function renderEmail(pool, key, data) {
  const ctx = buildContext(data);
  const def = DEFAULT_TEMPLATES[key] || DEFAULT_TEMPLATES.student_welcome;
  // 1) intenta la versión activa de BD
  try {
    const row = await getActiveTemplate(pool, key);
    if (row) return renderStrings(row, ctx);
  } catch (e) {
    console.error(`⚠ Render de plantilla activa (${key}) falló, usando default: ${e.message}`);
  }
  // 2) default del código (también protegido)
  try {
    return renderStrings(def, ctx);
  } catch (e) {
    console.error(`⚠ Render del default (${key}) falló: ${e.message}`);
    // 3) último recurso: texto plano mínimo
    return {
      subject: def.subject || 'CertJoin',
      html: `<p>Hola ${ctx.studentName}, ya puedes ingresar a tu campus: <a href="${ctx.campusUrl}">${ctx.campusUrl}</a></p>`,
      text: `Hola ${ctx.studentName}, ingresa a tu campus: ${ctx.campusUrl}`
    };
  }
}

/**
 * Render de un cuerpo proporcionado por el editor (no guardado) contra un
 * contexto dado. No cae al default: si falla, lanza para que el editor muestre
 * el error de sintaxis Mustache.
 */
function renderProvided({ subject, body_html, body_text }, ctx) {
  return renderStrings({ subject, body_html, body_text }, ctx);
}

module.exports = { renderEmail, renderProvided, getActiveTemplate, invalidateCache };
