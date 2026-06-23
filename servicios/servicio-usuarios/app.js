const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { body, param, validationResult } = require('express-validator');
require('dotenv').config();

// ── Módulos internos (refactor incremental hacia src/) ─────────────────────────
const pool = require('./src/db/pool');
const { logSecurityEvent, logSystemEvent } = require('./src/lib/audit');
const { authLimiter, apiLimiter } = require('./src/lib/rateLimit');
const { handleValidationErrors } = require('./src/lib/validation');
const { authenticate, requireRole, requirePermission, requireAnyPermission } = require('./src/lib/auth');
// Notificaciones, pricing, RBAC, Stripe y backfill de vouchers ya no se usan directamente
// en app.js: viven en sus módulos (src/modules/*, src/lib/*, src/integrations/*) y los
// consumen los routers / initDb.
// Jobs de sincronización Moodle (setInterval) → src/schedulers; se arrancan tras RUN_SCHEDULERS.
const { startSchedulers } = require('./src/schedulers');
// RUN_SCHEDULERS: por defecto activo; poner en 'false' en réplicas extra para no duplicar jobs.
const RUN_SCHEDULERS = process.env.RUN_SCHEDULERS !== 'false';

const MOODLE_PUBLIC_URL = (process.env.MOODLE_PUBLIC_URL || process.env.MOODLE_URL || '').replace(/\/$/, '');
const CAMPUS_URL = process.env.CAMPUS_URL || (MOODLE_PUBLIC_URL ? `${MOODLE_PUBLIC_URL}/login/index.php` : 'https://campus.certjoin.com/');

const app = express();

// Detrás del gateway/reverse proxy: confiar en el primer hop para que req.ip,
// el rate-limit y los logs de seguridad usen la IP real del cliente y no la del proxy.
app.set('trust proxy', 1);

// Security middleware - helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "http://localhost:*"]
    }
  }
}));

app.use(cookieParser());

// Prevent browser/proxy caching on all API responses
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Parse JSON for all routes EXCEPT /webhook/stripe (which needs raw body)
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook/stripe') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

// CORS configuration - restrict to known origins (but skip for webhook)
const allowedOrigins = process.env.NODE_ENV === 'production' 
  ? [process.env.FRONTEND_URL]
  : ['http://localhost:3000', 'http://localhost:8080'];

