'use strict';
// Lógica de datos de plantillas de correo (tabla email_templates).
// Versionado: cada guardado crea una versión nueva; 1 activa por clave
// (garantizado por el índice parcial único uniq_email_templates_active).
const pool = require('../../db/pool');

// Claves soportadas (deben coincidir con DEFAULT_TEMPLATES del microservicio).
const KNOWN_KEYS = {
  student_welcome: 'Bienvenida al estudiante (cuenta nueva)',
  student_new_enrollment: 'Nueva certificación (cuenta existente)'
};

function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(KNOWN_KEYS, key);
}

// Resumen por clave: si hay versión activa y su metadata.
async function listTemplates() {
  const r = await pool.query(`
    SELECT t.template_key, t.version, t.updated_at, t.updated_by
    FROM email_templates t
    WHERE t.is_active
  `);
  const activeByKey = new Map(r.rows.map(row => [row.template_key, row]));
  return Object.entries(KNOWN_KEYS).map(([key, label]) => {
    const a = activeByKey.get(key);
    return {
      key, label,
      has_active: !!a,
      active_version: a ? a.version : null,
      updated_at: a ? a.updated_at : null,
      updated_by: a ? a.updated_by : null
    };
  });
}

async function getActive(key) {
  const r = await pool.query(
    'SELECT id, template_key, subject, body_html, body_text, description, version, is_active, updated_by, updated_at FROM email_templates WHERE template_key=$1 AND is_active LIMIT 1',
    [key]
  );
  return r.rowCount ? r.rows[0] : null;
}

async function getHistory(key) {
  const r = await pool.query(
    'SELECT id, version, is_active, description, updated_by, updated_at FROM email_templates WHERE template_key=$1 ORDER BY version DESC',
    [key]
  );
  return r.rows;
}

async function getVersion(key, version) {
  const r = await pool.query(
    'SELECT id, template_key, subject, body_html, body_text, description, version, is_active, updated_by, updated_at FROM email_templates WHERE template_key=$1 AND version=$2',
    [key, version]
  );
  return r.rowCount ? r.rows[0] : null;
}

// Crea una versión nueva. Si activate=true, la deja como única activa (en tx).
async function saveNewVersion(key, { subject, body_html, body_text = null, description = null, updated_by = null, activate = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vr = await client.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM email_templates WHERE template_key=$1', [key]);
    const version = vr.rows[0].v;
    if (activate) {
      await client.query('UPDATE email_templates SET is_active=FALSE WHERE template_key=$1 AND is_active', [key]);
    }
    const ins = await client.query(
      `INSERT INTO email_templates (template_key, subject, body_html, body_text, description, is_active, version, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       RETURNING id, template_key, version, is_active`,
      [key, subject, body_html, body_text, description, !!activate, version, updated_by]
    );
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Marca una versión existente como la activa (rollback/cambio de versión).
async function activateVersion(key, version) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT id FROM email_templates WHERE template_key=$1 AND version=$2', [key, version]);
    if (exists.rowCount === 0) { await client.query('ROLLBACK'); return null; }
    await client.query('UPDATE email_templates SET is_active=FALSE WHERE template_key=$1 AND is_active', [key]);
    await client.query('UPDATE email_templates SET is_active=TRUE, updated_at=NOW() WHERE template_key=$1 AND version=$2', [key, version]);
    await client.query('COMMIT');
    return { key, version };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  KNOWN_KEYS, isKnownKey,
  listTemplates, getActive, getHistory, getVersion, saveNewVersion, activateVersion
};
