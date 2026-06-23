'use strict';

/**
 * Plantillas por defecto (diseño oficial CertJoin) en formato Mustache, y el
 * `buildContext` que arma las variables que se inyectan al renderizar.
 *
 * Estas plantillas se usan cuando NO hay una versión activa en la tabla
 * `email_templates` para la clave dada (o si el render de la de BD falla), de modo
 * que el correo nunca depende de que exista una fila editada. También son el punto
 * de partida que el editor del panel admin ofrece como "restaurar diseño oficial".
 *
 * Variables disponibles en el cuerpo (Mustache):
 *   {{studentName}} {{email}} {{username}} {{courseName}} {{tempPassword}}
 *   {{durationStr}} {{expiresLbl}} {{campusUrl}}
 *   {{{headerInner}}} {{{socialsHtml}}}            (HTML ya seguro; triple llave)
 * Secciones (condicionales):
 *   {{#hasCourse}}…{{/hasCourse}}  {{#hasTempPassword}}…{{/hasTempPassword}}
 *   {{#hasExpires}}…{{/hasExpires}}
 *
 * Env opcionales que afectan el contexto: MAIL_LOGO_URL, CAMPUS_URL.
 */

const BRAND = {
  yellow: '#f1c232', orange: '#e69138', ink: '#1c1c1c',
  light: '#f8f9fa', white: '#ffffff', circle: '#5f6368'
};

const SOCIALS = [
  ['LinkedIn',  'https://www.linkedin.com/company/certjoin/',        'https://ssl.gstatic.com/atari/images/sociallinks/linkedin_white_28dp.png'],
  ['Instagram', 'https://www.instagram.com/certjoin/',               'https://ssl.gstatic.com/atari/images/sociallinks/instagram_white_28dp.png'],
  ['Twitter',   'https://twitter.com/cert_join',                     'https://ssl.gstatic.com/atari/images/sociallinks/twitter_white_28dp.png'],
  ['YouTube',   'https://www.youtube.com/@certjoin',                 'https://ssl.gstatic.com/atari/images/sociallinks/youtube_white_28dp.png'],
  ['Facebook',  'https://www.facebook.com/certjoincertifications',   'https://ssl.gstatic.com/atari/images/sociallinks/facebook_white_28dp.png']
];

// Lista de variables que se muestra en el editor (chuleta).
const TEMPLATE_VARIABLES = [
  { token: '{{studentName}}',  desc: 'Nombre del estudiante' },
  { token: '{{email}}',        desc: 'Correo / usuario de acceso' },
  { token: '{{username}}',     desc: 'Usuario de Moodle' },
  { token: '{{courseName}}',   desc: 'Nombre de la certificación' },
  { token: '{{tempPassword}}', desc: 'Contraseña temporal' },
  { token: '{{durationStr}}',  desc: 'Duración del acceso (p. ej. "6 meses")' },
  { token: '{{expiresLbl}}',   desc: 'Fecha de expiración (formateada)' },
  { token: '{{campusUrl}}',    desc: 'URL del botón Campus' },
  { token: '{{{headerInner}}}', desc: 'Cabecera (logo o marca). HTML ya generado.' },
  { token: '{{{socialsHtml}}}', desc: 'Iconos de redes del footer. HTML ya generado.' },
  { token: '{{#hasCourse}}…{{/hasCourse}}',             desc: 'Bloque visible solo si hay certificación' },
  { token: '{{#hasTempPassword}}…{{/hasTempPassword}}', desc: 'Bloque visible solo si hay contraseña temporal' },
  { token: '{{#hasExpires}}…{{/hasExpires}}',           desc: 'Bloque visible solo si hay fecha de expiración' }
];

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

function resolveMonths(months, expiresAt) {
  if (months && Number(months) > 0) return Math.round(Number(months));
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  if (isNaN(exp.getTime())) return null;
  const diff = (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.4375);
  return diff > 0 ? Math.round(diff) : null;
}

/**
 * Construye el contexto (variables) que Mustache inyecta en la plantilla.
 * Los valores van escapados por Mustache ({{ }}); headerInner/socialsHtml se
 * inyectan como HTML seguro ya generado por nosotros ({{{ }}}).
 */