app.use((req, res, next) => {
  // Skip CORS for server-to-server webhooks (Stripe, Moodle)
  if (req.originalUrl === '/webhook/stripe' || req.originalUrl.startsWith('/webhook/moodle/')) {
    return next();
  }
  
  cors({ 
    origin: function(origin, callback) {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true 
  })(req, res, next);
});

// authLimiter / apiLimiter ahora viven en src/lib/rateLimit.js (importados arriba).

// Los controles anti-spam del reenvío (MAX_PARTNER_EMAIL_RETRIES / EMAIL_RESEND_COOLDOWN_MIN)
// viven ahora en src/modules/vouchers/routes.js junto a la ruta que los usa.

// El pool de Postgres ahora vive en src/db/pool.js (importado arriba).

// Validate required environment variables
const requiredEnvVars = ['JWT_SECRET', 'ADMIN_PASSWORD'];
// En producción exigimos también los secretos sensibles: nunca arrancar con
// los fallbacks débiles de desarrollo (DB_PASSWORD, claves de Stripe).
if (process.env.NODE_ENV === 'production') {
  requiredEnvVars.push('DB_PASSWORD', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET');
}
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error('❌ ERROR: Las siguientes variables de entorno son requeridas:', missingEnvVars.join(', '));
  console.error('Por favor configura un archivo .env basado en .env.example');
  process.exit(1);
}

// Validate JWT_SECRET strength
if (process.env.JWT_SECRET.length < 32) {
  console.error('❌ ERROR: JWT_SECRET debe tener al menos 32 caracteres para seguridad adecuada');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
// ADMIN_EMAIL/ADMIN_PASSWORD ya solo los usa el seed en src/schema/init.js (lee de env).
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS) || 7;
const SESSION_TIMEOUT_MINUTES = parseInt(process.env.SESSION_TIMEOUT_MINUTES) || 15;
// Inactividad: si pasan más de REFRESH_IDLE_MINUTES sin renovar (sin actividad), el
// refresh token expira (ventana deslizante: se renueva en cada /oauth/refresh).
// REFRESH_TOKEN_TTL_DAYS es el tope ABSOLUTO de la sesión aunque haya actividad.
const REFRESH_IDLE_MINUTES = parseInt(process.env.REFRESH_IDLE_MINUTES) || 30;
// El cliente Stripe y la lógica de sync viven en src/integrations/stripe.js (importados arriba).
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Bootstrap del esquema (initDb) → src/schema/init.js
const { initDb } = require("./src/schema/init");

// Pricing y RBAC: app.js ya no usa esos helpers directamente; viven en sus módulos
// (src/modules/pricing/service.js, src/lib/rbac.js) y los consumen initDb/roles/users.

/**
 * Envía el correo de bienvenida al estudiante cuando se crea su cuenta en Moodle.
 * No bloqueante e idempotente: nunca lanza, y no reenvía si email_status ya es 'SENT'
 * (salvo `force: true`, usado en el reenvío manual del partner/admin).
 * Registra el resultado en activations (email_status/email_error/email_to/email_sent_at)
 * y en system_events.
 *
 * @returns {string|null} estado del envío: 'SENT' | 'FAILED' | 'SKIPPED' | null (sin destinatario u omitido por idempotencia)
 */
// sendStudentWelcomeEmail ahora es un cliente HTTP a servicio-notificaciones (importado arriba).

// logTransactionEvent ahora vive en src/lib/audit.js (importado arriba).

// backfillPaidPurchaseVouchers → servicio-compras vía src/integrations/purchases (HTTP).

// Synchronize user with Stripe - find or create customer
// syncUserWithStripe → src/integrations/stripe.js (importado arriba).

// upsertPartnerAndUserFromStripeCustomer → src/integrations/stripe.js (importado arriba).

// syncAllStripeCustomersToPartners + el job de sincronización (stripeSyncJobs, runStripeSyncJob,
// getStripeSyncJobResponse) → src/integrations/stripe.js (importados arriba vía enqueue/get/getLatest).

// handleValidationErrors ahora vive en src/lib/validation.js (importado arriba).


initDb().catch(err=>{ console.error('DB init error', err); process.exit(1); });

// Los jobs de sincronización Moodle (completaciones + cursos) viven en src/schedulers
// y se arrancan desde app.listen cuando RUN_SCHEDULERS está activo.

// Partners (alta/listado + stats/summary) → src/modules/partners
app.use(require('./src/modules/partners/routes'));

// Pricing (perfiles, reglas, asignación por partner, preview) → src/modules/pricing
app.use(require('./src/modules/pricing/routes'));

// Compras + pagos Stripe → EXTRAÍDO al microservicio servicio-compras (el gateway
// enruta /admin/purchases, /partner/:id/checkout, /webhook/stripe, etc. allá).
// La activación rellena vouchers vía src/integrations/purchases (HTTP interno).

// Moodle (webhook + matrículas/retry + sync + test/courses/mapping) → src/modules/moodle
app.use(require('./src/modules/moodle/routes'));


// Vouchers + activación (listado, eligibility, activate, reenvío correo, /admin/activations) → src/modules/vouchers
app.use(require("./src/modules/vouchers/routes"));


// Courses (CRUD admin + cursos del partner + catalogs) → src/modules/courses
app.use(require('./src/modules/courses/routes'));


// Partner: final clients CRUD
// Final clients (clientes finales del partner) → src/modules/final-clients
app.use(require('./src/modules/final-clients/routes'));





// (rutas de matrículas/retry de Moodle movidas a src/modules/moodle)

// Vouchers de cortesía, compras externas, ajuste y detalle de compra → servicio-compras

// La lógica de sync Moodle vive en src/modules/moodle/service.js; los jobs en src/schedulers.
// (rutas /admin/moodle/* y /admin/courses/:id/moodle-mapping movidas a src/modules/moodle)


// (rutas de stats/summary de partner movidas a src/modules/partners)

// /catalogs ahora vive en src/modules/courses/routes.js

// OAuth2-like token endpoint (password grant) with rate limiting and validation
app.post('/oauth/token',
  authLimiter,
  body('grant_type').equals('password').withMessage('grant_type debe ser "password"'),
  body('username').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('password').isLength({ min: 6 }).withMessage('Contraseña debe tener al menos 6 caracteres'),
  handleValidationErrors,
  async (req,res)=>{
  const { grant_type, username, password } = req.body;
  try{
    console.log('🔐 Login attempt:', username);
    const u = await pool.query(
      `SELECT u.*, COALESCE(r.permissions, '{}'::jsonb) AS role_permissions, COALESCE(r.role_type, 'system_role') AS role_type
       FROM users u
       LEFT JOIN roles r ON r.name = u.role
       WHERE u.email=$1`,
      [username]
    );
    if(u.rowCount===0) {
      console.log('❌ User not found:', username);
      logSecurityEvent('LOGIN_FAILED', { username, reason: 'user_not_found', ip: req.ip });
      await logSystemEvent('LOGIN_FAILED', 'AUTH', null, null, null, { username, reason: 'user_not_found' }, 'FAILED', 'invalid_grant', req);
      return res.status(400).json({error:'invalid_grant'});
    }
    const user = u.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if(!ok) {
      logSecurityEvent('LOGIN_FAILED', { username, reason: 'wrong_password', ip: req.ip });
      await logSystemEvent('LOGIN_FAILED', 'AUTH', user.id, user.stripe_customer_id || null, null, { username, reason: 'wrong_password' }, 'FAILED', 'invalid_grant', req);
      return res.status(400).json({error:'invalid_grant'});
    }

    // Verificar si la contraseña ha caducado
    if (user.password_expires_at && new Date(user.password_expires_at) < new Date()) {
      await pool.query('UPDATE users SET must_change_password=TRUE, updated_at=NOW() WHERE id=$1', [user.id]);
      user.must_change_password = true;
    }

    if (user.must_change_password) {
      const expired = user.password_expires_at && new Date(user.password_expires_at) < new Date();
      logSecurityEvent('LOGIN_PASSWORD_CHANGE_REQUIRED', { userId: user.id, email: user.email, ip: req.ip, expired });
      await logSystemEvent('LOGIN_PASSWORD_CHANGE_REQUIRED', 'AUTH', user.id, user.stripe_customer_id || null, null, { email: user.email, expired }, 'SUCCESS', null, req);
      return res.status(200).json({
        must_change_password: true,
        email: user.email,
        message: expired
          ? 'Tu contraseña ha caducado. Debes establecer una nueva para continuar.'
          : 'Debes cambiar tu contraseña antes de continuar'
      });
    }
    
    logSecurityEvent('LOGIN_SUCCESS', { userId: user.id, email: user.email, role: user.role, ip: req.ip });
    await logSystemEvent('LOGIN_SUCCESS', 'AUTH', user.id, user.stripe_customer_id || null, null, { email: user.email, role: user.role }, 'SUCCESS', null, req);

    await pool.query('UPDATE users SET first_login_at = COALESCE(first_login_at, NOW()), updated_at=NOW() WHERE id=$1', [user.id]);
    
    const token = jwt.sign({
      sub:user.id,
      role:user.role,
      role_type: user.role_type || 'system_role',
      partner_id:user.partner_id,
      permissions: user.role_permissions || {},
      must_change_password: user.must_change_password
    }, JWT_SECRET, { expiresIn: `${SESSION_TIMEOUT_MINUTES}m` });

    // create refresh token and store in DB
    const refreshToken = crypto.randomBytes(40).toString('hex');
    await pool.query('INSERT INTO refresh_tokens (user_id,token) VALUES ($1,$2)',[user.id,refreshToken]);

    // set httpOnly cookie for refresh token with secure flag in production
    res.cookie('refresh_token', refreshToken, { 
      httpOnly: true, 
      sameSite: 'lax', 
      maxAge: 1000*60*60*24*REFRESH_TOKEN_TTL_DAYS,
      secure: process.env.NODE_ENV === 'production'
    });

    return res.json({ access_token: token, token_type: 'bearer', expires_in: SESSION_TIMEOUT_MINUTES * 60 });
  }catch(e){ 
    await logSystemEvent('LOGIN_ERROR', 'AUTH', null, null, null, { username }, 'FAILED', e.message, req);
    logSecurityEvent('LOGIN_ERROR', { username, error: e.message, ip: req.ip });
    res.status(500).json({error:'server_error'}); 
  }
});

app.post('/oauth/change-password-first',
  authLimiter,
  body('username').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('current_password').isLength({ min: 6 }).withMessage('Contraseña actual inválida'),
  body('new_password')
    .isLength({ min: 8 }).withMessage('Contraseña debe tener al menos 8 caracteres')
    .matches(/[A-Z]/).withMessage('Contraseña debe contener al menos una mayúscula')
    .matches(/[a-z]/).withMessage('Contraseña debe contener al menos una minúscula')
    .matches(/[0-9]/).withMessage('Contraseña debe contener al menos un número')
    .matches(/[!@#$%^&*]/).withMessage('Contraseña debe contener al menos un caracter especial (!@#$%^&*)'),
  handleValidationErrors,
  async (req, res) => {
    const { username, current_password, new_password } = req.body;
    try {
      const userResult = await pool.query('SELECT * FROM users WHERE email=$1', [username]);
      if (userResult.rowCount === 0) return res.status(400).json({ error: 'invalid_grant' });

      const user = userResult.rows[0];
      if (!user.must_change_password) {
        return res.status(400).json({ error: 'password_change_not_required' });
      }

      const matches = await bcrypt.compare(current_password, user.password);
      if (!matches) return res.status(400).json({ error: 'invalid_grant' });

      const hash = await bcrypt.hash(new_password, 10);

      // Calcular nueva fecha de expiración según política global
      const policyR = await pool.query("SELECT value FROM system_settings WHERE key='password_expiry_days'");
      const policyDays = policyR.rows.length ? parseInt(policyR.rows[0].value) || 0 : 0;

      await pool.query(
        `UPDATE users
         SET password=$1,
             must_change_password=FALSE,
             first_login_at=COALESCE(first_login_at, NOW()),
             password_expires_at=CASE WHEN $3>0 THEN NOW() + ($3 * INTERVAL '1 day') ELSE NULL END,
             updated_at=NOW()
         WHERE id=$2`,
        [hash, user.id, policyDays]
      );

      await logSystemEvent('USER_PASSWORD_CHANGED_FIRST_LOGIN', 'USER_MANAGEMENT', user.id, user.stripe_customer_id || null, null, {
        email: user.email, policy_days: policyDays
      }, 'SUCCESS', null, req);

      return res.json({ ok: true, message: 'Contraseña actualizada correctamente. Inicia sesión nuevamente.' });
    } catch (e) {
      return res.status(500).json({ error: 'server_error' });
    }
  }
);

// Refresh access token using refresh_token cookie with rate limiting
app.post('/oauth/refresh', authLimiter, async (req,res)=>{
  const rt = req.cookies['refresh_token'];
  if(!rt) {
    logSecurityEvent('REFRESH_FAILED', { reason: 'no_token', ip: req.ip });
    await logSystemEvent('REFRESH_FAILED', 'AUTH', null, null, null, { reason: 'no_token' }, 'FAILED', 'no_refresh_token', req);
    return res.status(401).json({error:'no_refresh_token'});
  }
  try{
    const r = await pool.query('SELECT * FROM refresh_tokens WHERE token=$1 AND revoked=false',[rt]);
    if(r.rowCount===0) {
      logSecurityEvent('REFRESH_FAILED', { reason: 'invalid_token', ip: req.ip });
      await logSystemEvent('REFRESH_FAILED', 'AUTH', null, null, null, { reason: 'invalid_token' }, 'FAILED', 'invalid_refresh', req);
      return res.status(401).json({error:'invalid_refresh'});
    }
    const row = r.rows[0];
    
    // Tope ABSOLUTO de la sesión (aunque haya actividad continua).
    const tokenAge = Date.now() - new Date(row.created_at).getTime();
    const maxAge = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    if(tokenAge > maxAge) {
      await pool.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1',[row.id]);
      logSecurityEvent('REFRESH_FAILED', { reason: 'expired_token', ip: req.ip });
      await logSystemEvent('REFRESH_FAILED', 'AUTH', row.user_id, null, null, { reason: 'expired_token' }, 'FAILED', 'token_expired', req);
      return res.status(401).json({error:'token_expired'});
    }

    // Inactividad (ventana deslizante): si pasó más de REFRESH_IDLE_MINUTES sin renovar,
    // la sesión expira por inactividad. last_used_at se desliza en cada refresh exitoso.
    const idleMs = Date.now() - new Date(row.last_used_at || row.created_at).getTime();
    if(idleMs > REFRESH_IDLE_MINUTES * 60 * 1000) {
      await pool.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1',[row.id]);
      logSecurityEvent('REFRESH_FAILED', { reason: 'idle_timeout', userId: row.user_id, ip: req.ip });
      await logSystemEvent('REFRESH_FAILED', 'AUTH', row.user_id, null, null, { reason: 'idle_timeout' }, 'FAILED', 'idle_timeout', req);
      return res.status(401).json({error:'idle_timeout'});
    }
    
    const u = await pool.query(
      `SELECT u.*, COALESCE(r.permissions, '{}'::jsonb) AS role_permissions, COALESCE(r.role_type, 'system_role') AS role_type
       FROM users u
       LEFT JOIN roles r ON r.name = u.role
       WHERE u.id=$1`,
      [row.user_id]
    );
    if(u.rowCount===0) {
      logSecurityEvent('REFRESH_FAILED', { reason: 'user_not_found', userId: row.user_id, ip: req.ip });
      await logSystemEvent('REFRESH_FAILED', 'AUTH', row.user_id, null, null, { reason: 'user_not_found' }, 'FAILED', 'user_not_found', req);
      return res.status(401).json({error:'user_not_found'});
    }
    const user = u.rows[0];
    const token = jwt.sign({
      sub:user.id,
      role:user.role,
      role_type: user.role_type || 'system_role',
      partner_id:user.partner_id,
      permissions: user.role_permissions || {},
      must_change_password:user.must_change_password
    }, JWT_SECRET, { expiresIn: `${SESSION_TIMEOUT_MINUTES}m` });

    // Deslizar la ventana de inactividad: marca este refresh como último uso.
    await pool.query('UPDATE refresh_tokens SET last_used_at = NOW() WHERE id=$1', [row.id]);

    logSecurityEvent('REFRESH_SUCCESS', { userId: user.id, email: user.email, ip: req.ip });
    await logSystemEvent('REFRESH_SUCCESS', 'AUTH', user.id, user.stripe_customer_id || null, null, { email: user.email }, 'SUCCESS', null, req);
    return res.json({ access_token: token, token_type: 'bearer', expires_in: SESSION_TIMEOUT_MINUTES * 60 });
  }catch(e){ 
    await logSystemEvent('REFRESH_ERROR', 'AUTH', null, null, null, {}, 'FAILED', e.message, req);
    logSecurityEvent('REFRESH_ERROR', { error: e.message, ip: req.ip });
    res.status(500).json({error:'server_error'}); 
  }
});

// Logout (revoke refresh token)
app.post('/oauth/logout', async (req,res)=>{
  const rt = req.cookies['refresh_token'];
  if(rt){
    try {
      await pool.query('UPDATE refresh_tokens SET revoked=true WHERE token=$1',[rt]);
      logSecurityEvent('LOGOUT_SUCCESS', { ip: req.ip });
      await logSystemEvent('LOGOUT_SUCCESS', 'AUTH', null, null, null, {}, 'SUCCESS', null, req);
    } catch(e) {
      logSecurityEvent('LOGOUT_ERROR', { error: e.message, ip: req.ip });
      await logSystemEvent('LOGOUT_ERROR', 'AUTH', null, null, null, {}, 'FAILED', e.message, req);
    }
    res.clearCookie('refresh_token');
  }
  res.json({ok:true});
});

// Create user (admin) with password policy
// Users (CRUD /admin/users) → src/modules/users
app.use(require('./src/modules/users/routes'));

// (rutas GET/GET:id/PUT/DELETE de /admin/users movidas a src/modules/users)

// Settings (política de contraseñas + configuración de activación) → src/modules/settings
app.use(require('./src/modules/settings/routes'));

// Email Templates (editor de plantillas de correo, versionado) → src/modules/email-templates
app.use(require('./src/modules/email-templates/routes'));

// Roles and permissions (admin only)

// Roles & permisos → src/modules/roles
app.use(require('./src/modules/roles/routes'));

// (rutas PUT/DELETE/permissions de roles movidas a src/modules/roles)

// (DELETE /admin/users/:id movido a src/modules/users)

// authenticate / requireRole / requirePermission / requireAnyPermission
// ahora viven en src/lib/auth.js (importados arriba).


// Health check endpoint
app.get('/health', (req, res) => {
  pool.query('SELECT 1', (err) => {
    if (err) {
      return res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
    }
    res.json({ status: 'healthy', database: 'connected', timestamp: new Date().toISOString() });
  });
});

// ============ SYSTEM EVENTS - AUDITORÍA ============

// Audit & Reports (eventos, auditoría de movimientos, reportería) → src/modules/audit-reports
app.use(require('./src/modules/audit-reports/routes'));

// convertToCSV / buildAuditMovementsCTE / buildAuditFilters → src/modules/audit-reports/routes.js

// (rutas /admin/audit/movements movidas a src/modules/audit-reports)

// (rutas /admin/reports/* movidas a src/modules/audit-reports)

// ── Manejo global de errores (después de TODAS las rutas) ──────────────────────
// 404 para rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// Error handler global: registra y responde sin filtrar el stack en producción.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('❌ Error no controlado:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const body = { error: 'internal_error' };
  if (process.env.NODE_ENV !== 'production') body.message = err && err.message;
  res.status(err && err.status ? err.status : 500).json(body);
});

// Handlers de proceso: registrar fallos en vez de morir en silencio.
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err && err.stack ? err.stack : err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing server gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Closing server gracefully...');
  await pool.end();
  process.exit(0);
});

