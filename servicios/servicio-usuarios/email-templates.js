'use strict';

/**
 * Plantillas de correo (HTML + texto plano).
 *
 * `buildStudentWelcomeEmail` reproduce la plantilla oficial de bienvenida de
 * CertJoin (cabecera con logo, accesos, duración, soporte y footer con redes).
 * Los datos dinámicos (usuario, contraseña temporal, duración real, fecha de
 * expiración) se inyectan desde la activación.
 *
 * Variables de entorno opcionales que afectan el render:
 *   MAIL_LOGO_URL  URL pública del logo CertJoin para la cabecera del correo.
 *   CAMPUS_URL     URL del botón "Campus" (por defecto https://campus.certjoin.com/).
 */

const BRAND = {
  name:     'CertJoin',
  yellow:   '#f1c232',   // banda de accesos / footer
  orange:   '#e69138',   // subtítulos
  ink:      '#1c1c1c',   // texto principal
  light:    '#f8f9fa',   // secciones claras
  white:    '#ffffff',
  circle:   '#5f6368'    // fondo iconos sociales
};

const SOCIALS = [
  ['LinkedIn',  'https://www.linkedin.com/company/certjoin/',        'https://ssl.gstatic.com/atari/images/sociallinks/linkedin_white_28dp.png'],
  ['Instagram', 'https://www.instagram.com/certjoin/',               'https://ssl.gstatic.com/atari/images/sociallinks/instagram_white_28dp.png'],
  ['Twitter',   'https://twitter.com/cert_join',                     'https://ssl.gstatic.com/atari/images/sociallinks/twitter_white_28dp.png'],
  ['YouTube',   'https://www.youtube.com/@certjoin',                 'https://ssl.gstatic.com/atari/images/sociallinks/youtube_white_28dp.png'],
  ['Facebook',  'https://www.facebook.com/certjoincertifications',   'https://ssl.gstatic.com/atari/images/sociallinks/facebook_white_28dp.png']
];

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Calcula meses de acceso a partir de expiresAt (relativo a ahora) si no se pasa explícito.
function resolveMonths(months, expiresAt) {
  if (months && Number(months) > 0) return Math.round(Number(months));
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  if (isNaN(exp.getTime())) return null;
  const diff = (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.4375);
  return diff > 0 ? Math.round(diff) : null;
}

/**
 * Correo de bienvenida al estudiante cuando se crea su cuenta en Moodle.
 *
 * @param {object} p
 * @param {string} p.studentName    nombre del estudiante (opcional)
 * @param {string} p.email          email del estudiante (login)
 * @param {string} p.courseName     nombre del curso/certificación (opcional)
 * @param {string} [p.username]     usuario de Moodle (informativo)
 * @param {string} [p.tempPassword] contraseña temporal (se cambia al primer acceso)
 * @param {number} [p.months]       meses de acceso (si se conoce)
 * @param {string|Date} [p.expiresAt] fecha de expiración del acceso
 * @param {string} [p.campusUrl]    URL del botón "Campus"
 * @returns {{ subject:string, html:string, text:string }}
 */