function buildContext(p = {}) {
  const campusUrl = p.campusUrl || process.env.CAMPUS_URL || 'https://campus.certjoin.com/';
  const logoUrl   = process.env.MAIL_LOGO_URL || '';
  const months    = resolveMonths(p.months, p.expiresAt);
  const expiresLbl = formatDate(p.expiresAt);
  const courseName = p.courseName || '';
  const tempPassword = p.tempPassword || '';

  const headerInner = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="CertJoin" width="239" style="display:block;border:0;height:auto;max-width:239px;">`
    : `<span style="font-size:26px;font-weight:700;color:${BRAND.ink};letter-spacing:.5px;">Cert<span style="color:${BRAND.orange};">JOIN</span></span>`
      + `<div style="font-size:11px;color:${BRAND.circle};letter-spacing:2px;">CERTIFIED PROFESSIONAL</div>`;

  const socialsHtml = SOCIALS.map(([name, href, icon]) =>
    `<a href="${href}" target="_blank" style="display:inline-block;width:32px;height:32px;margin:6px;background:${BRAND.circle};border-radius:50%;line-height:0;text-align:center;">`
    + `<img src="${icon}" alt="${name}" width="28" height="28" style="margin:2px;border:0;"></a>`).join('');

  return {
    studentName: (p.studentName && p.studentName.trim()) ? p.studentName.trim() : 'Estudiante',
    email: p.email || '',
    username: p.username || '',
    courseName,
    tempPassword,
    durationStr: months ? `${months} ${months === 1 ? 'mes' : 'meses'}` : 'el periodo contratado',
    expiresLbl: expiresLbl || '',
    campusUrl,
    logoUrl,
    headerInner,
    socialsHtml,
    hasCourse: Boolean(courseName),
    hasTempPassword: Boolean(tempPassword),
    hasExpires: Boolean(expiresLbl),
    isNewEnrollment: Boolean(p.isNewEnrollment)
  };
}

// ── Layout compartido (Mustache). `copy` se hornea literal (editable); las
//    {{variables}} quedan como texto literal para que Mustache las resuelva. ──
function layoutHtml(copy) {
  const Y = BRAND.yellow, O = BRAND.orange, I = BRAND.ink, L = BRAND.light, W = BRAND.white;
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${L};font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${L};">
    <tr><td align="center" style="padding:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="800" style="max-width:800px;width:100%;">

        <tr><td align="center" style="background:${L};padding:24px 16px;">{{{headerInner}}}</td></tr>

        <tr><td style="background:${W};padding:28px 28px 20px;text-align:center;">
          <h1 style="margin:0 0 12px;font-size:23pt;line-height:1.25;font-weight:700;color:${I};">${copy.heading}</h1>
          <p style="margin:0;font-size:11pt;font-weight:700;color:${O};">${copy.subtitle}</p>
          <p style="margin:6px 0 0;font-size:14pt;color:${I};">${copy.introLine}</p>
          {{#hasCourse}}<p style="margin:14px 0 0;font-size:14px;color:${I};">Certificación: <strong>{{courseName}}</strong></p>{{/hasCourse}}
        </td></tr>

        <tr><td style="background:${L};padding:24px 28px;">
          <h2 style="margin:0 0 10px;font-size:17pt;font-weight:700;color:${I};text-align:center;">🧭 ¿Cómo ingresar a tu portal de certificación?</h2>
          <p style="margin:0 0 4px;font-size:11pt;color:${I};">1. Ingresa aquí 👇</p>
          <p style="text-align:center;margin:14px 0;">
            <a href="{{campusUrl}}" target="_blank" style="background:${Y};color:${I};text-decoration:none;padding:10px 28px;border-radius:4px;font-size:12pt;font-weight:700;display:inline-block;">Campus</a>
          </p>
          <p style="text-align:center;margin:0 0 12px;font-size:12pt;font-weight:700;color:${I};">Inicia sesión con tus datos.</p>
          <p style="text-align:center;margin:0 0 8px;font-size:11pt;font-weight:700;color:${O};">Explora todos tus recursos disponibles:</p>
          <ul style="list-style-type:square;margin:6px auto;padding-left:20px;max-width:360px;font-size:11pt;color:${I};">
            <li style="margin:4px 0;">📘 Material de autoestudio</li>
            <li style="margin:4px 0;">🧠 Simulador web</li>
            <li style="margin:4px 0;">🗂️ Recursos complementarios</li>
            <li style="margin:4px 0;">🎯 Ruta de preparación hacia tu examen oficial</li>
          </ul>
        </td></tr>

        <tr><td style="background:${Y};padding:22px 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="50%" valign="top" style="padding:6px 12px;text-align:center;">
                <h2 style="margin:0 0 8px;font-size:17pt;font-weight:700;color:${I};">🔐 Tus accesos</h2>
                <p style="margin:0;font-size:14px;color:${I};"><strong>👤 Usuario:</strong> {{email}}</p>
                {{#hasTempPassword}}<p style="margin:4px 0 0;font-size:14px;color:${I};"><strong>🔑 Contraseña:</strong> <strong style="font-family:monospace;">{{tempPassword}}</strong></p>{{/hasTempPassword}}
                <p style="margin:6px 0 0;font-size:12px;font-style:italic;color:${I};">(Si ya habías creado tu propia contraseña anteriormente, usa la más reciente.)</p>
              </td>
              <td width="50%" valign="top" style="padding:6px 12px;">
                <h2 style="margin:0 0 8px;font-size:17pt;font-weight:700;color:${I};">⏳ Duración del acceso</h2>
                <p style="margin:0;font-size:14px;color:${I};">Tendrás acceso completo a todos los recursos durante <strong>{{durationStr}}</strong>.</p>
                <p style="margin:6px 0 0;font-size:14px;color:${I};">Aprovecha este tiempo para prepararte con calma y avanzar a tu ritmo.</p>
                {{#hasExpires}}<p style="margin:8px 0 0;font-size:13px;color:${I};">Disponible hasta el <strong>{{expiresLbl}}</strong>.</p>{{/hasExpires}}
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="background:${L};padding:24px 28px;">
          <h2 style="margin:0 0 10px;font-size:17pt;font-weight:700;color:${I};">🤝 Estamos contigo</h2>
          <p style="margin:0 0 14px;font-size:11pt;color:${I};">Si en cualquier momento necesitas soporte técnico o información adicional durante tu proceso, estamos aquí para ayudarte.</p>
          <h2 style="margin:0 0 8px;font-size:17pt;font-weight:700;color:${I};text-align:center;">🎉 Tu éxito es nuestra prioridad. 🧡</h2>
          <p style="text-align:center;margin:0;font-size:11pt;color:${I};">Prepárate, estudia con confianza y ve por esa insignia internacional.<br>¡Estamos contigo en cada paso!</p>
        </td></tr>

        <tr><td align="center" style="background:${Y};padding:18px 28px;">
          <div style="margin-bottom:6px;">{{{socialsHtml}}}</div>
          <p style="margin:0;font-size:12pt;color:${I};"><a href="http://www.certjoin.com" target="_blank" style="color:${I};text-decoration:underline;">CertJoin Certifications LLC</a></p>
          <p style="margin:6px 0 0;font-size:12pt;color:${I};">4300 Biscayne Blvd Suite 203 Miami, Florida 33137</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function layoutText(copy) {
  return [
    copy.heading, '', copy.subtitle, copy.introLine,
    '{{#hasCourse}}Certificación: {{courseName}}{{/hasCourse}}',
    '', '¿Cómo ingresar a tu portal de certificación?',
    '1. Ingresa aquí: {{campusUrl}}', 'Inicia sesión con tus datos.',
    '', 'Explora todos tus recursos disponibles:',
    '- Material de autoestudio', '- Simulador web', '- Recursos complementarios',
    '- Ruta de preparación hacia tu examen oficial',
    '', 'Tus accesos', 'Usuario: {{email}}',
    '{{#hasTempPassword}}Contraseña: {{tempPassword}}{{/hasTempPassword}}',
    '', 'Duración del acceso',
    'Tendrás acceso completo a todos los recursos durante {{durationStr}}.',
    '{{#hasExpires}}Disponible hasta el {{expiresLbl}}.{{/hasExpires}}',
    '', 'Tu éxito es nuestra prioridad. ¡Estamos contigo en cada paso!',
    'CertJoin Certifications LLC — http://www.certjoin.com',
    '4300 Biscayne Blvd Suite 203 Miami, Florida 33137'
  ].join('\n');
}

const COPY_WELCOME = {
  heading: '🧡 ¡Bienvenido/a a tu Certificación Oficial con CertJoin!',
  subtitle: '¡Qué alegría tenerte aquí!',
  introLine: 'Hoy comienzas un camino que impulsará tu crecimiento profesional y abrirá nuevas oportunidades en tu carrera.'
};
const COPY_NEW_ENROLLMENT = {
  heading: '🎓 ¡Tienes una nueva certificación disponible!',
  subtitle: '¡Seguimos impulsando tu crecimiento profesional!',
  introLine: 'Hemos habilitado una nueva certificación en tu cuenta. Ya puedes ingresar al campus y comenzar tu preparación.'
};

const DEFAULT_TEMPLATES = {
  student_welcome: {
    key: 'student_welcome',
    label: 'Bienvenida al estudiante (cuenta nueva)',
    subject: '¡Bienvenido/a a tu Certificación Oficial con CertJoin!',
    body_html: layoutHtml(COPY_WELCOME),
    body_text: layoutText(COPY_WELCOME)
  },
  student_new_enrollment: {
    key: 'student_new_enrollment',
    label: 'Nueva certificación (cuenta existente)',
    subject: '¡Tienes una nueva certificación disponible en CertJoin!',
    body_html: layoutHtml(COPY_NEW_ENROLLMENT),
    body_text: layoutText(COPY_NEW_ENROLLMENT)
  }
};

// Datos de ejemplo para la vista previa / correo de prueba del editor.
function sampleContext(key) {
  return buildContext({
    studentName: 'Ana Pérez',
    email: 'ana.perez@example.com',
    username: 'ana.perez',
    courseName: 'Curso Java',
    tempPassword: key === 'student_new_enrollment' ? '' : 'Temp-7K2m!xQ',
    months: 6,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 182).toISOString(),
    isNewEnrollment: key === 'student_new_enrollment'
  });
}

function keyFor(isNewEnrollment) {
  return isNewEnrollment ? 'student_new_enrollment' : 'student_welcome';
}

module.exports = {
  DEFAULT_TEMPLATES, TEMPLATE_VARIABLES,
  buildContext, sampleContext, keyFor
};