module.exports = { app, pool };

const PORT = process.env.PORT || 8081;
/* istanbul ignore next */
if (require.main === module) app.listen(PORT, ()=> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🚀 CertJOIN Servicio-Usuarios');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`✓ Servidor escuchando en puerto: ${PORT}`);
  console.log(`✓ Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✓ Database: ${process.env.DB_NAME || 'proyectodb'}`);
  console.log(`✓ Frontend URL: ${FRONTEND_URL}`);
  console.log(`✓ JWT Token TTL: ${SESSION_TIMEOUT_MINUTES} minutos`);
  console.log(`✓ Refresh Token TTL: ${REFRESH_TOKEN_TTL_DAYS} días`);
  console.log(`✓ Rate Limit: ${process.env.MAX_LOGIN_ATTEMPTS || 5} intentos de login / ${process.env.RATE_LIMIT_WINDOW_MINUTES || 15} min`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('✓ Security features enabled:');
  console.log('  - Helmet security headers');
  console.log('  - Rate limiting');
  console.log('  - Input validation');
  console.log('  - CORS protection');
  console.log('  - Security logging');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Jobs en background (sync Moodle) ────────────────────────────────────────
  // Solo en la instancia con RUN_SCHEDULERS activo, para no duplicar al escalar.
  if (RUN_SCHEDULERS) {
    startSchedulers();
  } else {
    console.log('ℹ️ Schedulers desactivados en esta instancia (RUN_SCHEDULERS=false)');
  }
  // ────────────────────────────────────────────────────────────────────────────
})