function buildStudentWelcomeEmail(p = {}) {
  const studentName = p.studentName && p.studentName.trim() ? p.studentName.trim() : 'Estudiante';
  const courseName  = p.courseName || '';
  const email       = p.email || '';
  const tempPassword = p.tempPassword || '';
  const campusUrl   = p.campusUrl || process.env.CAMPUS_URL || 'https://campus.certjoin.com/';
  const logoUrl     = process.env.MAIL_LOGO_URL || '';
  const months      = resolveMonths(p.months, p.expiresAt);
  const expiresLbl  = formatDate(p.expiresAt);

  const subject = '¡Bienvenido/a a tu Certificación Oficial con CertJoin!';

  const durationStr = months
    ? `${months} ${months === 1 ? 'mes' : 'meses'}`
    : 'el periodo contratado';

  // ── Cabecera: logo si hay URL, si no, marca en texto ──
  const headerInner = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="CertJoin" width="239" style="display:block;border:0;height:auto;max-width:239px;">`
    : `<span style="font-size:26px;font-weight:700;color:${BRAND.ink};letter-spacing:.5px;">Cert<span style="color:${BRAND.orange};">JOIN</span></span>
       <div style="font-size:11px;color:${BRAND.circle};letter-spacing:2px;">CERTIFIED PROFESSIONAL</div>`;

  const courseLineHtml = courseName
    ? `<p style="margin:14px 0 0;font-size:14px;color:${BRAND.ink};">Certificación: <strong>${escapeHtml(courseName)}</strong></p>`
    : '';

  const passwordRow = tempPassword
    ? `<p style="margin:4px 0 0;font-size:14px;color:${BRAND.ink};"><strong>🔑 Contraseña:</strong> <strong style="font-family:monospace;">${escapeHtml(tempPassword)}</strong></p>`
    : '';

  const expiresRowHtml = expiresLbl
    ? `<p style="margin:8px 0 0;font-size:13px;color:${BRAND.ink};">Disponible hasta el <strong>${escapeHtml(expiresLbl)}</strong>.</p>`
    : '';

  const socialsHtml = SOCIALS.map(([name, href, icon]) =>
    `<a href="${href}" target="_blank" style="display:inline-block;width:32px;height:32px;margin:6px;background:${BRAND.circle};border-radius:50%;line-height:0;text-align:center;">
       <img src="${icon}" alt="${name}" width="28" height="28" style="margin:2px;border:0;">
     </a>`).join('');

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.light};font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${BRAND.light};">
    <tr><td align="center" style="padding:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="800" style="max-width:800px;width:100%;">

        <!-- Cabecera -->
        <tr><td align="center" style="background:${BRAND.light};padding:24px 16px;">
          ${headerInner}
        </td></tr>

        <!-- Bienvenida -->
        <tr><td style="background:${BRAND.white};padding:28px 28px 20px;text-align:center;">
          <h1 style="margin:0 0 12px;font-size:23pt;line-height:1.25;font-weight:700;color:${BRAND.ink};">🧡 ¡Bienvenido/a a tu Certificación Oficial con CertJoin!</h1>
          <p style="margin:0;font-size:11pt;font-weight:700;color:${BRAND.orange};">¡Qué alegría tenerte aquí!</p>
          <p style="margin:6px 0 0;font-size:14pt;color:${BRAND.ink};">Hoy comienzas un camino que impulsará tu crecimiento profesional y abrirá nuevas oportunidades en tu carrera.</p>
          ${courseLineHtml}
        </td></tr>

        <!-- Cómo ingresar -->
        <tr><td style="background:${BRAND.light};padding:24px 28px;">
          <h2 style="margin:0 0 10px;font-size:17pt;font-weight:700;color:${BRAND.ink};text-align:center;">🧭 ¿Cómo ingresar a tu portal de certificación?</h2>
          <p style="margin:0 0 4px;font-size:11pt;color:${BRAND.ink};">1. Ingresa aquí 👇</p>
          <p style="text-align:center;margin:14px 0;">
            <a href="${escapeHtml(campusUrl)}" target="_blank" style="background:${BRAND.yellow};color:${BRAND.ink};text-decoration:none;padding:10px 28px;border-radius:4px;font-size:12pt;font-weight:700;display:inline-block;">Campus</a>
          </p>
          <p style="text-align:center;margin:0 0 12px;font-size:12pt;font-weight:700;color:${BRAND.ink};">Inicia sesión con tus datos.</p>
          <p style="text-align:center;margin:0 0 8px;font-size:11pt;font-weight:700;color:${BRAND.orange};">Explora todos tus recursos disponibles:</p>
          <ul style="list-style-type:square;margin:6px auto;padding-left:20px;max-width:360px;font-size:11pt;color:${BRAND.ink};">
            <li style="margin:4px 0;">📘 Material de autoestudio</li>
            <li style="margin:4px 0;">🧠 Simulador web</li>
            <li style="margin:4px 0;">🗂️ Recursos complementarios</li>
            <li style="margin:4px 0;">🎯 Ruta de preparación hacia tu examen oficial</li>
          </ul>
        </td></tr>

        <!-- Accesos + Duración (banda amarilla) -->
        <tr><td style="background:${BRAND.yellow};padding:22px 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="50%" valign="top" style="padding:6px 12px;text-align:center;">
                <h2 style="margin:0 0 8px;font-size:17pt;font-weight:700;color:${BRAND.ink};">🔐 Tus accesos</h2>
                <p style="margin:0;font-size:14px;color:${BRAND.ink};"><strong>👤 Usuario:</strong> ${escapeHtml(email)}</p>
                ${passwordRow}
                <p style="margin:6px 0 0;font-size:12px;font-style:italic;color:${BRAND.ink};">(Si ya habías creado tu propia contraseña anteriormente, usa la más reciente.)</p>
              </td>
              <td width="50%" valign="top" style="padding:6px 12px;">
                <h2 style="margin:0 0 8px;font-size:17pt;font-weight:700;color:${BRAND.ink};">⏳ Duración del acceso</h2>
                <p style="margin:0;font-size:14px;color:${BRAND.ink};">Tendrás acceso completo a todos los recursos durante <strong>${durationStr}</strong>.</p>
                <p style="margin:6px 0 0;font-size:14px;color:${BRAND.ink};">Aprovecha este tiempo para prepararte con calma y avanzar a tu ritmo.</p>
                ${expiresRowHtml}
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Estamos contigo -->
        <tr><td style="background:${BRAND.light};padding:24px 28px;">
          <h2 style="margin:0 0 10px;font-size:17pt;font-weight:700;color:${BRAND.ink};">🤝 Estamos contigo</h2>
          <p style="margin:0 0 14px;font-size:11pt;color:${BRAND.ink};">Si en cualquier momento necesitas soporte técnico o información adicional durante tu proceso, estamos aquí para ayudarte.</p>
          <h2 style="margin:0 0 8px;font-size:17pt;font-weight:700;color:${BRAND.ink};text-align:center;">🎉 Tu éxito es nuestra prioridad. 🧡</h2>
          <p style="text-align:center;margin:0;font-size:11pt;color:${BRAND.ink};">Prepárate, estudia con confianza y ve por esa insignia internacional.<br>¡Estamos contigo en cada paso!</p>
        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="background:${BRAND.yellow};padding:18px 28px;">
          <div style="margin-bottom:6px;">${socialsHtml}</div>
          <p style="margin:0;font-size:12pt;color:${BRAND.ink};"><a href="http://www.certjoin.com" target="_blank" style="color:${BRAND.ink};text-decoration:underline;">CertJoin Certifications LLC</a></p>
          <p style="margin:6px 0 0;font-size:12pt;color:${BRAND.ink};">4300 Biscayne Blvd Suite 203 Miami, Florida 33137</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // ── Versión texto plano ──
  const textLines = [
    '🧡 ¡Bienvenido/a a tu Certificación Oficial con CertJoin!',
    '',
    '¡Qué alegría tenerte aquí!',
    'Hoy comienzas un camino que impulsará tu crecimiento profesional y abrirá nuevas oportunidades en tu carrera.'
  ];
  if (courseName) textLines.push(`Certificación: ${courseName}`);
  textLines.push(
    '',
    '¿Cómo ingresar a tu portal de certificación?',
    `1. Ingresa aquí: ${campusUrl}`,
    'Inicia sesión con tus datos.',
    '',
    'Explora todos tus recursos disponibles:',
    '- Material de autoestudio',
    '- Simulador web',
    '- Recursos complementarios',
    '- Ruta de preparación hacia tu examen oficial',
    '',
    'Tus accesos',
    `Usuario: ${email}`
  );
  if (tempPassword) {
    textLines.push(`Contraseña: ${tempPassword}`);
    textLines.push('(Si ya habías creado tu propia contraseña anteriormente, usa la más reciente.)');
  }
  textLines.push(
    '',
    'Duración del acceso',
    `Tendrás acceso completo a todos los recursos durante ${durationStr}.`
  );
  if (expiresLbl) textLines.push(`Disponible hasta el ${expiresLbl}.`);
  textLines.push(
    '',
    'Estamos contigo. Si necesitas soporte técnico o información adicional, estamos aquí para ayudarte.',
    '🎉 Tu éxito es nuestra prioridad. 🧡',
    'Prepárate, estudia con confianza y ve por esa insignia internacional. ¡Estamos contigo en cada paso!',
    '',
    'CertJoin Certifications LLC — http://www.certjoin.com',
    '4300 Biscayne Blvd Suite 203 Miami, Florida 33137'
  );

  return { subject, html, text: textLines.join('\n') };
}

module.exports = {
  buildStudentWelcomeEmail
};
