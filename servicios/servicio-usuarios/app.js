const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
require('dotenv').config();

const moodleService = require('./moodle-service');
const mailer = require('./mailer');
const { buildStudentWelcomeEmail } = require('./email-templates');

const MOODLE_PUBLIC_URL = (process.env.MOODLE_PUBLIC_URL || process.env.MOODLE_URL || '').replace(/\/$/, '');
const CAMPUS_URL = process.env.CAMPUS_URL || (MOODLE_PUBLIC_URL ? `${MOODLE_PUBLIC_URL}/login/index.php` : 'https://campus.certjoin.com/');

const app = express();

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

// Rate limiting for authentication endpoints — clave por username para no bloquear toda la IP
const authLimiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES) || 15) * 60 * 1000,
  max: parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const username = (req.body && (req.body.username || req.body.email || '')).toString().toLowerCase().trim();
    return username || req.ip;
  },
});

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => {
    const baseLimit = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

    // Usuarios autenticados tienen un cupo mayor para evitar bloqueos por navegación interna.
    if (req.user && req.user.role === 'admin') {
      return Math.max(baseLimit, 1200);
    }
    if (req.user && req.user.role === 'partner') {
      return Math.max(baseLimit, 600);
    }

    return baseLimit;
  },
  keyGenerator: (req) => {
    if (req.user && req.user.sub) {
      return `user:${req.user.sub}`;
    }
    return req.ip;
  },
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false
});

// DB Pool with connection limits
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432,
  database: process.env.DB_NAME || 'proyectodb',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'admin123',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Validate required environment variables
const requiredEnvVars = ['JWT_SECRET', 'ADMIN_PASSWORD'];
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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@certjoin.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS) || 7;
const SESSION_TIMEOUT_MINUTES = parseInt(process.env.SESSION_TIMEOUT_MINUTES) || 15;
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_XXXXXXXXXXXXXXXX');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const DEFAULT_CATALOG_COURSES = [
  { title: 'Curso Java', description: 'Certificación en Java', price: 199.00 },
  { title: 'Curso JS', description: 'Certificación en JavaScript', price: 149.00 },
  { title: 'Curso Python', description: 'Automatización y desarrollo backend con Python', price: 189.00 },
  { title: 'Curso Go', description: 'Servicios concurrentes y APIs de alto rendimiento con Go', price: 209.00 },
  { title: 'Curso Rust', description: 'Sistemas seguros y software de alto rendimiento con Rust', price: 219.00 },
  { title: 'Curso Node.js', description: 'APIs escalables y eventos con Node.js', price: 199.00 },
  { title: 'Arquitectura de Microservicios', description: 'Diseño distribuido, resiliencia y observabilidad', price: 249.00 },
  { title: 'Arquitectura Hexagonal', description: 'Puertos y adaptadores para sistemas mantenibles', price: 229.00 },
  { title: 'Arquitectura Event-Driven', description: 'Integración asíncrona con eventos y mensajería', price: 239.00 },
  { title: 'Arquitectura Cloud Native', description: 'Patrones modernos para despliegues en contenedores', price: 259.00 }
];

const DEFAULT_PRICING_PROFILES = [
  {
    code: 'base',
    name: 'Base',
    profile_type: 'CATEGORY',
    description: 'Categoría base para todos los partners',
    rules: [
      { min_qty: 1, max_qty: 5, unit_price: 100.00 },
      { min_qty: 6, max_qty: 20, unit_price: 90.00 },
      { min_qty: 21, max_qty: null, unit_price: 80.00 }
    ]
  }
];

const ROLE_TYPES = ['system_role', 'client_role'];
const ROLE_TYPE_LABELS = { system_role: 'Sistema', client_role: 'Cliente' };

// Each module declares which role types may hold a non-'none' permission.
// Add new modules here — nowhere else needs to change.
const ROLE_PERMISSION_MODULES = [
  { key: 'dashboard',     label: 'Dashboard',          types: ['system_role', 'client_role'] },
  { key: 'purchases',     label: 'Compras',            types: ['system_role', 'client_role'] },
  { key: 'users',         label: 'Usuarios',           types: ['system_role'] },
  { key: 'courses',       label: 'Certificaciones',    types: ['system_role', 'client_role'] },
  { key: 'pricing',       label: 'Pricing',            types: ['system_role'] },
  { key: 'stats',         label: 'Estadísticas',       types: ['system_role', 'client_role'] },
  { key: 'audit',         label: 'Auditoría',          types: ['system_role'] },
  { key: 'reports',       label: 'Reportería',         types: ['system_role'] },
  { key: 'financial_ops', label: 'Ops Financieras',    types: ['system_role'] },
];
const ROLE_PERMISSION_LEVELS = ['none', 'view', 'edit'];

function buildRolePermissionsDefault(level = 'none') {
  return ROLE_PERMISSION_MODULES.reduce((acc, mod) => {
    acc[mod.key] = level;
    return acc;
  }, {});
}

function getDefaultPermissionsForRole(roleName) {
  if (roleName === 'admin') return buildRolePermissionsDefault('edit');
  return buildRolePermissionsDefault('none');
}

// roleType controls which modules may hold non-'none' values.
function sanitizeRolePermissions(permissions, roleType = 'system_role') {
  const source = permissions && typeof permissions === 'object' && !Array.isArray(permissions) ? permissions : {};
  const sanitized = {};
  for (const mod of ROLE_PERMISSION_MODULES) {
    const value = source[mod.key] || 'none';
    const allowed = mod.types.includes(roleType);
    sanitized[mod.key] = (allowed && ROLE_PERMISSION_LEVELS.includes(value)) ? value : 'none';
  }
  return sanitized;
}

function normalizeRoleName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function getPermissionsByRole(roleName) {
  const result = await pool.query('SELECT permissions FROM roles WHERE name=$1 AND active=TRUE', [roleName]);
  if (result.rowCount === 0) return {};
  return result.rows[0].permissions || {};
}

function normalizePricingProfileCode(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || `profile_${Date.now()}`;
}

function normalizePricingRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('Debes configurar al menos una regla de precio');
  }

  const normalized = rules.map((rule, index) => {
    const minQty = parseInt(rule.min_qty, 10);
    const maxQty = rule.max_qty === '' || rule.max_qty === null || rule.max_qty === undefined
      ? null
      : parseInt(rule.max_qty, 10);
    const unitPrice = parseFloat(rule.unit_price);

    if (!Number.isInteger(minQty) || minQty < 1) {
      throw new Error(`La regla ${index + 1} tiene una cantidad mínima inválida`);
    }
    if (maxQty !== null && (!Number.isInteger(maxQty) || maxQty < minQty)) {
      throw new Error(`La regla ${index + 1} tiene una cantidad máxima inválida`);
    }
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error(`La regla ${index + 1} tiene un precio unitario inválido`);
    }

    return {
      min_qty: minQty,
      max_qty: maxQty,
      unit_price: Number(unitPrice.toFixed(2))
    };
  }).sort((a, b) => a.min_qty - b.min_qty);

  if (normalized[0].min_qty !== 1) {
    throw new Error('Las reglas deben comenzar desde cantidad 1');
  }

  for (let index = 0; index < normalized.length; index++) {
    const current = normalized[index];
    const next = normalized[index + 1];

    if (!next) {
      break;
    }

    if (current.max_qty === null) {
      throw new Error('Solo la última regla puede quedar abierta sin cantidad máxima');
    }

    if (next.min_qty !== current.max_qty + 1) {
      throw new Error('Las reglas deben ser continuas y sin traslapes entre cantidades');
    }
  }

  return normalized;
}

function generateTemporaryPassword(seed = 'partner') {
  const normalizedSeed = String(seed).replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'Partner';
  return `Tmp!${normalizedSeed}Aa1`;
}

function isMissingStripeCustomerError(error) {
  return Boolean(
    error &&
    error.type === 'StripeInvalidRequestError' &&
    error.statusCode === 400 &&
    typeof error.message === 'string' &&
    error.message.includes('No such customer')
  );
}

async function upsertStripeCustomerRecord(stripeCustomerId, email, name, partnerId = null, metadata = {}) {
  await pool.query(
    `INSERT INTO stripe_customers (stripe_customer_id, customer_email, customer_name, partner_id, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (stripe_customer_id)
     DO UPDATE SET customer_email=$2, customer_name=$3, partner_id=$4, metadata=$5, updated_at=NOW()`,
    [stripeCustomerId, email, name, partnerId, JSON.stringify(metadata)]
  );
}

async function ensureDefaultCatalogAndCourses() {
  for (const course of DEFAULT_CATALOG_COURSES) {
    await pool.query(
      `INSERT INTO catalogs (title, description, price)
       SELECT $1::varchar, $2::text, $3::numeric(10,2)
       WHERE NOT EXISTS (
         SELECT 1 FROM catalogs WHERE LOWER(title) = LOWER($1::varchar)
       )`,
      [course.title, course.description, course.price]
    );

    await pool.query(
      `INSERT INTO courses (name)
       SELECT $1::varchar
       WHERE NOT EXISTS (
         SELECT 1 FROM courses WHERE LOWER(name) = LOWER($1::varchar)
       )`,
      [course.title]
    );
  }
}

async function ensureDefaultPricingProfilesAndRules() {
  for (const profile of DEFAULT_PRICING_PROFILES) {
    const profileResult = await pool.query(
      `INSERT INTO pricing_profiles (code, name, profile_type, description, active, is_system, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, TRUE, NOW())
       ON CONFLICT (code)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         profile_type = EXCLUDED.profile_type,
         is_system = TRUE,
         updated_at = NOW()
       RETURNING id`,
      [profile.code, profile.name, profile.profile_type, profile.description]
    );

    const profileId = profileResult.rows[0].id;
    const ruleCount = await pool.query('SELECT COUNT(*) FROM pricing_rules WHERE profile_id=$1', [profileId]);

    if (parseInt(ruleCount.rows[0].count, 10) === 0) {
      for (const rule of profile.rules) {
        await pool.query(
          `INSERT INTO pricing_rules (profile_id, min_qty, max_qty, unit_price, active, updated_at)
           VALUES ($1, $2, $3, $4, TRUE, NOW())`,
          [profileId, rule.min_qty, rule.max_qty, rule.unit_price]
        );
      }
    }
  }

  // Migration: consolidate old CATEGORY profiles (silver/plate/gold) into single 'base'
  const baseProfile = await pool.query('SELECT id FROM pricing_profiles WHERE code=$1 LIMIT 1', ['base']);
  if (baseProfile.rowCount > 0) {
    const baseId = baseProfile.rows[0].id;
    await pool.query(
      `UPDATE partners SET pricing_profile_id=$1
       WHERE pricing_profile_id IN (SELECT id FROM pricing_profiles WHERE code IN ('silver','plate','gold') AND id <> $1)
          OR pricing_profile_id IS NULL`,
      [baseId]
    );
    await pool.query(
      `UPDATE pricing_profiles SET active=FALSE WHERE code IN ('silver','plate','gold')`
    );
  }
}

async function getPricingProfilesDetailed(profileType = null) {
  const params = [];
  let whereClause = '';

  if (profileType) {
    params.push(profileType);
    whereClause = 'WHERE profile_type = $1';
  }

  const profilesResult = await pool.query(
    `SELECT id, code, name, profile_type, description, active, is_system, created_at, updated_at
     FROM pricing_profiles
     ${whereClause}
     ORDER BY profile_type ASC, name ASC`,
    params
  );

  const rulesResult = await pool.query(
    `SELECT id, profile_id, min_qty, max_qty, unit_price, active, created_at, updated_at
     FROM pricing_rules
     ORDER BY profile_id ASC, min_qty ASC`
  );

  const rulesByProfile = new Map();
  for (const rule of rulesResult.rows) {
    if (!rulesByProfile.has(rule.profile_id)) {
      rulesByProfile.set(rule.profile_id, []);
    }
    rulesByProfile.get(rule.profile_id).push(rule);
  }

  return profilesResult.rows.map(profile => ({
    ...profile,
    rules: rulesByProfile.get(profile.id) || []
  }));
}

async function getPartnerPricingAssignment(partnerId) {
  const result = await pool.query(
    `SELECT p.id, p.name, p.email,
            p.pricing_profile_id, p.special_pricing_profile_id,
            base.code AS pricing_profile_code, base.name AS pricing_profile_name, base.profile_type AS pricing_profile_type,
            special.code AS special_pricing_profile_code, special.name AS special_pricing_profile_name, special.profile_type AS special_pricing_profile_type
     FROM partners p
     LEFT JOIN pricing_profiles base ON base.id = p.pricing_profile_id
     LEFT JOIN pricing_profiles special ON special.id = p.special_pricing_profile_id
     WHERE p.id = $1`,
    [partnerId]
  );

  if (result.rowCount === 0) {
    throw new Error('Partner no encontrado');
  }

  return result.rows[0];
}

async function getDefaultPricingProfileId() {
  const result = await pool.query('SELECT id FROM pricing_profiles WHERE code=$1 LIMIT 1', ['base']);
  return result.rowCount > 0 ? result.rows[0].id : null;
}

async function findMatchingPricingRule(profileId, qty) {
  const result = await pool.query(
    `SELECT r.id, r.profile_id, r.min_qty, r.max_qty, r.unit_price,
            p.code AS profile_code, p.name AS profile_name, p.profile_type
     FROM pricing_rules r
     INNER JOIN pricing_profiles p ON p.id = r.profile_id
     WHERE r.profile_id = $1
       AND r.active = TRUE
       AND r.min_qty <= $2
       AND (r.max_qty IS NULL OR r.max_qty >= $2)
     ORDER BY r.min_qty DESC
     LIMIT 1`,
    [profileId, qty]
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

async function getPartnerCumulativePaidQty(partnerId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(qty), 0) AS cumulative_qty
     FROM purchases
     WHERE partner_id = $1
       AND payment_method != 'complimentary'
       AND (status = 'PAID' OR stripe_status IN ('paid', 'succeeded'))`,
    [partnerId]
  );
  return parseInt(result.rows[0].cumulative_qty, 10);
}

async function resolvePartnerPricing(partnerId, qty, cumulativeOverride = null) {
  const quantity = parseInt(qty, 10);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Cantidad inválida para cálculo de precio');
  }

  // Cumulative historical paid qty determines the tier; current qty is added to it.
  const cumulativeQty = (cumulativeOverride !== null && cumulativeOverride !== undefined)
    ? parseInt(cumulativeOverride, 10)
    : await getPartnerCumulativePaidQty(partnerId);
  const lookupQty = cumulativeQty + quantity;

  const partner = await getPartnerPricingAssignment(partnerId);
  const defaultSilver = await pool.query(
    'SELECT id, code, name, profile_type FROM pricing_profiles WHERE code=$1 LIMIT 1',
    ['base']
  );

  const candidates = [];
  if (partner.special_pricing_profile_id) {
    candidates.push({
      source: 'SPECIAL',
      profile_id: partner.special_pricing_profile_id
    });
  }
  if (partner.pricing_profile_id) {
    candidates.push({
      source: 'CATEGORY',
      profile_id: partner.pricing_profile_id
    });
  }
  if (defaultSilver.rowCount > 0) {
    const fallbackId = defaultSilver.rows[0].id;
    if (!candidates.some(candidate => candidate.profile_id === fallbackId)) {
      candidates.push({
        source: 'DEFAULT',
        profile_id: fallbackId
      });
    }
  }

  for (const candidate of candidates) {
    const matchingRule = await findMatchingPricingRule(candidate.profile_id, lookupQty);
    if (!matchingRule) {
      continue;
    }

    const unitPrice = Number(parseFloat(matchingRule.unit_price).toFixed(2));
    const totalPrice = Number((unitPrice * quantity).toFixed(2));
    const qtyRange = matchingRule.max_qty === null
      ? `${matchingRule.min_qty}+`
      : `${matchingRule.min_qty}-${matchingRule.max_qty}`;

    return {
      partner_id: partner.id,
      partner_name: partner.name,
      quantity,
      cumulative_qty: cumulativeQty,
      lookup_qty: lookupQty,
      unit_price: unitPrice,
      total_price: totalPrice,
      pricing_source: candidate.source,
      pricing_profile_id: matchingRule.profile_id,
      pricing_profile_code: matchingRule.profile_code,
      pricing_profile_name: matchingRule.profile_name,
      pricing_rule_id: matchingRule.id,
      min_qty: matchingRule.min_qty,
      max_qty: matchingRule.max_qty,
      quantity_range: qtyRange,
      breakdown_message: `${matchingRule.profile_name} · tramo ${qtyRange} · ${unitPrice.toFixed(2)} por voucher`,
      cumulative_message: `${cumulativeQty} vouchers históricos · compra ${quantity} → tramo ${qtyRange}`,
      base_profile_name: partner.pricing_profile_name,
      special_profile_name: partner.special_pricing_profile_name
    };
  }

  throw new Error('No existe una regla de precio activa para esa cantidad');
}

// Security logging function
function logSecurityEvent(event, details) {
  const timestamp = new Date().toISOString();
  console.log(`[SECURITY] ${timestamp} - ${event}:`, JSON.stringify(details));
}

// Log system events to database for audit trail
async function logSystemEvent(eventType, eventCategory, userId, stripeCustomerId, purchaseId, eventData, status = 'SUCCESS', errorMessage = null, req = null) {
  try {
    const ipAddress = req ? req.ip : null;
    const userAgent = req ? req.get('user-agent') : null;
    
    await pool.query(
      `INSERT INTO system_events (event_type, event_category, user_id, stripe_customer_id, purchase_id, event_data, status, error_message, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [eventType, eventCategory, userId, stripeCustomerId, purchaseId, JSON.stringify(eventData), status, errorMessage, ipAddress, userAgent]
    );
    console.log(`✓ System event logged: ${eventType} (${eventCategory})`);
  } catch (e) {
    console.error('❌ Error logging system event:', e.message);
  }
}

/**
 * Envía el correo de bienvenida al estudiante cuando se crea su cuenta en Moodle.
 * No bloqueante e idempotente: nunca lanza, y no reenvía si email_status ya es 'SENT'.
 * Registra el resultado en activations (email_status/email_error/email_to/email_sent_at)
 * y en system_events.
 */
async function sendStudentWelcomeEmail({ activationId, to, studentName, courseName, username, tempPassword, months = null, expiresAt, userId = null, req = null }) {
  try {
    if (!to) return;

    // Idempotencia: no reenviar si ya se envió correctamente
    const prev = await pool.query('SELECT email_status FROM activations WHERE id=$1', [activationId]);
    if (prev.rowCount > 0 && prev.rows[0].email_status === 'SENT') return;

    const { subject, html, text } = buildStudentWelcomeEmail({
      studentName, email: to, courseName, username, tempPassword, months, expiresAt, campusUrl: CAMPUS_URL
    });

    const result = await mailer.sendMail({ to, subject, html, text });

    let emailStatus, emailError = null;
    if (result.sent)        emailStatus = 'SENT';
    else if (result.skipped) emailStatus = 'SKIPPED';
    else                     { emailStatus = 'FAILED'; emailError = result.error || 'error desconocido'; }

    const sentAt = result.sent ? new Date() : null;
    await pool.query(
      `UPDATE activations
       SET email_status=$1, email_error=$2, email_to=$3,
           email_sent_at = COALESCE($4::timestamp, email_sent_at)
       WHERE id=$5`,
      [emailStatus, emailError, to, sentAt, activationId]
    );

    await logSystemEvent(
      emailStatus === 'SENT' ? 'STUDENT_WELCOME_EMAIL_SENT' : `STUDENT_WELCOME_EMAIL_${emailStatus}`,
      'EMAIL', userId, null, null,
      { activation_id: activationId, to, course_name: courseName, reason: result.reason || null },
      emailStatus === 'FAILED' ? 'FAILED' : 'SUCCESS',
      emailError, req
    );
  } catch (e) {
    console.error(`❌ Error enviando correo de bienvenida (activation ${activationId}):`, e.message);
  }
}

// Log transaction state changes for audit trail
async function logTransactionEvent(purchaseId, newStatus, previousStatus, eventType, stripeEventId, stripeEventData, paymentIntentId, partnerId, metadata = null) {
  try {
    await pool.query(
      `INSERT INTO transaction_events (purchase_id, partner_id, payment_intent_id, previous_status, new_status, event_type, stripe_event_id, stripe_event_data, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [purchaseId, partnerId, paymentIntentId, previousStatus, newStatus, eventType, stripeEventId, JSON.stringify(stripeEventData || {}), JSON.stringify(metadata || {})]
    );
    console.log(`✓ Transaction event logged: Purchase ${purchaseId} - ${previousStatus} → ${newStatus} (${eventType})`);
  } catch (e) {
    console.error('❌ Error logging transaction event:', e.message);
  }
}

async function backfillPaidPurchaseVouchers(partnerId) {
  const paidPurchases = await pool.query(
    `SELECT id, partner_id, qty
     FROM purchases
     WHERE partner_id=$1
       AND (status='PAID' OR stripe_status IN ('succeeded', 'paid'))`,
    [partnerId]
  );

  let generated = 0;
  for (const p of paidPurchases.rows) {
    const existing = await pool.query('SELECT COUNT(*) AS cnt FROM vouchers WHERE purchase_id=$1', [p.id]);
    const currentCount = parseInt(existing.rows[0].cnt, 10) || 0;
    const missing = Math.max((p.qty || 0) - currentCount, 0);

    for (let i = 0; i < missing; i++) {
      const code = crypto.randomBytes(6).toString('hex').toUpperCase();
      await pool.query(
        'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
        [p.partner_id, p.id, code, 'AVAILABLE']
      );
      generated += 1;
    }
  }

  return generated;
}

// Synchronize user with Stripe - find or create customer
async function syncUserWithStripe(email, name, userId) {
  try {
    console.log(`🔍 Sincronizando usuario con Stripe: ${email}`);
    
    // Search for existing customer in Stripe
    const customers = await stripe.customers.list({ email: email, limit: 1 });
    
    let stripeCustomerId = null;
    
    let customerMetadata = {
      app_user_id: userId ? String(userId) : undefined,
      synced_at: new Date().toISOString()
    };

    if (customers.data && customers.data.length > 0) {
      stripeCustomerId = customers.data[0].id;
      customerMetadata = {
        ...customers.data[0].metadata,
        ...customerMetadata
      };
      console.log(`✅ Cliente Stripe encontrado: ${stripeCustomerId}`);
    } else {
      // Create new customer in Stripe
      const customer = await stripe.customers.create({
        email: email,
        name: name,
        metadata: customerMetadata
      });
      stripeCustomerId = customer.id;
      customerMetadata = customer.metadata || customerMetadata;
      console.log(`✨ Cliente Stripe creado: ${stripeCustomerId}`);
    }
    
    // Store the Stripe customer ID in our users table
    let partnerId = null;
    if (userId) {
      const updatedUser = await pool.query(
        'UPDATE users SET stripe_customer_id=$1, updated_at=NOW() WHERE id=$2 RETURNING partner_id',
        [stripeCustomerId, userId]
      );
      partnerId = updatedUser.rowCount > 0 ? updatedUser.rows[0].partner_id : null;
      console.log(`💾 Usuario actualizado con stripe_customer_id: ${stripeCustomerId}`);
    }

    await upsertStripeCustomerRecord(stripeCustomerId, email, name, partnerId, customerMetadata);
    
    return stripeCustomerId;
  } catch (e) {
    console.error('❌ Error sincronizando con Stripe:', e.message);
    throw e;
  }
}

async function upsertPartnerAndUserFromStripeCustomer(customer, source = 'STRIPE_SYNC', req = null) {
  if (!customer || !customer.id || !customer.email) {
    return { status: 'SKIPPED', reason: 'missing_required_customer_fields' };
  }

  const stripeCustomerId = customer.id;
  const email = customer.email.toLowerCase();
  const name = customer.name || email.split('@')[0] || `Partner ${stripeCustomerId.slice(-6)}`;
  const metadata = customer.metadata || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let userId = null;
    let partnerId = null;
    let createdUser = false;
    let createdPartner = false;

    if (metadata.app_user_id) {
      const byAppUserId = await client.query('SELECT id, partner_id FROM users WHERE id=$1', [metadata.app_user_id]);
      if (byAppUserId.rowCount > 0) {
        userId = byAppUserId.rows[0].id;
        partnerId = byAppUserId.rows[0].partner_id;
      }
    }

    if (!userId) {
      const byStripe = await client.query('SELECT id, partner_id FROM users WHERE stripe_customer_id=$1', [stripeCustomerId]);
      if (byStripe.rowCount > 0) {
        userId = byStripe.rows[0].id;
        partnerId = byStripe.rows[0].partner_id;
      }
    }

    if (!userId) {
      const byEmail = await client.query('SELECT id, partner_id FROM users WHERE email=$1', [email]);
      if (byEmail.rowCount > 0) {
        userId = byEmail.rows[0].id;
        partnerId = byEmail.rows[0].partner_id;
      }
    }

    if (!partnerId) {
      const partnerByStripe = await client.query('SELECT id FROM partners WHERE stripe_customer_id=$1', [stripeCustomerId]);
      if (partnerByStripe.rowCount > 0) {
        partnerId = partnerByStripe.rows[0].id;
      }
    }

    if (!partnerId) {
      const partnerByEmail = await client.query('SELECT id FROM partners WHERE email=$1', [email]);
      if (partnerByEmail.rowCount > 0) {
        partnerId = partnerByEmail.rows[0].id;
      }
    }

    if (!partnerId) {
      const defaultPricingProfileId = await getDefaultPricingProfileId();
      const createdPartnerResult = await client.query(
        'INSERT INTO partners (name, email, role, stripe_customer_id, pricing_profile_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [name, email, 'partner', stripeCustomerId, defaultPricingProfileId]
      );
      partnerId = createdPartnerResult.rows[0].id;
      createdPartner = true;
    } else {
      await client.query(
        'UPDATE partners SET name=$1, email=$2, stripe_customer_id=$3 WHERE id=$4',
        [name, email, stripeCustomerId, partnerId]
      );
    }

    let tempPassword = null;
    if (!userId) {
      tempPassword = generateTemporaryPassword(stripeCustomerId);
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const createdUserResult = await client.query(
        `INSERT INTO users (email, password, role, partner_id, stripe_customer_id, must_change_password, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
         RETURNING id`,
        [email, passwordHash, 'partner', partnerId, stripeCustomerId]
      );
      userId = createdUserResult.rows[0].id;
      createdUser = true;
    } else {
      await client.query(
        'UPDATE users SET role=$1, partner_id=$2, stripe_customer_id=$3, updated_at=NOW() WHERE id=$4',
        ['partner', partnerId, stripeCustomerId, userId]
      );
    }

    await client.query(
      `INSERT INTO stripe_customers (stripe_customer_id, customer_email, customer_name, partner_id, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_customer_id)
       DO UPDATE SET customer_email=$2, customer_name=$3, partner_id=$4, metadata=$5, updated_at=NOW()`,
      [stripeCustomerId, email, name, partnerId, JSON.stringify(metadata)]
    );

    await client.query('COMMIT');

    await logSystemEvent(
      createdUser ? 'STRIPE_CUSTOMER_SYNC_CREATED_USER' : 'STRIPE_CUSTOMER_SYNC_UPDATED_USER',
      'STRIPE_SYNC',
      userId,
      stripeCustomerId,
      null,
      {
        source,
        customer_email: email,
        partner_id: partnerId,
        created_user: createdUser,
        created_partner: createdPartner
      },
      'SUCCESS',
      null,
      req
    );

    return {
      status: createdUser ? 'CREATED' : 'UPDATED',
      user_id: userId,
      partner_id: partnerId,
      stripe_customer_id: stripeCustomerId,
      email,
      temp_password: tempPassword
    };
  } catch (e) {
    await client.query('ROLLBACK');
    await logSystemEvent(
      'STRIPE_CUSTOMER_SYNC_ERROR',
      'STRIPE_SYNC',
      null,
      customer.id,
      null,
      { source, customer_email: customer.email },
      'FAILED',
      e.message,
      req
    );
    throw e;
  } finally {
    client.release();
  }
}

async function syncAllStripeCustomersToPartners(req = null) {
  let hasMore = true;
  let startingAfter = null;
  const summary = {
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    details: []
  };

  while (hasMore) {
    const params = { limit: 100 };
    if (startingAfter) {
      params.starting_after = startingAfter;
    }

    const batch = await stripe.customers.list(params);
    for (const customer of batch.data) {
      try {
        const result = await upsertPartnerAndUserFromStripeCustomer(customer, 'STRIPE_BATCH_SYNC', req);
        summary.processed += 1;
        if (result.status === 'CREATED') summary.created += 1;
        else if (result.status === 'UPDATED') summary.updated += 1;
        else summary.skipped += 1;
        summary.details.push(result);
      } catch (e) {
        summary.processed += 1;
        summary.failed += 1;
        summary.details.push({
          status: 'FAILED',
          stripe_customer_id: customer.id,
          email: customer.email,
          error: e.message
        });
      }
    }

    hasMore = batch.has_more;
    if (batch.data.length > 0) {
      startingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  return summary;
}

const stripeSyncJobs = new Map();
let latestStripeSyncJobId = null;

function getStripeSyncJobResponse(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    summary: job.summary,
    error: job.error
  };
}

async function runStripeSyncJob(jobId) {
  const job = stripeSyncJobs.get(jobId);
  if (!job) return;

  job.status = 'running';
  job.started_at = new Date().toISOString();

  try {
    const summary = await syncAllStripeCustomersToPartners();
    job.status = 'completed';
    job.finished_at = new Date().toISOString();
    job.summary = summary;
  } catch (e) {
    job.status = 'failed';
    job.finished_at = new Date().toISOString();
    job.error = e.message;
    console.error('❌ Error en sync async de Stripe customers:', e);
  }
}

// Validation error handler
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logSecurityEvent('VALIDATION_ERROR', { errors: errors.array(), ip: req.ip });
    return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });
  }
  next();
}

async function initDb(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partners (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      email VARCHAR(200) UNIQUE NOT NULL,
      role VARCHAR(50) DEFAULT 'partner',
      stripe_customer_id VARCHAR(200) UNIQUE,
      pricing_profile_id INTEGER,
      special_pricing_profile_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pricing_profiles (
      id SERIAL PRIMARY KEY,
      code VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(200) NOT NULL,
      profile_type VARCHAR(20) NOT NULL DEFAULT 'CATEGORY',
      description TEXT,
      active BOOLEAN DEFAULT TRUE,
      is_system BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pricing_rules (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER NOT NULL REFERENCES pricing_profiles(id) ON DELETE CASCADE,
      min_qty INTEGER NOT NULL,
      max_qty INTEGER,
      unit_price NUMERIC(10,2) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      partner_id INTEGER REFERENCES partners(id),
      qty INTEGER NOT NULL,
      total_price NUMERIC(10,2) NOT NULL,
      stripe_link VARCHAR(500),
      stripe_session_id VARCHAR(200),
      status VARCHAR(50) DEFAULT 'PENDING',
      payment_intent_id VARCHAR(200),
      stripe_status VARCHAR(50) DEFAULT 'pending',
      pricing_details JSONB,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stripe_customers (
      id SERIAL PRIMARY KEY,
      stripe_customer_id VARCHAR(200) UNIQUE NOT NULL,
      customer_email VARCHAR(200),
      customer_name VARCHAR(200),
      partner_id INTEGER REFERENCES partners(id),
      metadata JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stripe_line_items (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER REFERENCES purchases(id),
      stripe_product_id VARCHAR(200),
      product_name VARCHAR(300),
      quantity INTEGER NOT NULL,
      unit_amount NUMERIC(10,2),
      total_amount NUMERIC(10,2),
      currency VARCHAR(10) DEFAULT 'usd',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id SERIAL PRIMARY KEY,
      partner_id INTEGER REFERENCES partners(id),
      purchase_id INTEGER REFERENCES purchases(id),
      code VARCHAR(100) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'AVAILABLE',
      course_id INTEGER,
      consumed_by VARCHAR(200),
      consumed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activations (
      id SERIAL PRIMARY KEY,
      voucher_id INTEGER REFERENCES vouchers(id),
      course_id INTEGER REFERENCES courses(id),
      user_name VARCHAR(200),
      user_email VARCHAR(200),
      final_client VARCHAR(200),
      activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS catalogs (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200),
      description TEXT,
      price NUMERIC(10,2)
    );
    
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(200) UNIQUE NOT NULL,
        password VARCHAR(200) NOT NULL,
        role VARCHAR(50) NOT NULL,
        partner_id INTEGER,
        stripe_customer_id VARCHAR(200) UNIQUE,
        must_change_password BOOLEAN DEFAULT FALSE,
        first_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        permissions JSONB DEFAULT '{}'::jsonb,
        active BOOLEAN DEFAULT TRUE,
        is_system BOOLEAN DEFAULT FALSE,
        role_type VARCHAR(20) DEFAULT 'system_role' NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        token VARCHAR(200) UNIQUE NOT NULL,
        revoked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transaction_events (
        id SERIAL PRIMARY KEY,
        purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
        partner_id INTEGER REFERENCES partners(id),
        payment_intent_id VARCHAR(200),
        previous_status VARCHAR(50),
        new_status VARCHAR(50) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        stripe_event_id VARCHAR(200),
        stripe_event_data JSONB,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_transaction_events_purchase ON transaction_events(purchase_id);
      CREATE INDEX IF NOT EXISTS idx_transaction_events_partner ON transaction_events(partner_id);
      CREATE INDEX IF NOT EXISTS idx_transaction_events_created ON transaction_events(created_at);

      -- Tablas de auditoría definidas también en init.sql. Se replican aquí en la
      -- migración de runtime para que el servicio se auto-sane en CADA arranque y
      -- no dependa de que init.sql corra (solo se ejecuta sobre volumen vacío).
      -- Sin esto, un volumen Postgres previo a estas tablas queda sin ellas y el
      -- módulo de auditoría falla con "relation does not exist".
      CREATE TABLE IF NOT EXISTS stripe_events (
        id SERIAL PRIMARY KEY,
        stripe_event_id VARCHAR(200) UNIQUE NOT NULL,
        event_type VARCHAR(100),
        event_data JSONB,
        processed BOOLEAN DEFAULT FALSE,
        processed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS system_events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        event_category VARCHAR(50) NOT NULL,
        user_id INTEGER REFERENCES users(id),
        stripe_customer_id VARCHAR(200),
        purchase_id INTEGER REFERENCES purchases(id),
        event_data JSONB,
        status VARCHAR(50) DEFAULT 'SUCCESS',
        error_message TEXT,
        ip_address VARCHAR(45),
        user_agent VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(200) UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_expires_at TIMESTAMP;

    ALTER TABLE roles ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
    ALTER TABLE roles ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE roles ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT FALSE;
    ALTER TABLE roles ADD COLUMN IF NOT EXISTS role_type VARCHAR(20) DEFAULT 'system_role';
    UPDATE roles SET role_type = 'system_role' WHERE role_type IS NULL;
    ALTER TABLE roles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    ALTER TABLE partners ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(200) UNIQUE;
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS pricing_profile_id INTEGER;
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS special_pricing_profile_id INTEGER;
    ALTER TABLE stripe_customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'PENDING';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_intent_id VARCHAR(200);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS stripe_status VARCHAR(50) DEFAULT 'pending';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(200);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS pricing_details JSONB;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS moodle_course_id INTEGER;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS course_id INTEGER;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS course_id INTEGER;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS final_client VARCHAR(200);
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_status VARCHAR(50) DEFAULT 'PENDING';
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_user_id INTEGER;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_error TEXT;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_enrolled_at TIMESTAMP;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_retried_at TIMESTAMP;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_retry_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_username VARCHAR(100);
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_temp_password VARCHAR(100);
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_completed_at TIMESTAMP;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS moodle_completion_synced_at TIMESTAMP;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS email_status VARCHAR(30);
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS email_error TEXT;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS email_to VARCHAR(200);
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMP;
    ALTER TABLE purchases   ADD COLUMN IF NOT EXISTS payment_method     VARCHAR(50) DEFAULT 'stripe';
    ALTER TABLE purchases   ADD COLUMN IF NOT EXISTS external_reference VARCHAR(200);
    ALTER TABLE purchases   ADD COLUMN IF NOT EXISTS notes              TEXT;
    ALTER TABLE vouchers    ADD COLUMN IF NOT EXISTS voucher_type             VARCHAR(20) DEFAULT 'STANDARD';
    ALTER TABLE vouchers    ADD COLUMN IF NOT EXISTS complimentary_reason     TEXT;
    ALTER TABLE vouchers    ADD COLUMN IF NOT EXISTS complimentary_issued_by  INTEGER;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS expires_at         TIMESTAMP;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS activation_status  VARCHAR(20) DEFAULT 'ACTIVE';

    CREATE TABLE IF NOT EXISTS partner_final_clients (
      id SERIAL PRIMARY KEY,
      partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_partners_pricing_profile_id'
      ) THEN
        ALTER TABLE partners ADD CONSTRAINT fk_partners_pricing_profile_id FOREIGN KEY (pricing_profile_id) REFERENCES pricing_profiles(id);
      END IF;
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_partners_special_pricing_profile_id'
      ) THEN
        ALTER TABLE partners ADD CONSTRAINT fk_partners_special_pricing_profile_id FOREIGN KEY (special_pricing_profile_id) REFERENCES pricing_profiles(id);
      END IF;
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_vouchers_course_id'
      ) THEN
        ALTER TABLE vouchers ADD CONSTRAINT fk_vouchers_course_id FOREIGN KEY (course_id) REFERENCES courses(id);
      END IF;
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_activations_course_id'
      ) THEN
        ALTER TABLE activations ADD CONSTRAINT fk_activations_course_id FOREIGN KEY (course_id) REFERENCES courses(id);
      END IF;
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END $$;
  `);

  // Tabla de configuración global del sistema
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      description TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO system_settings (key, value, description)
    VALUES ('password_expiry_days', '0', 'Días de validez de contraseña. 0 = sin caducidad')
    ON CONFLICT (key) DO NOTHING;
    INSERT INTO system_settings (key, value, description)
    VALUES ('max_activation_months', '12', 'Meses máximos de disponibilidad de una activación de voucher')
    ON CONFLICT (key) DO NOTHING;
  `);

  const roleSeeds = [
    { name: 'admin',   display_name: 'Administrador', is_system: true, role_type: 'system_role' },
    { name: 'partner', display_name: 'Partner',        is_system: true, role_type: 'client_role' },
    { name: 'user',    display_name: 'Usuario',        is_system: true, role_type: 'client_role' }
  ];

  for (const role of roleSeeds) {
    const permissions = sanitizeRolePermissions(getDefaultPermissionsForRole(role.name), role.role_type);
    await pool.query(
      `INSERT INTO roles (name, display_name, permissions, active, is_system, role_type, updated_at)
       VALUES ($1, $2, $3::jsonb, TRUE, $4, $5, NOW())
       ON CONFLICT (name) DO NOTHING`,
      [role.name, role.display_name, JSON.stringify(permissions), role.is_system, role.role_type]
    );
    // Backfill role_type for existing rows and fill any missing module keys
    const existing = await pool.query('SELECT permissions, role_type FROM roles WHERE name=$1', [role.name]);
    if (existing.rows.length > 0) {
      const existingPerms = existing.rows[0].permissions || {};
      const merged = { ...permissions, ...existingPerms };
      const needsPermUpdate = Object.keys(merged).length !== Object.keys(existingPerms).length;
      const needsTypeUpdate = !existing.rows[0].role_type;
      if (needsPermUpdate || needsTypeUpdate) {
        await pool.query(
          `UPDATE roles SET permissions=$1::jsonb, role_type=COALESCE(NULLIF(role_type,''), $2) WHERE name=$3`,
          [JSON.stringify(merged), role.role_type, role.name]
        );
      }
    }
  }

  const distinctUserRoles = await pool.query("SELECT DISTINCT role FROM users WHERE role IS NOT NULL AND TRIM(role) <> ''");
  for (const row of distinctUserRoles.rows) {
    const normalizedRole = normalizeRoleName(row.role);
    if (!normalizedRole) continue;
    const permissions = sanitizeRolePermissions(getDefaultPermissionsForRole(normalizedRole));
    await pool.query(
      `INSERT INTO roles (name, display_name, permissions, active, is_system, updated_at)
       VALUES ($1, $2, $3::jsonb, TRUE, FALSE, NOW())
       ON CONFLICT (name) DO NOTHING`,
      [normalizedRole, normalizedRole.charAt(0).toUpperCase() + normalizedRole.slice(1), JSON.stringify(permissions)]
    );
    await pool.query('UPDATE users SET role=$1 WHERE role=$2', [normalizedRole, row.role]);
  }

  await ensureDefaultCatalogAndCourses();
  await ensureDefaultPricingProfilesAndRules();

  // Seed admin user if none
  const u = await pool.query("SELECT count(*) FROM users WHERE role='admin'");
  if(parseInt(u.rows[0].count) === 0){
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query('INSERT INTO users (email,password,role) VALUES ($1,$2,$3)',[ADMIN_EMAIL,hash,'admin']);
    console.log('Seeded admin user:', ADMIN_EMAIL);
  }

  // Seed a demo partner and partner user if none
  const pc = await pool.query('SELECT count(*) FROM partners');
  let partnerId = null;
  const partnerEmail = process.env.PARTNER_EMAIL || 'partner@certjoin.com';
  if(parseInt(pc.rows[0].count) === 0){
    const defaultPricingProfileId = await getDefaultPricingProfileId();
    const pr = await pool.query('INSERT INTO partners (name,email,pricing_profile_id) VALUES ($1,$2,$3) RETURNING id',[ 'Demo Partner', partnerEmail, defaultPricingProfileId ]);
    partnerId = pr.rows[0].id;
    console.log('Seeded partner id:', partnerId);
  } else {
    const pr2 = await pool.query('SELECT id FROM partners LIMIT 1');
    partnerId = pr2.rows[0].id;
  }

  const pu = await pool.query("SELECT count(*) FROM users WHERE role='partner'");
  if(parseInt(pu.rows[0].count) === 0){
    const partnerPassword = process.env.PARTNER_PASSWORD || 'partner123';
    const phash = await bcrypt.hash(partnerPassword, 10);
    await pool.query('INSERT INTO users (email,password,role,partner_id,must_change_password) VALUES ($1,$2,$3,$4,$5)',[partnerEmail,phash,'partner',partnerId,false]);
    console.log('Seeded partner user:', partnerEmail);
  }
}

initDb().catch(err=>{ console.error('DB init error', err); process.exit(1); });

// ── Job automático: sincronizar completaciones Moodle cada 6 horas ────────────
const COMPLETION_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h
/* istanbul ignore next */
if (require.main === module) {
  // Primera ejecución 5 min después del arranque (espera a que todo esté listo)
  setTimeout(async () => {
    try {
      console.log('⏱ [MOODLE] Inicio sincronización automática de completaciones...');
      const r = await syncMoodleCompletions();
      console.log(`✓ [MOODLE] Sync completaciones: checked=${r.checked} completed=${r.completed} errors=${r.errors}`);
    } catch (e) {
      console.error('❌ [MOODLE] Error en sync automático de completaciones:', e.message);
    }

    // Luego cada 6 horas
    setInterval(async () => {
      try {
        console.log('⏱ [MOODLE] Sincronizando completaciones...');
        const r = await syncMoodleCompletions();
        console.log(`✓ [MOODLE] Sync completaciones: checked=${r.checked} completed=${r.completed} errors=${r.errors}`);
      } catch (e) {
        console.error('❌ [MOODLE] Error en sync automático de completaciones:', e.message);
      }
    }, COMPLETION_SYNC_INTERVAL_MS);
  }, 5 * 60 * 1000);
}

// Admin: create partner with validation
app.post('/admin/partners', 
  authenticate, 
  requireRole('admin'),
  apiLimiter,
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nombre debe tener entre 2 y 100 caracteres'),
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  handleValidationErrors,
  async (req,res)=>{
  const { name, email } = req.body;
  try{
    // Check if email already exists
    const existing = await pool.query('SELECT id FROM partners WHERE email=$1',[email]);
    if(existing.rowCount > 0) {
      await logSystemEvent('PARTNER_CREATE_ERROR', 'PARTNER_MANAGEMENT', req.user.sub, null, null, { email, reason: 'email_exists' }, 'FAILED', 'Email ya registrado', req);
      return res.status(400).json({error:'Email ya registrado'});
    }
    const defaultProfileId = await getDefaultPricingProfileId();
    const r = await pool.query(
      'INSERT INTO partners (name,email,pricing_profile_id) VALUES ($1,$2,$3) RETURNING *',
      [name, email, defaultProfileId]
    );
    await logSystemEvent('PARTNER_CREATED', 'PARTNER_MANAGEMENT', req.user.sub, null, null, {
      partner_id: r.rows[0].id,
      partner_name: r.rows[0].name,
      partner_email: r.rows[0].email
    }, 'SUCCESS', null, req);
    logSecurityEvent('PARTNER_CREATED', { partnerId: r.rows[0].id, email, adminId: req.user.sub });
    res.json(r.rows[0]);
  }catch(e){ 
    await logSystemEvent('PARTNER_CREATE_ERROR', 'PARTNER_MANAGEMENT', req.user.sub, null, null, { name, email }, 'FAILED', e.message, req);
    logSecurityEvent('PARTNER_CREATE_ERROR', { error: e.message, adminId: req.user.sub });
    res.status(400).json({error:'Error al crear partner'}); 
  }
});

// Admin: list partners
app.get('/admin/partners', authenticate, requireRole('admin'), apiLimiter, async (req,res)=>{
  try{
    console.log('📋 GET /admin/partners - Query params:', req.query);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    console.log('📋 Fetching partners - page:', page, 'limit:', limit, 'offset:', offset);
    
    const countResult = await pool.query('SELECT COUNT(*) FROM partners');
    const totalCount = parseInt(countResult.rows[0].count);
    
    console.log('📋 Total partners in DB:', totalCount);
    
    const r = await pool.query(
      `SELECT p.id, p.name, p.email, p.created_at,
              p.pricing_profile_id, p.special_pricing_profile_id,
              base.name AS pricing_profile_name, base.code AS pricing_profile_code,
              special.name AS special_pricing_profile_name, special.code AS special_pricing_profile_code
       FROM partners p
       LEFT JOIN pricing_profiles base ON base.id = p.pricing_profile_id
       LEFT JOIN pricing_profiles special ON special.id = p.special_pricing_profile_id
       ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    console.log('📋 Returned partners:', r.rows.length);
    
    res.json({
      data: r.rows,
      pagination: {
        page,
        limit,
        total: totalCount,
        pages: Math.ceil(totalCount / limit)
      }
    });
  }catch(e){ 
    console.error('❌ Error getting partners:', e);
    res.status(400).json({error:'Error al obtener partners'}); 
  }
});

app.get('/admin/pricing/profiles', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const profiles = await getPricingProfilesDetailed();
    res.json(profiles);
  } catch (e) {
    res.status(400).json({ error: 'Error al obtener perfiles de pricing' });
  }
});

app.post('/admin/pricing/profiles', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const { name, code, description, profile_type } = req.body || {};

  try {
    const profileName = String(name || '').trim();
    const profileType = String(profile_type || 'SPECIAL').trim().toUpperCase();
    if (!profileName) {
      return res.status(400).json({ error: 'Nombre del perfil es obligatorio' });
    }
    if (!['SPECIAL', 'CATEGORY'].includes(profileType)) {
      return res.status(400).json({ error: 'Tipo de perfil inválido' });
    }

    const normalizedCode = normalizePricingProfileCode(code || profileName);
    const created = await pool.query(
      `INSERT INTO pricing_profiles (code, name, profile_type, description, active, is_system, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, FALSE, NOW())
       RETURNING id, code, name, profile_type, description, active, is_system`,
      [normalizedCode, profileName, profileType, description || null]
    );

    await logSystemEvent('PRICING_PROFILE_CREATED', 'PRICING', req.user.sub, null, null, {
      profile_id: created.rows[0].id,
      code: created.rows[0].code,
      name: created.rows[0].name,
      profile_type: created.rows[0].profile_type
    }, 'SUCCESS', null, req);

    res.status(201).json(created.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      await logSystemEvent('PRICING_PROFILE_CREATE_ERROR', 'PRICING', req.user.sub, null, null, { code, name, profile_type }, 'FAILED', 'Ya existe un perfil con ese código', req);
      return res.status(400).json({ error: 'Ya existe un perfil con ese código' });
    }
    await logSystemEvent('PRICING_PROFILE_CREATE_ERROR', 'PRICING', req.user.sub, null, null, { code, name, profile_type }, 'FAILED', e.message, req);
    res.status(400).json({ error: 'Error al crear perfil de pricing' });
  }
});

app.put('/admin/pricing/profiles/:id', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const { name, description, active, rules } = req.body || {};

  if (!Number.isInteger(profileId) || profileId < 1) {
    return res.status(400).json({ error: 'Perfil inválido' });
  }

  try {
    const normalizedRules = normalizePricingRules(rules || []);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        'SELECT id, code, name, profile_type, active, is_system FROM pricing_profiles WHERE id=$1',
        [profileId]
      );
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Perfil no encontrado' });
      }

      const profile = existing.rows[0];
      await client.query(
        `UPDATE pricing_profiles
         SET name=$1,
             description=$2,
             active=$3,
             updated_at=NOW()
         WHERE id=$4`,
        [String(name || profile.name).trim() || profile.name, description || null, active !== false, profileId]
      );

      await client.query('DELETE FROM pricing_rules WHERE profile_id=$1', [profileId]);
      for (const rule of normalizedRules) {
        await client.query(
          `INSERT INTO pricing_rules (profile_id, min_qty, max_qty, unit_price, active, updated_at)
           VALUES ($1, $2, $3, $4, TRUE, NOW())`,
          [profileId, rule.min_qty, rule.max_qty, rule.unit_price]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const profiles = await getPricingProfilesDetailed();
    const updated = profiles.find(profile => profile.id === profileId);

    await logSystemEvent('PRICING_PROFILE_UPDATED', 'PRICING', req.user.sub, null, null, {
      profile_id: profileId,
      name: updated ? updated.name : null,
      active: updated ? updated.active : null,
      rules_count: Array.isArray(normalizedRules) ? normalizedRules.length : 0
    }, 'SUCCESS', null, req);

    res.json(updated);
  } catch (e) {
    await logSystemEvent('PRICING_PROFILE_UPDATE_ERROR', 'PRICING', req.user.sub, null, null, { profile_id: profileId }, 'FAILED', e.message, req);
    res.status(400).json({ error: e.message || 'Error al actualizar perfil de pricing' });
  }
});

app.get('/admin/partners/:id/pricing', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const partnerId = parseInt(req.params.id, 10);
  if (!Number.isInteger(partnerId) || partnerId < 1) {
    return res.status(400).json({ error: 'Partner inválido' });
  }

  try {
    const partner = await getPartnerPricingAssignment(partnerId);
    const cumulativeQty = await getPartnerCumulativePaidQty(partnerId);
    const [sampleQty1, sampleQty10, sampleQty25] = await Promise.all([
      resolvePartnerPricing(partnerId, 1,  cumulativeQty),
      resolvePartnerPricing(partnerId, 10, cumulativeQty),
      resolvePartnerPricing(partnerId, 25, cumulativeQty)
    ]);

    res.json({
      partner,
      cumulative_qty: cumulativeQty,
      samples: [sampleQty1, sampleQty10, sampleQty25]
    });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al obtener pricing del partner' });
  }
});

app.put('/admin/partners/:id/pricing', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const partnerId = parseInt(req.params.id, 10);
  const baseProfileId = req.body && req.body.pricing_profile_id !== undefined && req.body.pricing_profile_id !== null && req.body.pricing_profile_id !== ''
    ? parseInt(req.body.pricing_profile_id, 10)
    : null;
  const specialProfileId = req.body && req.body.special_pricing_profile_id !== undefined && req.body.special_pricing_profile_id !== null && req.body.special_pricing_profile_id !== ''
    ? parseInt(req.body.special_pricing_profile_id, 10)
    : null;

  if (!Number.isInteger(partnerId) || partnerId < 1) {
    return res.status(400).json({ error: 'Partner inválido' });
  }
  if (!Number.isInteger(baseProfileId) || baseProfileId < 1) {
    return res.status(400).json({ error: 'La categoría base es obligatoria' });
  }

  try {
    const profileChecks = await pool.query(
      'SELECT id, profile_type FROM pricing_profiles WHERE id = ANY($1::int[])',
      [[baseProfileId, ...(specialProfileId ? [specialProfileId] : [])]]
    );

    const profileMap = new Map(profileChecks.rows.map(row => [row.id, row.profile_type]));
    if (profileMap.get(baseProfileId) !== 'CATEGORY') {
      return res.status(400).json({ error: 'La categoría base debe ser un perfil de tipo CATEGORY' });
    }
    if (specialProfileId && profileMap.get(specialProfileId) !== 'SPECIAL') {
      return res.status(400).json({ error: 'El precio especial debe ser un perfil de tipo SPECIAL' });
    }

    const updated = await pool.query(
      `UPDATE partners
       SET pricing_profile_id=$1,
           special_pricing_profile_id=$2
       WHERE id=$3
       RETURNING id`,
      [baseProfileId, specialProfileId, partnerId]
    );

    if (updated.rowCount === 0) {
      return res.status(404).json({ error: 'Partner no encontrado' });
    }

    const partner = await getPartnerPricingAssignment(partnerId);
    await logSystemEvent('PARTNER_PRICING_UPDATED', 'PRICING', req.user.sub, null, null, {
      partner_id: partnerId,
      pricing_profile_id: baseProfileId,
      special_pricing_profile_id: specialProfileId || null
    }, 'SUCCESS', null, req);
    res.json(partner);
  } catch (e) {
    await logSystemEvent('PARTNER_PRICING_UPDATE_ERROR', 'PRICING', req.user.sub, null, null, {
      partner_id: partnerId,
      pricing_profile_id: baseProfileId,
      special_pricing_profile_id: specialProfileId || null
    }, 'FAILED', e.message, req);
    res.status(400).json({ error: e.message || 'Error al guardar pricing del partner' });
  }
});

app.post('/admin/stripe/sync-customers', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const summary = await syncAllStripeCustomersToPartners(req);
    res.json({ ok: true, summary });
  } catch (e) {
    console.error('❌ Error sincronizando clientes de Stripe:', e);
    res.status(500).json({ error: 'Error al sincronizar clientes de Stripe', detail: e.message });
  }
});

app.post('/admin/stripe/sync-customers/async', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const jobId = uuidv4();
  const job = {
    job_id: jobId,
    status: 'queued',
    started_at: null,
    finished_at: null,
    summary: null,
    error: null
  };

  stripeSyncJobs.set(jobId, job);
  latestStripeSyncJobId = jobId;

  setImmediate(() => {
    runStripeSyncJob(jobId);
  });

  res.status(202).json({
    ok: true,
    message: 'Sincronización iniciada en segundo plano',
    job: getStripeSyncJobResponse(job),
    status_endpoint: `/admin/stripe/sync-customers/async/${jobId}`
  });
});

app.get('/admin/stripe/sync-customers/async/latest', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  if (!latestStripeSyncJobId) {
    return res.status(404).json({ error: 'No hay jobs de sincronización registrados' });
  }

  const job = stripeSyncJobs.get(latestStripeSyncJobId);
  if (!job) {
    return res.status(404).json({ error: 'Job no encontrado' });
  }

  return res.json({ ok: true, job: getStripeSyncJobResponse(job) });
});

app.get('/admin/stripe/sync-customers/async/:jobId', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const { jobId } = req.params;
  const job = stripeSyncJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job no encontrado' });
  }

  return res.json({ ok: true, job: getStripeSyncJobResponse(job) });
});

// Admin: create purchase (generate stripe link)
app.post('/admin/purchases', authenticate, requireRole('admin'), async (req,res)=>{
  const { partner_id, qty } = req.body;
  const link = `https://fake-stripe/pay/${uuidv4()}`;
  const expires = new Date(Date.now() + 1000*60*60).toISOString();
  try{
    const pricing = await resolvePartnerPricing(partner_id, qty);
    const r = await pool.query(
      'INSERT INTO purchases (partner_id,qty,total_price,stripe_link,expires_at,pricing_details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [partner_id, qty, pricing.total_price.toFixed(2), link, expires, JSON.stringify(pricing)]
    );
    await logSystemEvent('PURCHASE_CREATED_ADMIN', 'PURCHASE', req.user.sub, null, r.rows[0].id, {
      partner_id,
      qty,
      total_price: pricing.total_price
    }, 'SUCCESS', null, req);
    res.json(r.rows[0]);
  }catch(e){
    await logSystemEvent('PURCHASE_CREATE_ADMIN_ERROR', 'PURCHASE', req.user.sub, null, null, { partner_id, qty }, 'FAILED', e.message, req);
    res.status(400).json({error:e.message});
  }
});

// Partner: create purchase (partner inicia compra para su partner_id)
app.post('/partner/:id/purchases', authenticate, async (req,res)=>{
  const pid = req.params.id;
  // allow if admin OR if authenticated partner and partner_id matches
  if(req.user && req.user.role === 'partner'){
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid)) return res.status(403).json({ error: 'forbidden' });
  } else if(req.user && req.user.role !== 'admin'){
    return res.status(403).json({ error: 'forbidden' });
  }

  const { qty, descriptor, payment_method } = req.body || {};
  const q = parseInt(qty) || 0;
  if(q <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

  let pricing;
  try {
    pricing = await resolvePartnerPricing(pid, q);
  } catch (pricingError) {
    return res.status(400).json({ error: pricingError.message });
  }
  // generate fake stripe link (simulación de pasarela en modo desarrollador)
  const link = `https://fake-stripe/pay/${uuidv4()}`;
  const expires = new Date(Date.now() + 1000*60*60).toISOString();

  try{
    // Do NOT store raw payment_method details in DB. We accept them to forward to gateway in a real integration.
    // Store descriptor if provided (we'll reuse existing stripe_link field to keep schema simple) - better would be an extra column.
    const r = await pool.query(
      'INSERT INTO purchases (partner_id,qty,total_price,stripe_link,expires_at,pricing_details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [pid, q, pricing.total_price.toFixed(2), link, expires, JSON.stringify(pricing)]
    );
    // Return the created purchase and the link for frontend to redirect to pasarela
    if(r.rows && r.rows.length > 0){
      await logSystemEvent('PURCHASE_CREATED_PARTNER', 'PURCHASE', req.user.sub, null, r.rows[0].id, {
        partner_id: pid,
        qty: q,
        total_price: pricing.total_price
      }, 'SUCCESS', null, req);
      res.status(201).json(r.rows[0]);
    } else {
      res.status(400).json({error:'No se pudo crear la compra'});
    }
  }catch(e){ 
    await logSystemEvent('PURCHASE_CREATE_PARTNER_ERROR', 'PURCHASE', req.user.sub, null, null, { partner_id: pid, qty: q }, 'FAILED', e.message, req);
    console.error('Purchase creation error:', e);
    res.status(400).json({error:e.message}); 
  }
});

// Partner: create Stripe Checkout session and purchase record with validation
app.post('/partner/:id/checkout', 
  authenticate,
  apiLimiter,
  param('id').isInt().withMessage('Partner ID inválido'),
  body('qty').isInt({ min: 1, max: 1000 }).withMessage('Cantidad debe estar entre 1 y 1000'),
  body('descriptor').optional().trim().isLength({ max: 200 }).withMessage('Descriptor muy largo'),
  handleValidationErrors,
  async (req,res)=>{
  const pid = req.params.id;
  
  // Authorization check
  if(req.user && req.user.role === 'partner'){
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      logSecurityEvent('CHECKOUT_UNAUTHORIZED', { userId: req.user.sub, attemptedPartnerId: pid, ip: req.ip });
      return res.status(403).json({ error: 'forbidden' });
    }
  } else if(req.user && req.user.role !== 'admin'){
    logSecurityEvent('CHECKOUT_UNAUTHORIZED', { userId: req.user.sub, role: req.user.role, ip: req.ip });
    return res.status(403).json({ error: 'forbidden' });
  }

  const { qty, descriptor } = req.body || {};
  const q = parseInt(qty);

  let pricing;
  try {
    pricing = await resolvePartnerPricing(pid, q);
  } catch (pricingError) {
    return res.status(400).json({ error: pricingError.message });
  }

  const expires = new Date(Date.now() + 1000*60*60).toISOString();

  try{
    const userResult = await pool.query(
      'SELECT id, email, stripe_customer_id, must_change_password FROM users WHERE id=$1',
      [req.user.sub]
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const currentUser = userResult.rows[0];
    if (currentUser.must_change_password) {
      return res.status(403).json({ error: 'password_change_required', message: 'Debes cambiar tu contraseña antes de comprar' });
    }

    let stripeCustomerId = currentUser.stripe_customer_id;
    if (!stripeCustomerId) {
      stripeCustomerId = await syncUserWithStripe(currentUser.email, currentUser.email.split('@')[0], currentUser.id);
    }

    // create purchase record first (status PENDING)
    const p = await pool.query(
      'INSERT INTO purchases (partner_id,qty,total_price,stripe_status,expires_at,pricing_details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [pid, q, pricing.total_price.toFixed(2), 'pending', expires, JSON.stringify(pricing)]
    );
    const purchase = p.rows[0];

    // create Stripe Checkout session
    const sessionPayload = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: descriptor || `Vouchers x${q}` },
          unit_amount: Math.round(parseFloat(pricing.total_price) * 100)
        },
        quantity: 1
      }],
      mode: 'payment',
      customer: stripeCustomerId,
      success_url: `${FRONTEND_URL}/?checkout=success&purchase_id=${purchase.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?checkout=cancel&purchase_id=${purchase.id}`,
      payment_intent_data: {
        metadata: {
          purchase_id: String(purchase.id),
          partner_id: String(pid),
          app_user_id: String(currentUser.id)
        }
      },
      metadata: { 
        purchase_id: String(purchase.id), 
        partner_id: String(pid),
        app_user_id: String(currentUser.id)
      }
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionPayload);
    } catch (stripeError) {
      if (!isMissingStripeCustomerError(stripeError)) {
        throw stripeError;
      }

      console.warn(`⚠️ Stripe customer inválido para usuario ${currentUser.id}. Re-sincronizando customer antes de reintentar checkout.`);
      stripeCustomerId = await syncUserWithStripe(currentUser.email, currentUser.email.split('@')[0], currentUser.id);
      sessionPayload.customer = stripeCustomerId;
      session = await stripe.checkout.sessions.create(sessionPayload);
    }

    // update purchase record with stripe payment intent id
    await pool.query(
      'UPDATE purchases SET payment_intent_id=$1, stripe_link=$2, stripe_session_id=$3, updated_at=NOW() WHERE id=$4',
      [session.payment_intent || null, session.url, session.id, purchase.id]
    );

    logSecurityEvent('CHECKOUT_CREATED', { purchaseId: purchase.id, partnerId: pid, qty: q, total: pricing.total_price, userId: req.user.sub });
    await logSystemEvent('CHECKOUT_CREATED', 'PURCHASE', req.user.sub, stripeCustomerId || null, purchase.id, {
      partner_id: pid,
      qty: q,
      total_price: pricing.total_price,
      stripe_session_id: session.id
    }, 'SUCCESS', null, req);
    return res.status(201).json({ url: session.url, purchase_id: purchase.id, session_id: session.id });
  }catch(e){
    await logSystemEvent('CHECKOUT_CREATE_ERROR', 'PURCHASE', req.user ? req.user.sub : null, null, null, {
      partner_id: pid,
      qty: q
    }, 'FAILED', e.message, req);
    logSecurityEvent('CHECKOUT_ERROR', { error: e.message, partnerId: pid, userId: req.user.sub });
    console.error('Checkout error', e);
    return res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
});;

// Stripe Webhook - Enhanced for Stripe-first flow
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      if (process.env.NODE_ENV === 'production') {
        console.error('❌ STRIPE_WEBHOOK_SECRET no configurado en produccion. Webhook rechazado.');
        return res.status(500).send('Webhook configuration error');
      }
      console.warn('⚠️ WARNING: STRIPE_WEBHOOK_SECRET not configured. Webhook verification skipped (development only)');
      event = JSON.parse(req.body);
    } else {
      if (!sig) {
        console.error('❌ Webhook recibido sin cabecera stripe-signature');
        return res.status(400).send('Missing stripe-signature header');
      }
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    }
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('📨 Stripe Webhook received:', event.type, 'ID:', event.id);

  try {
    // Store event for audit trail
    await pool.query(
      `INSERT INTO stripe_events (stripe_event_id, event_type, event_data) 
       VALUES ($1, $2, $3)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [event.id, event.type, JSON.stringify(event.data)]
    );

    switch (event.type) {
      // ✅ PAYMENT SUCCESSFUL
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        console.log('✅ Payment succeeded:', paymentIntent.id);

        const purchaseId = paymentIntent.metadata?.purchase_id;
        if (purchaseId) {
          // Get previous status for audit
          const prevResult = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [purchaseId]);
          const previousStatus = prevResult.rows[0]?.status || 'UNKNOWN';
          const partnerId = prevResult.rows[0]?.partner_id;

          const result = await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='PAID', updated_at=NOW() 
             WHERE id=$3 RETURNING *`,
            ['succeeded', paymentIntent.id, purchaseId]
          );
          
          console.log('💾 Purchase marked as PAID:', result.rows[0]?.id);

          // Log transaction event
          await logTransactionEvent(
            purchaseId,
            'PAID',
            previousStatus,
            'payment_intent.succeeded',
            event.id,
            event.data.object,
            paymentIntent.id,
            partnerId,
            { amount: paymentIntent.amount / 100, currency: paymentIntent.currency }
          );
          
          // Generate vouchers if not already created
          const vouchersCount = await pool.query(
            'SELECT COUNT(*) FROM vouchers WHERE purchase_id=$1',
            [purchaseId]
          );
          
          if (parseInt(vouchersCount.rows[0].count) === 0) {
            const purchase = result.rows[0];
            console.log('🎫 Generating vouchers for purchase:', purchaseId);
            
            for (let i = 0; i < purchase.qty; i++) {
              const code = crypto.randomBytes(6).toString('hex').toUpperCase();
              await pool.query(
                'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
                [purchase.partner_id, purchaseId, code, 'AVAILABLE']
              );
            }
            console.log('🎉 Vouchers generated:', purchase.qty);
          }
          
          logSecurityEvent('PAYMENT_SUCCEEDED', { purchaseId, paymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 });
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, purchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: paymentIntent.id,
            stripe_status: 'succeeded'
          });
        }
        break;

      case 'payment_intent.processing':
        const processingPayment = event.data.object;
        if (processingPayment.metadata?.purchase_id) {
          const processingPurchaseId = processingPayment.metadata.purchase_id;
          const prevProcessing = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [processingPurchaseId]);
          const prevStatusProcessing = prevProcessing.rows[0]?.status || 'UNKNOWN';
          const partnerIdProcessing = prevProcessing.rows[0]?.partner_id;
          
          await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='PENDING', updated_at=NOW() WHERE id=$3`,
            ['processing', processingPayment.id, processingPurchaseId]
          );
          
          await logTransactionEvent(
            processingPurchaseId,
            'PENDING',
            prevStatusProcessing,
            'payment_intent.processing',
            event.id,
            event.data.object,
            processingPayment.id,
            partnerIdProcessing,
            { amount: processingPayment.amount / 100 }
          );
          
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, processingPurchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: processingPayment.id,
            stripe_status: 'processing'
          });
        }
        break;

      case 'payment_intent.requires_action':
        const actionPayment = event.data.object;
        if (actionPayment.metadata?.purchase_id) {
          const actionPurchaseId = actionPayment.metadata.purchase_id;
          const prevAction = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [actionPurchaseId]);
          const prevStatusAction = prevAction.rows[0]?.status || 'UNKNOWN';
          const partnerIdAction = prevAction.rows[0]?.partner_id;
          
          await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='PENDING', updated_at=NOW() WHERE id=$3`,
            ['requires_action', actionPayment.id, actionPurchaseId]
          );
          
          await logTransactionEvent(
            actionPurchaseId,
            'PENDING',
            prevStatusAction,
            'payment_intent.requires_action',
            event.id,
            event.data.object,
            actionPayment.id,
            partnerIdAction,
            { requires_action: true, amount: actionPayment.amount / 100 }
          );
          
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, actionPurchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: actionPayment.id,
            stripe_status: 'requires_action'
          });
        }
        break;

      case 'payment_intent.canceled':
        const canceledPayment = event.data.object;
        if (canceledPayment.metadata?.purchase_id) {
          const canceledPurchaseId = canceledPayment.metadata.purchase_id;
          const prevCanceled = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [canceledPurchaseId]);
          const prevStatusCanceled = prevCanceled.rows[0]?.status || 'UNKNOWN';
          const partnerIdCanceled = prevCanceled.rows[0]?.partner_id;
          
          await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='FAILED', updated_at=NOW() WHERE id=$3`,
            ['canceled', canceledPayment.id, canceledPurchaseId]
          );
          
          await logTransactionEvent(
            canceledPurchaseId,
            'FAILED',
            prevStatusCanceled,
            'payment_intent.canceled',
            event.id,
            event.data.object,
            canceledPayment.id,
            partnerIdCanceled,
            { cancellation_reason: canceledPayment.cancellation_reason }
          );
          
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, canceledPurchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: canceledPayment.id,
            stripe_status: 'canceled'
          });
        }
        break;

      // ❌ PAYMENT FAILED
      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        console.log('❌ Payment failed:', failedPayment.id, 'Reason:', failedPayment.last_payment_error?.message);

        const failedPurchaseId = failedPayment.metadata?.purchase_id;
        if (failedPurchaseId) {
          const prevFailed = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [failedPurchaseId]);
          const prevStatusFailed = prevFailed.rows[0]?.status || 'UNKNOWN';
          const partnerIdFailed = prevFailed.rows[0]?.partner_id;

          await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='FAILED', updated_at=NOW() 
             WHERE id=$3`,
            ['failed', failedPayment.id, failedPurchaseId]
          );
          
          await logTransactionEvent(
            failedPurchaseId,
            'FAILED',
            prevStatusFailed,
            'payment_intent.payment_failed',
            event.id,
            event.data.object,
            failedPayment.id,
            partnerIdFailed,
            { error_message: failedPayment.last_payment_error?.message, error_code: failedPayment.last_payment_error?.code }
          );

          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, failedPurchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: failedPayment.id,
            stripe_status: 'failed',
            error_message: failedPayment.last_payment_error?.message || null
          });
          logSecurityEvent('PAYMENT_FAILED', { 
            purchaseId: failedPurchaseId, 
            paymentIntentId: failedPayment.id,
            errorMessage: failedPayment.last_payment_error?.message 
          });
        }
        break;

      // 🛒 CHECKOUT SESSION COMPLETED
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('✨ Checkout session completed:', session.id);
        
        const customer = session.customer;
        const customerEmail = session.customer_details?.email || session.customer_email;
        const customerName = session.customer_details?.name;
        const paymentStatus = session.payment_status;
        const amountTotal = session.amount_total / 100;
        const currency = session.currency;
        const metadata = session.metadata || {};

        console.log('📦 Processing Stripe purchase:', {
          email: customerEmail,
          amount: amountTotal,
          status: paymentStatus
        });

        // Step 1: Sync Stripe customer with app partner/user
        const syncResult = await upsertPartnerAndUserFromStripeCustomer(
          {
            id: customer,
            email: customerEmail,
            name: customerName,
            metadata: {
              ...metadata,
              app_user_id: metadata.app_user_id || null
            }
          },
          'WEBHOOK_CHECKOUT_COMPLETED',
          req
        );

        const partnerId = syncResult.partner_id;

        // Step 2: Retrieve line items from Stripe
        let lineItems = { data: [] };
        let totalQty = 1;
        
        try {
          lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
            expand: ['data.price.product']
          });

          totalQty = lineItems.data.reduce((sum, item) => sum + item.quantity, 0);
          console.log('🛍️ Line items retrieved:', lineItems.data.length, 'Total quantity:', totalQty);
        } catch (lineItemsError) {
          console.log('⚠️ Could not retrieve line items (test event):', lineItemsError.code);
        }

        // Step 3: Create purchase
        let newPurchaseId = metadata.purchase_id;
        let previousPurchaseStatus = null;

        if (newPurchaseId) {
          const prevPurchaseData = await pool.query('SELECT status FROM purchases WHERE id=$1', [newPurchaseId]);
          previousPurchaseStatus = prevPurchaseData.rows[0]?.status || 'UNKNOWN';

          await pool.query(
            `UPDATE purchases 
             SET partner_id=$1, qty=$2, total_price=$3, status=$4, stripe_status=$5, stripe_session_id=$6, payment_intent_id=$7, updated_at=NOW()
             WHERE id=$8`,
            [partnerId, totalQty, amountTotal, paymentStatus === 'paid' ? 'PAID' : 'PENDING', paymentStatus, session.id, session.payment_intent, newPurchaseId]
          );
        } else {
          const purchaseResult = await pool.query(
            `INSERT INTO purchases (partner_id, qty, total_price, status, stripe_status, stripe_session_id, payment_intent_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             RETURNING id`,
            [partnerId, totalQty, amountTotal, paymentStatus === 'paid' ? 'PAID' : 'PENDING', paymentStatus, session.id, session.payment_intent]
          );
          newPurchaseId = purchaseResult.rows[0].id;
          previousPurchaseStatus = 'NEW';
        }
        console.log('💰 Purchase created:', newPurchaseId);

        // Log transaction event for checkout session
        await logTransactionEvent(
          newPurchaseId,
          paymentStatus === 'paid' ? 'PAID' : 'PENDING',
          previousPurchaseStatus || 'NEW',
          'checkout.session.completed',
          event.id,
          event.data.object,
          session.payment_intent,
          partnerId,
          { session_id: session.id, amount: amountTotal, currency }
        );

        // Step 4: Save line items
        for (const item of lineItems.data) {
          const product = item.price?.product;
          const productName = typeof product === 'object' ? product.name : 'Unknown Product';
          const productId = typeof product === 'object' ? product.id : product;
          const unitAmount = item.price?.unit_amount / 100 || 0;
          const totalAmount = item.amount_total / 100;

          await pool.query(
            `INSERT INTO stripe_line_items (purchase_id, stripe_product_id, product_name, quantity, unit_amount, total_amount, currency)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newPurchaseId, productId, productName, item.quantity, unitAmount, totalAmount, currency]
          );
        }

        console.log('✅ Line items saved:', lineItems.data.length);

        // Step 5: Generate vouchers
        if (paymentStatus === 'paid') {
          console.log('🎫 Generating vouchers...', totalQty);
          for (let i = 0; i < totalQty; i++) {
            const code = crypto.randomBytes(6).toString('hex').toUpperCase();
            await pool.query(
              'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
              [partnerId, newPurchaseId, code, 'AVAILABLE']
            );
          }
          console.log('🎉 Vouchers generated:', totalQty);
        }

        logSecurityEvent('CHECKOUT_COMPLETED', { 
          sessionId: session.id, 
          purchaseId: newPurchaseId, 
          customer: customerEmail,
          amount: amountTotal
        });

        await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', syncResult.user_id || null, customer || null, newPurchaseId, {
          stripe_event_type: event.type,
          session_id: session.id,
          stripe_status: paymentStatus
        });
        
        break;

      case 'checkout.session.async_payment_succeeded':
        const asyncSucceeded = event.data.object;
        if (asyncSucceeded.metadata?.purchase_id) {
          await pool.query(
            `UPDATE purchases SET stripe_status=$1, status='PAID', updated_at=NOW() WHERE id=$2`,
            ['paid', asyncSucceeded.metadata.purchase_id]
          );
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, asyncSucceeded.customer || null, asyncSucceeded.metadata.purchase_id, {
            stripe_event_type: event.type,
            session_id: asyncSucceeded.id,
            stripe_status: 'paid'
          });
        }
        break;

      case 'checkout.session.async_payment_failed':
        const asyncFailed = event.data.object;
        if (asyncFailed.metadata?.purchase_id) {
          await pool.query(
            `UPDATE purchases SET stripe_status=$1, status='FAILED', updated_at=NOW() WHERE id=$2`,
            ['failed', asyncFailed.metadata.purchase_id]
          );
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, asyncFailed.customer || null, asyncFailed.metadata.purchase_id, {
            stripe_event_type: event.type,
            session_id: asyncFailed.id,
            stripe_status: 'failed'
          });
        }
        break;

      case 'customer.created':
      case 'customer.updated':
        const customerPayload = event.data.object;
        await upsertPartnerAndUserFromStripeCustomer(customerPayload, event.type, req);
        break;

      case 'customer.deleted':
        const deletedCustomer = event.data.object;
        if (deletedCustomer?.id) {
          await pool.query(
            `UPDATE users SET updated_at=NOW() WHERE stripe_customer_id=$1`,
            [deletedCustomer.id]
          );
          await logSystemEvent('STRIPE_CUSTOMER_DELETED', 'STRIPE_SYNC', null, deletedCustomer.id, null, {
            stripe_event_type: event.type
          }, 'SUCCESS', null, req);
        }
        break;

      // 💳 CHARGE REFUNDED
      case 'charge.refunded':
        const refundedCharge = event.data.object;
        console.log('💸 Charge refunded:', refundedCharge.id, 'Amount:', refundedCharge.amount_refunded / 100);

        const refundPaymentIntent = refundedCharge.payment_intent;
        if (refundPaymentIntent) {
          const refundPurchase = await pool.query(
            'SELECT id, partner_id, status FROM purchases WHERE payment_intent_id=$1',
            [refundPaymentIntent]
          );
          
          if (refundPurchase.rows[0]) {
            const purchaseId = refundPurchase.rows[0].id;
            const partnerId = refundPurchase.rows[0].partner_id;
            const previousStatus = refundPurchase.rows[0].status;

            await pool.query(
              `UPDATE purchases SET stripe_status=$1, status='REFUNDED', updated_at=NOW() 
               WHERE id=$2`,
              ['refunded', purchaseId]
            );
            
            await logTransactionEvent(
              purchaseId,
              'REFUNDED',
              previousStatus,
              'charge.refunded',
              event.id,
              event.data.object,
              refundPaymentIntent,
              partnerId,
              { amount_refunded: refundedCharge.amount_refunded / 100, refund_reason: refundedCharge.refund_reason }
            );

            // Mark vouchers as revoked
            await pool.query(
              `UPDATE vouchers SET status='REVOKED' 
               WHERE purchase_id=$1 AND status='AVAILABLE'`,
              [purchaseId]
            );
            
            console.log('🔄 Vouchers revoked for purchase:', purchaseId);
            logSecurityEvent('PURCHASE_REFUNDED', { purchaseId, chargeId: refundedCharge.id });
          }
        }
        break;

      // ⏰ CHARGE DISPUTE CREATED
      case 'charge.dispute.created':
        const disputedCharge = event.data.object.charge;
        console.log('⚠️ Dispute created for charge:', disputedCharge);
        logSecurityEvent('CHARGE_DISPUTE', { chargeId: disputedCharge, reason: event.data.object.reason });
        break;

      // 💰 INVOICE PAYMENT SUCCEEDED
      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        console.log('📄 Invoice payment succeeded:', invoice.id, 'Amount:', invoice.amount_paid / 100);
        logSecurityEvent('INVOICE_PAID', { invoiceId: invoice.id, amount: invoice.amount_paid / 100 });
        break;

      // ⚠️ INVOICE PAYMENT FAILED
      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        console.log('📄 Invoice payment failed:', failedInvoice.id);
        logSecurityEvent('INVOICE_PAYMENT_FAILED', { invoiceId: failedInvoice.id });
        break;

      default:
        console.log('ℹ️ Unhandled event type:', event.type);
    }

    // Mark event as processed
    await pool.query(
      'UPDATE stripe_events SET processed=TRUE, processed_at=NOW() WHERE stripe_event_id=$1',
      [event.id]
    );

    res.json({ received: true, processed: true });
  } catch (e) {
    console.error('❌ Webhook processing error:', e);
    logSecurityEvent('WEBHOOK_ERROR', { error: e.message, eventType: event.type });
    res.status(400).json({ error: e.message });
  }
});

// Admin: list purchases (include partner info, stripe status, and line items)
app.get('/admin/purchases', authenticate, requireAnyPermission(['purchases', 'financial_ops'], 'view'), async (req, res) => {
  try {
    const { payment_method, partner_id, status } = req.query;
    const conditions = [];
    const params = [];

    if (payment_method) { params.push(payment_method);              conditions.push(`p.payment_method=$${params.length}`); }
    if (partner_id)     { params.push(parseInt(partner_id, 10));    conditions.push(`p.partner_id=$${params.length}`); }
    if (status)         { params.push(status.toUpperCase());        conditions.push(`p.status=$${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT p.id, p.partner_id, p.qty, p.total_price, p.stripe_link, p.stripe_status,
             p.payment_intent_id, p.payment_method, p.external_reference, p.notes,
             p.status, p.expires_at, p.created_at, p.updated_at,
             pt.name AS partner_name, pt.email AS partner_email,
             (SELECT v2.complimentary_reason FROM vouchers v2
              WHERE v2.purchase_id = p.id LIMIT 1) AS complimentary_reason,
             (SELECT COALESCE(NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),''), u.email)
              FROM vouchers v2 LEFT JOIN users u ON u.id = v2.complimentary_issued_by
              WHERE v2.purchase_id = p.id AND v2.complimentary_issued_by IS NOT NULL LIMIT 1) AS complimentary_issued_by_name,
             (SELECT u.email FROM vouchers v2 LEFT JOIN users u ON u.id = v2.complimentary_issued_by
              WHERE v2.purchase_id = p.id AND v2.complimentary_issued_by IS NOT NULL LIMIT 1) AS complimentary_issued_by_email
      FROM purchases p
      LEFT JOIN partners pt ON pt.id = p.partner_id
      ${where}
      ORDER BY p.created_at DESC
    `, params);

    for (const purchase of r.rows) {
      const items = await pool.query('SELECT * FROM stripe_line_items WHERE purchase_id=$1', [purchase.id]);
      purchase.line_items = items.rows;
    }

    res.json(r.rows);
  } catch (e) {
    console.error('Error fetching purchases:', e);
    res.status(400).json({ error: e.message });
  }
});

// Admin: list Stripe customers
app.get('/admin/stripe-customers', authenticate, requireRole('admin'), async (req,res)=>{
  try{
    const r = await pool.query(`
      SELECT sc.*, pt.name as partner_name, pt.email as partner_email
      FROM stripe_customers sc
      LEFT JOIN partners pt ON pt.id = sc.partner_id
      ORDER BY sc.created_at DESC
    `);
    res.json(r.rows);
  }catch(e){ 
    console.error('Error fetching customers:', e);
    res.status(400).json({error:e.message}); 
  }
});

// Admin: Get all transaction events (paginated and filterable)
app.get('/admin/transaction-events', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const purchaseId = req.query.purchase_id;
    const partnerId = req.query.partner_id;
    const eventType = req.query.event_type;
    const status = req.query.status; // new_status

    let query = 'SELECT COUNT(*) FROM transaction_events WHERE 1=1';
    let params = [];
    let paramNum = 1;

    if (purchaseId) {
      query = query.replace('WHERE 1=1', `WHERE purchase_id=$${paramNum}`);
      params.push(purchaseId);
      paramNum++;
    }
    if (partnerId) {
      query += ` AND partner_id=$${paramNum}`;
      params.push(partnerId);
      paramNum++;
    }
    if (eventType) {
      query += ` AND event_type=$${paramNum}`;
      params.push(eventType);
      paramNum++;
    }
    if (status) {
      query += ` AND new_status=$${paramNum}`;
      params.push(status);
      paramNum++;
    }

    // Get total count
    const countResult = await pool.query(query, params);
    const total = parseInt(countResult.rows[0].count);

    // Get transaction events
    let selectQuery = `
      SELECT te.id, te.purchase_id, te.partner_id, te.payment_intent_id, te.previous_status, 
             te.new_status, te.event_type, te.stripe_event_id, te.metadata, te.created_at,
             p.total_price, p.qty, p.status as purchase_status,
             pt.name as partner_name, pt.email as partner_email
      FROM transaction_events te
      LEFT JOIN purchases p ON te.purchase_id = p.id
      LEFT JOIN partners pt ON te.partner_id = pt.id
      WHERE 1=1`;

    if (purchaseId) {
      selectQuery = selectQuery.replace('WHERE 1=1', `WHERE te.purchase_id=$1`);
      paramNum = 2;
    } else {
      paramNum = 1;
    }

    if (partnerId) {
      selectQuery += ` AND te.partner_id=$${paramNum}`;
      paramNum++;
    }
    if (eventType) {
      selectQuery += ` AND te.event_type=$${paramNum}`;
      paramNum++;
    }
    if (status) {
      selectQuery += ` AND te.new_status=$${paramNum}`;
      paramNum++;
    }

    selectQuery += ` ORDER BY te.created_at DESC LIMIT $${paramNum} OFFSET $${paramNum + 1}`;

    const eventParams = [...params, limit, offset];
    const result = await pool.query(selectQuery, eventParams);

    res.json({
      events: result.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error('Error fetching transaction events:', e);
    res.status(400).json({ error: 'Error al obtener eventos de transacción' });
  }
});

// Admin: Get transaction history for a specific purchase
app.get('/admin/purchases/:purchaseId/transaction-history', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const { purchaseId } = req.params;

  try {
    // Verify the purchase exists
    const purchaseCheck = await pool.query('SELECT id, partner_id FROM purchases WHERE id=$1', [purchaseId]);
    
    if (purchaseCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    const partnerId = purchaseCheck.rows[0].partner_id;

    // Get transaction events for this purchase
    const events = await pool.query(
      `SELECT id, purchase_id, previous_status, new_status, event_type, stripe_event_id, 
              stripe_event_data, metadata, created_at
       FROM transaction_events
       WHERE purchase_id=$1
       ORDER BY created_at ASC`,
      [purchaseId]
    );

    res.json({
      purchase_id: purchaseId,
      partner_id: partnerId,
      events: events.rows
    });
  } catch (e) {
    console.error('Error fetching transaction history:', e);
    res.status(400).json({ error: 'Error al obtener historial de transacción' });
  }
});

// Admin: Get transaction event summary by status (for dashboard)
app.get('/admin/transaction-events/summary', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const summary = await pool.query(`
      SELECT 
        new_status,
        COUNT(*) as count,
        COUNT(DISTINCT partner_id) as unique_partners,
        COUNT(DISTINCT purchase_id) as unique_purchases
      FROM transaction_events
      GROUP BY new_status
      ORDER BY count DESC
    `);

    const totalEvents = await pool.query('SELECT COUNT(*) FROM transaction_events');
    const uptime24h = await pool.query(`
      SELECT COUNT(*) FROM transaction_events 
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `);

    res.json({
      status_summary: summary.rows,
      total_events: parseInt(totalEvents.rows[0].count),
      events_24h: parseInt(uptime24h.rows[0].count)
    });
  } catch (e) {
    console.error('Error fetching transaction summary:', e);
    res.status(400).json({ error: 'Error al obtener resumen de transacciones' });
  }
});

app.get('/partner/:id/payments', authenticate, async (req, res) => {
  const pid = req.params.id;
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    const payments = await pool.query(
      `SELECT p.id, p.partner_id, p.qty, p.total_price, p.status, p.stripe_status,
              p.payment_intent_id, p.stripe_session_id, p.payment_method,
              p.external_reference, p.notes, p.created_at, p.updated_at,
              (SELECT v2.complimentary_reason FROM vouchers v2
               WHERE v2.purchase_id = p.id LIMIT 1) AS complimentary_reason
       FROM purchases p
       WHERE p.partner_id=$1
       ORDER BY p.created_at DESC`,
      [pid]
    );
    res.json(payments.rows);
  } catch (e) {
    res.status(400).json({ error: 'Error al obtener estados de pago' });
  }
});

app.get('/partner/:id/pricing-preview', authenticate, apiLimiter, async (req, res) => {
  const pid = req.params.id;
  const qty = parseInt(req.query.qty, 10);

  if (req.user && req.user.role === 'partner') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  } else if (req.user && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const pricing = await resolvePartnerPricing(pid, qty);
    res.json(pricing);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al calcular precio' });
  }
});

app.get('/partner/:id/purchases/:purchaseId/status', authenticate, apiLimiter, async (req, res) => {
  const { id: partnerId, purchaseId } = req.params;
  const sessionIdFromQuery = (req.query.session_id || '').toString().trim();

  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(partnerId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    const purchase = await pool.query(
      `SELECT id, partner_id, status, stripe_status, payment_intent_id, created_at, updated_at
       FROM purchases
       WHERE id=$1 AND partner_id=$2`,
      [purchaseId, partnerId]
    );

    if (purchase.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    let p = purchase.rows[0];
    let isPaid = p.status === 'PAID' || p.stripe_status === 'succeeded' || p.stripe_status === 'paid';

    if (!isPaid) {
      const sessionToCheck = sessionIdFromQuery || p.stripe_session_id;
      if (sessionToCheck) {
        try {
          const session = await stripe.checkout.sessions.retrieve(sessionToCheck, {
            expand: ['payment_intent']
          });

          if (session?.metadata?.purchase_id && String(session.metadata.purchase_id) !== String(purchaseId)) {
            return res.status(400).json({ error: 'session_id no corresponde con la compra' });
          }

          const stripeStatus = session.payment_status || p.stripe_status || 'pending';
          const paidNow = stripeStatus === 'paid';
          const paymentIntentId = typeof session.payment_intent === 'object'
            ? session.payment_intent.id
            : (session.payment_intent || p.payment_intent_id || null);

          await pool.query(
            `UPDATE purchases
             SET stripe_status=$1,
                 status=$2,
                 payment_intent_id=$3,
                 stripe_session_id=$4,
                 updated_at=NOW()
             WHERE id=$5`,
            [stripeStatus, paidNow ? 'PAID' : p.status, paymentIntentId, session.id, purchaseId]
          );

          if (paidNow) {
            const existingVouchers = await pool.query('SELECT COUNT(*) FROM vouchers WHERE purchase_id=$1', [purchaseId]);
            if (parseInt(existingVouchers.rows[0].count, 10) === 0) {
              for (let i = 0; i < p.qty; i++) {
                const code = crypto.randomBytes(6).toString('hex').toUpperCase();
                await pool.query(
                  'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
                  [partnerId, purchaseId, code, 'AVAILABLE']
                );
              }
            }
          }

          const refreshed = await pool.query(
            `SELECT id, partner_id, status, stripe_status, payment_intent_id, stripe_session_id
             FROM purchases
             WHERE id=$1 AND partner_id=$2`,
            [purchaseId, partnerId]
          );
          p = refreshed.rows[0] || p;
          isPaid = p.status === 'PAID' || p.stripe_status === 'succeeded' || p.stripe_status === 'paid';
        } catch (syncErr) {
          console.warn('No se pudo reconciliar compra con Stripe en status endpoint:', syncErr.message);
        }
      }
    }

    return res.json({
      purchase_id: p.id,
      status: p.status,
      stripe_status: p.stripe_status,
      stripe_session_id: p.stripe_session_id || null,
      payment_intent_id: p.payment_intent_id,
      is_paid: isPaid,
      can_manage_vouchers: isPaid
    });
  } catch (e) {
    return res.status(400).json({ error: 'Error al obtener estado del pago' });
  }
});

// Partner: Get transaction state history for a specific purchase
app.get('/partner/:id/purchases/:purchaseId/transaction-history', authenticate, async (req, res) => {
  const { id: partnerId, purchaseId } = req.params;
  
  // Authorization: check if user belongs to this partner
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(partnerId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    // Verify the purchase belongs to this partner
    const purchaseCheck = await pool.query(
      'SELECT id, partner_id FROM purchases WHERE id=$1 AND partner_id=$2',
      [purchaseId, partnerId]
    );
    
    if (purchaseCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    // Get transaction events
    const events = await pool.query(
      `SELECT id, purchase_id, previous_status, new_status, event_type, stripe_event_id, 
              metadata, created_at
       FROM transaction_events
       WHERE purchase_id=$1
       ORDER BY created_at ASC`,
      [purchaseId]
    );

    res.json({
      purchase_id: purchaseId,
      events: events.rows
    });
  } catch (e) {
    console.error('Error fetching transaction history:', e);
    res.status(400).json({ error: 'Error al obtener historial de transacción' });
  }
});

// Partner: Get all transaction events for all their purchases (paginated)
app.get('/partner/:id/transaction-events', authenticate, apiLimiter, async (req, res) => {
  const partnerId = req.params.id;
  
  // Authorization: check if user belongs to this partner
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(partnerId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM transaction_events WHERE partner_id=$1',
      [partnerId]
    );
    const total = parseInt(countResult.rows[0].count);

    // Get paginated transaction events
    const events = await pool.query(
      `SELECT te.id, te.purchase_id, te.previous_status, te.new_status, te.event_type, 
              te.stripe_event_id, te.metadata, te.created_at,
              p.id as purchase_id, p.total_price, p.qty
       FROM transaction_events te
       LEFT JOIN purchases p ON te.purchase_id = p.id
       WHERE te.partner_id=$1
       ORDER BY te.created_at DESC
       LIMIT $2 OFFSET $3`,
      [partnerId, limit, offset]
    );

    res.json({
      events: events.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error('Error fetching transaction events:', e);
    res.status(400).json({ error: 'Error al obtener eventos de transacción' });
  }
});

// ── Moodle webhook: receptor de eventos push de cursos ───────────────────────
// Moodle llama este endpoint cuando crea, actualiza o elimina un curso.
// Requiere configurar el plugin "local_webhooks" en Moodle y definir
// MOODLE_WEBHOOK_SECRET en el .env (token Bearer que Moodle enviará en el header).
app.post('/webhook/moodle/course-event', async (req, res) => {
  const secret = process.env.MOODLE_WEBHOOK_SECRET;
  const auth   = req.headers['authorization'];

  if (secret) {
    if (!auth || auth !== `Bearer ${secret}`) {
      console.warn('⚠️ [MOODLE WEBHOOK] Token inválido o ausente');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('❌ [MOODLE WEBHOOK] MOODLE_WEBHOOK_SECRET no configurado en producción. Webhook rechazado.');
    return res.status(500).json({ error: 'Webhook configuration error' });
  } else {
    console.warn('⚠️ [MOODLE WEBHOOK] MOODLE_WEBHOOK_SECRET no configurado (dev — verificación omitida)');
  }

  const { event } = req.body || {};
  const eventStr  = typeof event === 'string' ? event : '';
  console.log(`📨 [MOODLE WEBHOOK] Evento recibido: ${eventStr}`);

  // Eventos de curso soportados (notación Moodle con namespace o simplificada)
  const isCourseEvent = [
    'course_created', 'course_updated', 'course_deleted',
    '\\core\\event\\course_created', '\\core\\event\\course_updated', '\\core\\event\\course_deleted'
  ].includes(eventStr);

  if (!isCourseEvent) {
    return res.json({ ok: true, action: 'ignored', event: eventStr });
  }

  // Re-sincroniza todos los cursos desde Moodle para reflejar el cambio
  try {
    const syncResult = await syncMoodleCourses();
    if (!syncResult.ok) {
      console.error(`❌ [MOODLE WEBHOOK] Sync falló: ${syncResult.error}`);
      return res.status(502).json({ ok: false, error: syncResult.error });
    }

    console.log(`✓ [MOODLE WEBHOOK] Sync post-evento: +${syncResult.created.length} nuevas, ~${syncResult.updated.length} actualizadas, -${syncResult.deactivated.length} desactivadas`);

    // Audit log (non-fatal)
    logSystemEvent(
      'MOODLE_WEBHOOK_COURSE_SYNC', 'MOODLE', null, null, null,
      { event: eventStr, created: syncResult.created.length, updated: syncResult.updated.length, deactivated: syncResult.deactivated.length },
      'SUCCESS', null, req
    ).catch(() => {});

    return res.json({
      ok:          true,
      action:      'synced',
      event:       eventStr,
      created:     syncResult.created.length,
      updated:     syncResult.updated.length,
      deactivated: syncResult.deactivated.length
    });
  } catch (e) {
    console.error('❌ [MOODLE WEBHOOK] Error inesperado:', e.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// Stripe webhook simulation (for testing without real Stripe): update purchase status
app.post('/stripe/webhook', async (req,res)=>{
  const { purchase_id, status } = req.body; // status: PAID or FAILED
  try{
    const p = await pool.query('UPDATE purchases SET status=$1 WHERE id=$2 RETURNING *',[status,purchase_id]);
    if(status === 'PAID'){
      // create vouchers for the purchase
      const purchase = p.rows[0];
      const qty = purchase.qty;
      const partner_id = purchase.partner_id;
      const created = [];
      for(let i=0;i<qty;i++){
        const code = crypto.randomBytes(6).toString('hex').toUpperCase();
        const v = await pool.query('INSERT INTO vouchers (partner_id,purchase_id,code) VALUES ($1,$2,$3) RETURNING *',[partner_id,purchase_id,code]);
        created.push(v.rows[0]);
      }
      res.json({ok:true,created});
    }else{
      res.json({ok:true});
    }
  }catch(e){ res.status(400).json({error:e.message}); }
});

// Partner: list vouchers (protected) - only owner or admin
app.get('/partner/:id/vouchers', authenticate, async (req,res)=>{
  const pid = req.params.id;
  // allow if requestor is admin or belongs to the partner
  if(req.user && req.user.role !== 'admin'){
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid)){
      return res.status(403).json({ error: 'forbidden' });
    }
  }
  try{
    await backfillPaidPurchaseVouchers(pid);

    const r = await pool.query(
      `SELECT v.id, v.partner_id, v.purchase_id, v.code, v.status, v.course_id, c.name AS course_name,
              v.consumed_by, v.consumed_at, v.created_at,
              v.voucher_type, v.complimentary_reason,
              a.final_client, a.user_name AS activation_user_name,
              a.moodle_status, a.moodle_user_id, a.moodle_error, a.moodle_enrolled_at,
              a.moodle_completed_at, a.expires_at
       FROM vouchers v
       LEFT JOIN courses c ON c.id = v.course_id
       LEFT JOIN activations a ON a.voucher_id = v.id
       WHERE v.partner_id=$1
       ORDER BY v.created_at DESC`,
      [pid]
    );
    res.json(r.rows);
  }catch(e){ res.status(400).json({error:e.message}); }
});

// Admin: courses CRUD
app.get('/admin/courses', authenticate, requirePermission('courses', 'view'), apiLimiter, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, COALESCE(active, TRUE) AS active, created_at, updated_at FROM courses ORDER BY name ASC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener cursos' });
  }
});

app.post('/admin/courses',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre de curso inválido (2-200 caracteres)'),
  handleValidationErrors,
  async (req, res) => {
    const name = String(req.body.name || '').trim();
    try {
      const duplicate = await pool.query('SELECT id FROM courses WHERE LOWER(name)=LOWER($1)', [name]);
      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Ya existe un curso con ese nombre' });
      }

      const created = await pool.query(
        'INSERT INTO courses (name, active) VALUES ($1, TRUE) RETURNING id, name, COALESCE(active, TRUE) AS active, created_at',
        [name]
      );
      await logSystemEvent('COURSE_CREATED', 'COURSE_MANAGEMENT', req.user.sub, null, null, {
        course_id: created.rows[0].id,
        name: created.rows[0].name
      }, 'SUCCESS', null, req);
      res.status(201).json(created.rows[0]);
    } catch (e) {
      await logSystemEvent('COURSE_CREATE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { name }, 'FAILED', e.message, req);
      res.status(500).json({ error: 'Error al crear curso' });
    }
  }
);

app.put('/admin/courses/:id',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  param('id').isInt({ min: 1 }).withMessage('ID de curso inválido'),
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre de curso inválido (2-200 caracteres)'),
  handleValidationErrors,
  async (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    const name = String(req.body.name || '').trim();
    try {
      const duplicate = await pool.query('SELECT id FROM courses WHERE LOWER(name)=LOWER($1) AND id<>$2', [name, courseId]);
      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Ya existe un curso con ese nombre' });
      }

      const updated = await pool.query(
        'UPDATE courses SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, COALESCE(active, TRUE) AS active, created_at, updated_at',
        [name, courseId]
      );

      if (updated.rowCount === 0) {
        return res.status(404).json({ error: 'Curso no encontrado' });
      }

      await logSystemEvent('COURSE_UPDATED', 'COURSE_MANAGEMENT', req.user.sub, null, null, {
        course_id: courseId,
        name
      }, 'SUCCESS', null, req);
      res.json(updated.rows[0]);
    } catch (e) {
      await logSystemEvent('COURSE_UPDATE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { course_id: courseId, name }, 'FAILED', e.message, req);
      res.status(500).json({ error: 'Error al actualizar curso' });
    }
  }
);

app.patch('/admin/courses/:id/status',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  param('id').isInt({ min: 1 }).withMessage('ID de curso inválido'),
  body('active').isBoolean().withMessage('Estado inválido'),
  handleValidationErrors,
  async (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    const active = req.body.active === true || req.body.active === 'true';
    try {
      const updated = await pool.query(
        'UPDATE courses SET active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, COALESCE(active, TRUE) AS active, created_at, updated_at',
        [active, courseId]
      );

      if (updated.rowCount === 0) {
        return res.status(404).json({ error: 'Curso no encontrado' });
      }

      await logSystemEvent('COURSE_STATUS_UPDATED', 'COURSE_MANAGEMENT', req.user.sub, null, null, {
        course_id: courseId,
        active
      }, 'SUCCESS', null, req);
      res.json(updated.rows[0]);
    } catch (e) {
      await logSystemEvent('COURSE_STATUS_UPDATE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { course_id: courseId, active }, 'FAILED', e.message, req);
      res.status(500).json({ error: 'Error al actualizar estado del curso' });
    }
  }
);

app.delete('/admin/courses/:id',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  param('id').isInt({ min: 1 }).withMessage('ID de curso inválido'),
  handleValidationErrors,
  async (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    try {
      const deleted = await pool.query('DELETE FROM courses WHERE id=$1 RETURNING id', [courseId]);
      if (deleted.rowCount === 0) {
        return res.status(404).json({ error: 'Curso no encontrado' });
      }
      await logSystemEvent('COURSE_DELETED', 'COURSE_MANAGEMENT', req.user.sub, null, null, {
        course_id: courseId
      }, 'SUCCESS', null, req);
      res.json({ ok: true, id: courseId });
    } catch (e) {
      if (e && e.code === '23503') {
        await logSystemEvent('COURSE_DELETE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { course_id: courseId }, 'FAILED', 'Curso con dependencias', req);
        return res.status(409).json({ error: 'No se puede eliminar: el curso tiene activaciones o vouchers asociados' });
      }
      await logSystemEvent('COURSE_DELETE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { course_id: courseId }, 'FAILED', e.message, req);
      res.status(500).json({ error: 'Error al eliminar curso' });
    }
  }
);

app.get('/partner/:id/courses', authenticate, apiLimiter, async (req, res) => {
  const pid = req.params.id;
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    const courses = await pool.query('SELECT id, name FROM courses WHERE COALESCE(active, TRUE)=TRUE ORDER BY name ASC');
    res.json(courses.rows);
  } catch (e) {
    res.status(400).json({ error: 'Error al obtener cursos' });
  }
});

app.get('/partner/:id/activation-eligibility', authenticate, apiLimiter, async (req, res) => {
  const pid = req.params.id;
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    await backfillPaidPurchaseVouchers(pid);

    const result = await pool.query(
      `SELECT COUNT(*) AS available_paid
       FROM vouchers v
       INNER JOIN purchases p ON p.id = v.purchase_id
       WHERE v.partner_id=$1
         AND v.status='AVAILABLE'
         AND v.course_id IS NULL
         AND (p.status='PAID' OR p.stripe_status IN ('succeeded', 'paid'))`,
      [pid]
    );

    const availablePaid = parseInt(result.rows[0].available_paid, 10) || 0;
    return res.json({
      can_activate: availablePaid > 0,
      available_paid_vouchers: availablePaid,
      message: availablePaid > 0
        ? 'Puedes activar vouchers.'
        : 'No hay vouchers pagados disponibles para activar.'
    });
  } catch (e) {
    return res.status(400).json({ error: 'Error al validar elegibilidad de activación' });
  }
});

// Partner: final clients CRUD
app.get('/partner/:id/final-clients', authenticate, async (req, res) => {
  const pid = req.params.id;
  if(req.user.role !== 'admin'){
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid))
      return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const r = await pool.query(
      'SELECT id, name, created_at FROM partner_final_clients WHERE partner_id=$1 ORDER BY name ASC',
      [pid]
    );
    res.json(r.rows);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/partner/:id/final-clients',
  authenticate, requireRole('partner'), apiLimiter,
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre obligatorio (2-200 caracteres)'),
  handleValidationErrors,
  async (req, res) => {
    const pid = req.params.id;
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid))
      return res.status(403).json({ error: 'forbidden' });
    try {
      const { name } = req.body;
      const dup = await pool.query(
        'SELECT id FROM partner_final_clients WHERE partner_id=$1 AND LOWER(name)=LOWER($2)',
        [pid, name]
      );
      if(dup.rowCount > 0) return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
      const r = await pool.query(
        'INSERT INTO partner_final_clients (partner_id, name) VALUES ($1,$2) RETURNING id, name, created_at',
        [pid, name]
      );
      await logSystemEvent('FINAL_CLIENT_CREATED', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10),
        final_client_id: r.rows[0].id,
        name: r.rows[0].name
      }, 'SUCCESS', null, req);
      res.status(201).json(r.rows[0]);
    } catch(e) {
      await logSystemEvent('FINAL_CLIENT_CREATE_ERROR', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, { partner_id: parseInt(pid, 10) || null }, 'FAILED', e.message, req);
      res.status(400).json({ error: e.message });
    }
  }
);

app.put('/partner/:id/final-clients/:clientId',
  authenticate, requireRole('partner'), apiLimiter,
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre obligatorio (2-200 caracteres)'),
  handleValidationErrors,
  async (req, res) => {
    const pid = req.params.id;
    const clientId = parseInt(req.params.clientId, 10);
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid))
      return res.status(403).json({ error: 'forbidden' });
    try {
      const { name } = req.body;
      const dup = await pool.query(
        'SELECT id FROM partner_final_clients WHERE partner_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3',
        [pid, name, clientId]
      );
      if(dup.rowCount > 0) return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
      const r = await pool.query(
        'UPDATE partner_final_clients SET name=$1 WHERE id=$2 AND partner_id=$3 RETURNING id, name, created_at',
        [name, clientId, pid]
      );
      if(r.rowCount === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
      await logSystemEvent('FINAL_CLIENT_UPDATED', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10),
        final_client_id: clientId,
        name
      }, 'SUCCESS', null, req);
      res.json(r.rows[0]);
    } catch(e) {
      await logSystemEvent('FINAL_CLIENT_UPDATE_ERROR', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10) || null,
        final_client_id: clientId
      }, 'FAILED', e.message, req);
      res.status(400).json({ error: e.message });
    }
  }
);

app.delete('/partner/:id/final-clients/:clientId',
  authenticate, requireRole('partner'),
  async (req, res) => {
    const pid = req.params.id;
    const clientId = parseInt(req.params.clientId, 10);
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid))
      return res.status(403).json({ error: 'forbidden' });
    try {
      const r = await pool.query(
        'DELETE FROM partner_final_clients WHERE id=$1 AND partner_id=$2 RETURNING id',
        [clientId, pid]
      );
      if(r.rowCount === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
      await logSystemEvent('FINAL_CLIENT_DELETED', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10),
        final_client_id: clientId
      }, 'SUCCESS', null, req);
      res.json({ ok: true });
    } catch(e) {
      await logSystemEvent('FINAL_CLIENT_DELETE_ERROR', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10) || null,
        final_client_id: clientId
      }, 'FAILED', e.message, req);
      res.status(400).json({ error: e.message });
    }
  }
);

// Partner: activate voucher with validation
app.post('/partner/:id/activate',
  authenticate,
  requireRole('partner'),
  apiLimiter,
  param('id').isInt().withMessage('Partner ID inválido'),
  body('course_id').isInt({ min: 1 }).withMessage('Curso inválido'),
  body('user_name').trim().isLength({ min: 2, max: 100 }).withMessage('Nombre debe tener entre 2 y 100 caracteres'),
  body('user_email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('final_client').trim().isLength({ min: 2, max: 200 }).withMessage('Cliente final es obligatorio'),
  body('activation_months').optional().isInt({ min: 1, max: 120 }).withMessage('Meses de activación inválidos'),
  handleValidationErrors,
  async (req, res) => {
    const pid = req.params.id;
    const { course_id, user_name, user_email, final_client, activation_months } = req.body;

    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    try {
      await backfillPaidPurchaseVouchers(pid);

      // Resolve max activation months from system settings
      const settingRow = await pool.query("SELECT value FROM system_settings WHERE key='max_activation_months'");
      const maxMonths = settingRow.rows.length ? (parseInt(settingRow.rows[0].value) || 12) : 12;
      const reqMonths = activation_months ? parseInt(activation_months) : maxMonths;
      if (reqMonths < 1 || reqMonths > maxMonths) {
        return res.status(400).json({ error: `El tiempo de disponibilidad debe estar entre 1 y ${maxMonths} meses` });
      }

      const course = await pool.query(
        'SELECT id, name, moodle_course_id FROM courses WHERE id=$1',
        [course_id]
      );
      if (course.rowCount === 0) {
        return res.status(404).json({ error: 'Certificación no encontrada' });
      }

      const voucherQuery = await pool.query(
        `SELECT v.id, v.code, v.purchase_id
         FROM vouchers v
         INNER JOIN purchases p ON p.id = v.purchase_id
         WHERE v.partner_id=$1
           AND v.status='AVAILABLE'
           AND v.course_id IS NULL
           AND (p.status='PAID' OR p.stripe_status IN ('succeeded', 'paid'))
         ORDER BY v.created_at ASC
         LIMIT 1`,
        [pid]
      );

      if (voucherQuery.rowCount === 0) {
        logSecurityEvent('VOUCHER_ACTIVATION_FAILED', { partnerId: pid, reason: 'no_available_paid_voucher', userId: req.user.sub });
        await logSystemEvent('VOUCHER_ACTIVATION_ERROR', 'VOUCHER', req.user.sub, null, null, {
          partner_id: parseInt(pid, 10),
          reason: 'no_available_paid_voucher'
        }, 'FAILED', 'No hay vouchers disponibles con pago exitoso', req);
        return res.status(400).json({ error: 'No hay vouchers disponibles con pago exitoso' });
      }

      const voucher = voucherQuery.rows[0];
      const moodleCourseId = course.rows[0].moodle_course_id || null;

      await pool.query(
        'UPDATE vouchers SET status=$1, consumed_by=$2, consumed_at=NOW(), course_id=$3 WHERE id=$4',
        ['CONSUMED', user_email, course_id, voucher.id]
      );

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + reqMonths);

      const activationResult = await pool.query(
        `INSERT INTO activations (voucher_id, course_id, user_name, user_email, final_client, moodle_status, expires_at, activation_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [voucher.id, course_id, user_name, user_email, final_client,
         moodleCourseId ? 'PENDING' : 'SKIPPED', expiresAt, 'ACTIVE']
      );
      const activationId = activationResult.rows[0].id;

      await logSystemEvent('VOUCHER_ACTIVATED', 'VOUCHER', req.user.sub, null, voucher.purchase_id, {
        partner_id: parseInt(pid, 10),
        voucher_id: voucher.id,
        voucher_code: voucher.code,
        course_id,
        user_email,
        final_client,
        moodle_course_id: moodleCourseId
      }, 'SUCCESS', null, req);

      logSecurityEvent('VOUCHER_ACTIVATED', {
        voucherId: voucher.id,
        code: voucher.code,
        courseId: course_id,
        partnerId: pid,
        userEmail: user_email,
        finalClient: final_client,
        userId: req.user.sub
      });

      // Moodle enrollment — non-blocking: activation already persisted above
      const nameParts = (user_name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || user_email.split('@')[0];
      const lastName  = nameParts.slice(1).join(' ') || 'Student';

      const moodleResult = await moodleService.enrollStudent({
        email: user_email,
        firstName,
        lastName,
        moodleCourseId,
        expiresAt
      });

      let moodleStatus, moodleUserId, moodleError, moodleEnrolledAt;
      let moodleUsername = null, moodleTempPassword = null;

      if (moodleResult.skipped) {
        moodleStatus = 'SKIPPED';
      } else if (moodleResult.mocked) {
        moodleStatus     = 'MOCKED';
        moodleUserId     = moodleResult.moodleUserId;
        moodleEnrolledAt = new Date();
        moodleUsername    = moodleResult.moodleUsername    || null;
        moodleTempPassword = moodleResult.moodleTempPassword || null;
      } else if (moodleResult.enrolled) {
        moodleStatus      = 'ENROLLED';
        moodleUserId      = moodleResult.moodleUserId;
        moodleEnrolledAt  = new Date();
        moodleUsername    = moodleResult.moodleUsername    || null;
        moodleTempPassword = moodleResult.moodleTempPassword || null;
      } else {
        moodleStatus = 'FAILED';
        moodleError  = moodleResult.error;
        moodleUserId = moodleResult.moodleUserId || null;
        console.error(`❌ Moodle enrollment failed for activation ${activationId}:`, moodleResult.error);
      }

      await pool.query(
        `UPDATE activations
         SET moodle_status=$1, moodle_user_id=$2, moodle_error=$3, moodle_enrolled_at=$4,
             moodle_username=$5, moodle_temp_password=$6
         WHERE id=$7`,
        [moodleStatus, moodleUserId || null, moodleError || null, moodleEnrolledAt || null,
         moodleUsername, moodleTempPassword, activationId]
      );

      await logSystemEvent(
        moodleStatus === 'ENROLLED' ? 'MOODLE_ENROLLED' : `MOODLE_ENROLL_${moodleStatus}`,
        'MOODLE',
        req.user.sub,
        null,
        voucher.purchase_id,
        {
          activation_id:    activationId,
          voucher_id:       voucher.id,
          moodle_course_id: moodleCourseId,
          moodle_user_id:   moodleUserId || null,
          user_email,
          mock_mode:        moodleService.isMockMode()
        },
        moodleStatus === 'FAILED' ? 'FAILED' : 'SUCCESS',
        moodleError || null,
        req
      );

      // Correo de bienvenida: solo si se creó una cuenta nueva en Moodle (no bloqueante)
      if (moodleResult.createdNewUser && moodleTempPassword) {
        await sendStudentWelcomeEmail({
          activationId,
          to:           user_email,
          studentName:  user_name,
          courseName:   course.rows[0].name,
          username:     moodleUsername,
          tempPassword: moodleTempPassword,
          months:       reqMonths,
          expiresAt,
          userId:       req.user.sub,
          req
        });
      }

      res.json({
        ok: true,
        voucher_id:           voucher.id,
        voucher_code:         voucher.code,
        course_id,
        course_name:          course.rows[0].name,
        moodle_status:        moodleStatus,
        moodle_user_id:       moodleUserId || null,
        moodle_username:      moodleUsername || null,
        moodle_temp_password: moodleTempPassword || null,
        expires_at:           expiresAt.toISOString(),
        activation_months:    reqMonths
      });

    } catch (e) {
      await logSystemEvent('VOUCHER_ACTIVATION_ERROR', 'VOUCHER', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10),
        course_id,
        user_email
      }, 'FAILED', e.message, req);
      logSecurityEvent('VOUCHER_ACTIVATION_ERROR', { error: e.message, partnerId: pid, userId: req.user.sub });
      res.status(400).json({ error: 'Error al activar voucher' });
    }
  }
);

// Admin: list activations with FAILED or PENDING Moodle enrollment
app.get('/admin/moodle/pending-enrollments',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    try {
      const { status = 'FAILED', limit = 50, offset = 0 } = req.query;
      const validStatuses = ['FAILED', 'PENDING'];
      const safeStatus = validStatuses.includes((status || '').toUpperCase())
        ? status.toUpperCase() : 'FAILED';

      const result = await pool.query(
        `SELECT a.id, a.voucher_id, a.course_id, a.user_name, a.user_email,
                a.final_client, a.activated_at,
                a.moodle_status, a.moodle_user_id, a.moodle_error,
                a.moodle_retry_count, a.moodle_retried_at,
                c.name AS course_name, c.moodle_course_id
         FROM activations a
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.moodle_status = $1
         ORDER BY a.activated_at DESC
         LIMIT $2 OFFSET $3`,
        [safeStatus, parseInt(limit, 10), parseInt(offset, 10)]
      );
      const total = await pool.query(
        'SELECT COUNT(*) FROM activations WHERE moodle_status = $1',
        [safeStatus]
      );
      res.json({
        enrollments: result.rows,
        total: parseInt(total.rows[0].count, 10),
        status: safeStatus
      });
    } catch (e) {
      console.error('❌ Error fetching pending Moodle enrollments:', e);
      res.status(500).json({ error: 'Error al obtener matrículas pendientes' });
    }
  }
);

// Admin: retry a single failed Moodle enrollment
app.post('/admin/moodle/enrollments/:activationId/retry',
  authenticate, requireRole('admin'), apiLimiter,
  param('activationId').isInt({ min: 1 }).withMessage('activationId inválido'),
  handleValidationErrors,
  async (req, res) => {
    const { activationId } = req.params;
    try {
      const actResult = await pool.query(
        `SELECT a.id, a.user_name, a.user_email, a.moodle_status, a.expires_at,
                a.moodle_retry_count, c.moodle_course_id, c.name AS course_name
         FROM activations a
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.id = $1`,
        [activationId]
      );
      if (actResult.rowCount === 0) {
        return res.status(404).json({ error: 'Activation no encontrada' });
      }
      const act = actResult.rows[0];
      if (act.moodle_status === 'ENROLLED') {
        return res.status(400).json({ error: 'Ya matriculado', moodle_status: act.moodle_status });
      }
      if (!act.moodle_course_id) {
        return res.status(400).json({ error: 'El curso no tiene moodle_course_id mapeado' });
      }

      await pool.query(
        `UPDATE activations
         SET moodle_status='PENDING', moodle_retried_at=NOW(),
             moodle_retry_count = moodle_retry_count + 1
         WHERE id=$1`,
        [activationId]
      );

      const nameParts = (act.user_name || '').trim().split(/\s+/);
      const moodleResult = await moodleService.enrollStudent({
        email:          act.user_email,
        firstName:      nameParts[0] || act.user_email.split('@')[0],
        lastName:       nameParts.slice(1).join(' ') || 'Student',
        moodleCourseId: act.moodle_course_id,
        expiresAt:      act.expires_at
      });

      let moodleStatus, moodleUserId, moodleError, moodleEnrolledAt;
      let moodleUsername = null, moodleTempPassword = null;

      if (moodleResult.enrolled || moodleResult.mocked) {
        moodleStatus     = moodleResult.mocked ? 'MOCKED' : 'ENROLLED';
        moodleUserId     = moodleResult.moodleUserId;
        moodleEnrolledAt = new Date();
        moodleUsername    = moodleResult.moodleUsername    || null;
        moodleTempPassword = moodleResult.moodleTempPassword || null;
      } else {
        moodleStatus = 'FAILED';
        moodleError  = moodleResult.error;
        moodleUserId = moodleResult.moodleUserId || null;
      }

      await pool.query(
        `UPDATE activations
         SET moodle_status=$1, moodle_user_id=$2, moodle_error=$3, moodle_enrolled_at=$4,
             moodle_username=COALESCE($5, moodle_username),
             moodle_temp_password=COALESCE($6, moodle_temp_password)
         WHERE id=$7`,
        [moodleStatus, moodleUserId || null, moodleError || null, moodleEnrolledAt || null,
         moodleUsername, moodleTempPassword, activationId]
      );

      await logSystemEvent(
        `MOODLE_ENROLL_RETRY_${moodleStatus}`,
        'MOODLE', req.user.sub, null, null,
        { activation_id: parseInt(activationId, 10), moodle_course_id: act.moodle_course_id, user_email: act.user_email },
        moodleStatus === 'FAILED' ? 'FAILED' : 'SUCCESS',
        moodleError || null, req
      );

      // Correo de bienvenida: solo si el retry creó una cuenta nueva en Moodle (no bloqueante)
      if (moodleResult.createdNewUser && moodleTempPassword) {
        await sendStudentWelcomeEmail({
          activationId: parseInt(activationId, 10),
          to:           act.user_email,
          studentName:  act.user_name,
          courseName:   act.course_name,
          username:     moodleUsername,
          tempPassword: moodleTempPassword,
          expiresAt:    act.expires_at,
          userId:       req.user.sub,
          req
        });
      }

      res.json({
        ok:             moodleStatus !== 'FAILED',
        activation_id:  parseInt(activationId, 10),
        moodle_status:  moodleStatus,
        moodle_user_id: moodleUserId || null,
        error:          moodleError  || null
      });
    } catch (e) {
      console.error('❌ Error retrying Moodle enrollment:', e);
      res.status(500).json({ error: 'Error al reintentar matrícula en Moodle' });
    }
  }
);

// Admin: bulk retry all FAILED Moodle enrollments (up to 100 at a time)
app.post('/admin/moodle/enrollments/retry-all-failed',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    try {
      const failed = await pool.query(
        `SELECT a.id FROM activations a
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.moodle_status = 'FAILED'
           AND c.moodle_course_id IS NOT NULL
         ORDER BY a.activated_at DESC
         LIMIT 100`
      );

      const results = { attempted: 0, succeeded: 0, failed: 0 };

      for (const row of failed.rows) {
        const actResult = await pool.query(
          `SELECT a.user_name, a.user_email, a.expires_at, c.moodle_course_id, c.name AS course_name
           FROM activations a
           LEFT JOIN courses c ON c.id = a.course_id
           WHERE a.id=$1`, [row.id]
        );
        if (actResult.rowCount === 0) continue;
        const act = actResult.rows[0];

        const nameParts = (act.user_name || '').trim().split(/\s+/);
        const moodleResult = await moodleService.enrollStudent({
          email:          act.user_email,
          firstName:      nameParts[0] || act.user_email.split('@')[0],
          lastName:       nameParts.slice(1).join(' ') || 'Student',
          moodleCourseId: act.moodle_course_id,
          expiresAt:      act.expires_at
        });

        results.attempted++;
        const ok = moodleResult.enrolled || moodleResult.mocked;
        if (ok) results.succeeded++;
        else    results.failed++;

        await pool.query(
          `UPDATE activations
           SET moodle_status=$1, moodle_user_id=$2, moodle_error=$3,
               moodle_enrolled_at=$4, moodle_retried_at=NOW(),
               moodle_retry_count = moodle_retry_count + 1,
               moodle_username=COALESCE($5, moodle_username),
               moodle_temp_password=COALESCE($6, moodle_temp_password)
           WHERE id=$7`,
          [
            ok ? (moodleResult.mocked ? 'MOCKED' : 'ENROLLED') : 'FAILED',
            moodleResult.moodleUserId || null,
            ok ? null : moodleResult.error,
            ok ? new Date() : null,
            ok ? (moodleResult.moodleUsername    || null) : null,
            ok ? (moodleResult.moodleTempPassword || null) : null,
            row.id
          ]
        );

        // Correo de bienvenida: solo si el retry creó una cuenta nueva en Moodle (no bloqueante)
        if (moodleResult.createdNewUser && moodleResult.moodleTempPassword) {
          await sendStudentWelcomeEmail({
            activationId: row.id,
            to:           act.user_email,
            studentName:  act.user_name,
            courseName:   act.course_name,
            username:     moodleResult.moodleUsername,
            tempPassword: moodleResult.moodleTempPassword,
            expiresAt:    act.expires_at,
            userId:       req.user.sub,
            req
          });
        }
      }

      await logSystemEvent('MOODLE_BULK_RETRY', 'MOODLE', req.user.sub, null, null,
        results, 'SUCCESS', null, req);
      res.json({ ok: true, ...results });
    } catch (e) {
      console.error('❌ Error en bulk Moodle retry:', e);
      res.status(500).json({ error: 'Error en reintento masivo' });
    }
  }
);

// ── Vouchers de cortesía y compras externas ───────────────────────────────────

const EXTERNAL_PAYMENT_METHODS = ['bank_transfer', 'cash', 'invoice'];
const ADJUSTABLE_PAYMENT_METHODS = [...EXTERNAL_PAYMENT_METHODS, 'complimentary'];

// POST /admin/partners/:id/vouchers/complimentary
app.post('/admin/partners/:id/vouchers/complimentary',
  authenticate, requirePermission('financial_ops', 'edit'), apiLimiter,
  param('id').isInt({ min: 1 }),
  body('quantity').isInt({ min: 1, max: 500 }).withMessage('quantity debe ser entre 1 y 500'),
  body('reason').trim().notEmpty().withMessage('reason es obligatorio'),
  handleValidationErrors,
  async (req, res) => {
    const partnerId = parseInt(req.params.id, 10);
    const { quantity, reason } = req.body;
    try {
      const partnerRow = await pool.query('SELECT id, name FROM partners WHERE id=$1', [partnerId]);
      if (partnerRow.rowCount === 0) return res.status(404).json({ error: 'Partner no encontrado' });

      const purchaseRes = await pool.query(
        `INSERT INTO purchases (partner_id, qty, total_price, status, payment_method)
         VALUES ($1, $2, 0, 'PAID', 'complimentary') RETURNING id`,
        [partnerId, quantity]
      );
      const purchaseId = purchaseRes.rows[0].id;

      for (let i = 0; i < quantity; i++) {
        await pool.query(
          `INSERT INTO vouchers (partner_id, purchase_id, code, status, voucher_type, complimentary_reason, complimentary_issued_by)
           VALUES ($1, $2, $3, 'AVAILABLE', 'COMPLIMENTARY', $4, $5)`,
          [partnerId, purchaseId, generateVoucherCode(), reason, req.user.sub]
        );
      }

      await logSystemEvent('COMPLIMENTARY_VOUCHERS_ISSUED', 'VOUCHER', req.user.sub, null, purchaseId,
        { partner_id: partnerId, partner_name: partnerRow.rows[0].name, quantity, reason },
        'SUCCESS', null, req);

      res.json({ ok: true, purchase_id: purchaseId, vouchers_created: quantity });
    } catch (e) {
      console.error('❌ Error emitiendo vouchers de cortesía:', e);
      res.status(500).json({ error: 'Error al emitir vouchers de cortesía' });
    }
  }
);

// POST /admin/partners/:id/purchases/external
app.post('/admin/partners/:id/purchases/external',
  authenticate, requirePermission('financial_ops', 'edit'), apiLimiter,
  param('id').isInt({ min: 1 }),
  body('qty').isInt({ min: 1, max: 10000 }).withMessage('qty debe ser entre 1 y 10000'),
  body('total_price').isFloat({ min: 0 }).withMessage('total_price debe ser un número positivo'),
  body('payment_method').isIn(EXTERNAL_PAYMENT_METHODS).withMessage(`payment_method debe ser: ${EXTERNAL_PAYMENT_METHODS.join(', ')}`),
  body('external_reference').optional().trim(),
  body('notes').optional().trim(),
  handleValidationErrors,
  async (req, res) => {
    const partnerId = parseInt(req.params.id, 10);
    const { qty, total_price, payment_method, external_reference, notes } = req.body;
    try {
      const partnerRow = await pool.query('SELECT id, name FROM partners WHERE id=$1', [partnerId]);
      if (partnerRow.rowCount === 0) return res.status(404).json({ error: 'Partner no encontrado' });

      const purchaseRes = await pool.query(
        `INSERT INTO purchases (partner_id, qty, total_price, status, payment_method, external_reference, notes)
         VALUES ($1, $2, $3, 'PAID', $4, $5, $6) RETURNING id`,
        [partnerId, qty, total_price, payment_method, external_reference || null, notes || null]
      );
      const purchaseId = purchaseRes.rows[0].id;

      for (let i = 0; i < qty; i++) {
        await pool.query(
          `INSERT INTO vouchers (partner_id, purchase_id, code, status, voucher_type)
           VALUES ($1, $2, $3, 'AVAILABLE', 'STANDARD')`,
          [partnerId, purchaseId, generateVoucherCode()]
        );
      }

      await logSystemEvent('EXTERNAL_PURCHASE_CREATED', 'PURCHASE', req.user.sub, null, purchaseId,
        { partner_id: partnerId, partner_name: partnerRow.rows[0].name, qty, total_price, payment_method, external_reference },
        'SUCCESS', null, req);

      res.json({ ok: true, purchase_id: purchaseId, vouchers_created: qty, total_price });
    } catch (e) {
      console.error('❌ Error registrando compra externa:', e);
      res.status(500).json({ error: 'Error al registrar compra externa' });
    }
  }
);

// PUT /admin/purchases/:id/adjust  — corregir compras externas o de cortesía
app.put('/admin/purchases/:id/adjust',
  authenticate, requirePermission('financial_ops', 'edit'), apiLimiter,
  param('id').isInt({ min: 1 }),
  body('partner_id').optional().isInt({ min: 1 }),
  body('qty').optional().isInt({ min: 1, max: 10000 }),
  body('total_price').optional().isFloat({ min: 0 }),
  body('payment_method').optional().isIn(ADJUSTABLE_PAYMENT_METHODS),
  body('external_reference').optional().trim(),
  body('notes').optional().trim(),
  body('complimentary_reason').optional().trim(),
  handleValidationErrors,
  async (req, res) => {
    const purchaseId = parseInt(req.params.id, 10);
    try {
      const existing = await pool.query(
        'SELECT id, payment_method, qty, total_price, external_reference, notes FROM purchases WHERE id=$1',
        [purchaseId]
      );
      if (existing.rowCount === 0) return res.status(404).json({ error: 'Compra no encontrada' });

      const current = existing.rows[0];
      if (!ADJUSTABLE_PAYMENT_METHODS.includes(current.payment_method)) {
        return res.status(400).json({ error: 'Solo se pueden ajustar compras externas o de cortesía, no las de Stripe' });
      }

      const { partner_id, qty, total_price, payment_method, external_reference, notes, complimentary_reason } = req.body;

      // Validar partner si se proveyó
      if (partner_id !== undefined) {
        const partnerCheck = await pool.query('SELECT id FROM partners WHERE id=$1', [partner_id]);
        if (partnerCheck.rowCount === 0) return res.status(400).json({ error: 'Partner no encontrado' });
      }

      // Construir diff solo con los campos provistos
      const changes = {};
      if (partner_id       !== undefined) changes.partner_id       = { from: current.partner_id,       to: partner_id };
      if (qty              !== undefined) changes.qty              = { from: current.qty,              to: qty };
      if (total_price      !== undefined) changes.total_price      = { from: current.total_price,      to: total_price };
      if (payment_method   !== undefined) changes.payment_method   = { from: current.payment_method,   to: payment_method };
      if (external_reference !== undefined) changes.external_reference = { from: current.external_reference, to: external_reference };
      if (notes            !== undefined) changes.notes            = { from: current.notes,            to: notes };

      if (Object.keys(changes).length === 0 && complimentary_reason === undefined) {
        return res.status(400).json({ error: 'No se proveyó ningún campo a actualizar' });
      }

      // Reconciliación previa: validar que qty reducida sea alcanzable
      if (qty !== undefined && qty < current.qty) {
        const voucherCounts = await pool.query(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status='AVAILABLE') AS available
           FROM vouchers WHERE purchase_id=$1`,
          [purchaseId]
        );
        const totalVouchers = parseInt(voucherCounts.rows[0].total, 10);
        const availableVouchers = parseInt(voucherCounts.rows[0].available, 10);
        const toDelete = totalVouchers - qty;
        if (toDelete > availableVouchers) {
          return res.status(400).json({
            error: `No se puede reducir a ${qty} vouchers: ${totalVouchers - availableVouchers} ya fueron consumidos y no se pueden eliminar`
          });
        }
      }

      // UPDATE compra
      await pool.query(
        `UPDATE purchases SET
           partner_id        = COALESCE($1, partner_id),
           qty               = COALESCE($2, qty),
           total_price       = COALESCE($3, total_price),
           payment_method    = COALESCE($4, payment_method),
           external_reference = COALESCE($5, external_reference),
           notes             = COALESCE($6, notes),
           updated_at        = NOW()
         WHERE id=$7`,
        [
          partner_id       !== undefined ? partner_id       : null,
          qty              !== undefined ? qty              : null,
          total_price      !== undefined ? total_price      : null,
          payment_method   !== undefined ? payment_method   : null,
          external_reference !== undefined ? external_reference : null,
          notes            !== undefined ? notes            : null,
          purchaseId
        ]
      );

      // Si es de cortesía y se actualiza la razón, actualizar en todos sus vouchers
      if (complimentary_reason !== undefined && current.payment_method === 'complimentary') {
        changes.complimentary_reason = { to: complimentary_reason };
        await pool.query(
          `UPDATE vouchers SET complimentary_reason=$1 WHERE purchase_id=$2`,
          [complimentary_reason, purchaseId]
        );
      }

      // Reconciliación de vouchers si qty cambió
      if (qty !== undefined && qty !== current.qty) {
        const voucherRow = await pool.query(
          'SELECT COUNT(*) AS total FROM vouchers WHERE purchase_id=$1',
          [purchaseId]
        );
        const currentVoucherCount = parseInt(voucherRow.rows[0].total, 10);
        const effectivePartnerId = partner_id !== undefined ? partner_id : current.partner_id;
        const effectiveMethod    = payment_method !== undefined ? payment_method : current.payment_method;

        if (qty > currentVoucherCount) {
          // Crear vouchers faltantes
          const toCreate = qty - currentVoucherCount;
          const isComplimentary = effectiveMethod === 'complimentary';

          if (isComplimentary) {
            const reasonRow = await pool.query(
              'SELECT complimentary_reason, complimentary_issued_by FROM vouchers WHERE purchase_id=$1 LIMIT 1',
              [purchaseId]
            );
            const reason   = complimentary_reason || (reasonRow.rowCount > 0 ? reasonRow.rows[0].complimentary_reason : 'Ajuste');
            const issuedBy = reasonRow.rowCount > 0 ? reasonRow.rows[0].complimentary_issued_by : req.user.sub;
            for (let i = 0; i < toCreate; i++) {
              await pool.query(
                `INSERT INTO vouchers (partner_id, purchase_id, code, status, voucher_type, complimentary_reason, complimentary_issued_by)
                 VALUES ($1, $2, $3, 'AVAILABLE', 'COMPLIMENTARY', $4, $5)`,
                [effectivePartnerId, purchaseId, generateVoucherCode(), reason, issuedBy]
              );
            }
          } else {
            for (let i = 0; i < toCreate; i++) {
              await pool.query(
                `INSERT INTO vouchers (partner_id, purchase_id, code, status, voucher_type)
                 VALUES ($1, $2, $3, 'AVAILABLE', 'STANDARD')`,
                [effectivePartnerId, purchaseId, generateVoucherCode()]
              );
            }
          }
          changes.vouchers_created = toCreate;

        } else if (qty < currentVoucherCount) {
          // Eliminar vouchers AVAILABLE sobrantes (los más recientes primero)
          const toDelete = currentVoucherCount - qty;
          const availableRows = await pool.query(
            'SELECT id FROM vouchers WHERE purchase_id=$1 AND status=$2 ORDER BY id DESC LIMIT $3',
            [purchaseId, 'AVAILABLE', toDelete]
          );
          const idsToDelete = availableRows.rows.map(r => r.id);
          if (idsToDelete.length > 0) {
            await pool.query('DELETE FROM vouchers WHERE id = ANY($1)', [idsToDelete]);
          }
          changes.vouchers_deleted = idsToDelete.length;
        }
      }

      await logSystemEvent('PURCHASE_ADJUSTED', 'PURCHASE', req.user.sub, null, purchaseId,
        { purchase_id: purchaseId, changes }, 'SUCCESS', null, req);

      const updated = await pool.query(
        `SELECT p.id, p.partner_id, p.qty, p.total_price, p.status, p.payment_method,
                p.external_reference, p.notes,
                COUNT(v.id)::int AS vouchers_total,
                COUNT(v.id) FILTER (WHERE v.status='AVAILABLE')::int AS vouchers_available,
                COUNT(v.id) FILTER (WHERE v.status='CONSUMED')::int  AS vouchers_consumed
         FROM purchases p
         LEFT JOIN vouchers v ON v.purchase_id = p.id
         WHERE p.id=$1
         GROUP BY p.id`,
        [purchaseId]
      );
      res.json({ ok: true, purchase: updated.rows[0], changes });
    } catch (e) {
      console.error('❌ Error ajustando compra:', e);
      res.status(500).json({ error: 'Error al ajustar la compra' });
    }
  }
);

// GET /admin/purchases/:id  — detalle de una compra
app.get('/admin/purchases/:id',
  authenticate, requirePermission('financial_ops', 'view'), apiLimiter,
  param('id').isInt({ min: 1 }),
  handleValidationErrors,
  async (req, res) => {
    const purchaseId = parseInt(req.params.id, 10);
    try {
      const result = await pool.query(
        `SELECT p.id, p.partner_id, pr.name AS partner_name, p.qty, p.total_price,
                p.status, p.payment_method, p.external_reference, p.notes,
                p.stripe_status, p.created_at, p.updated_at,
                COUNT(v.id)::int AS vouchers_total,
                COUNT(v.id) FILTER (WHERE v.status='AVAILABLE')::int AS vouchers_available,
                COUNT(v.id) FILTER (WHERE v.status='CONSUMED')::int  AS vouchers_consumed
         FROM purchases p
         JOIN partners pr ON pr.id = p.partner_id
         LEFT JOIN vouchers v ON v.purchase_id = p.id
         WHERE p.id=$1
         GROUP BY p.id, pr.name`,
        [purchaseId]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Compra no encontrada' });
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'Error al obtener detalle de compra' });
    }
  }
);

// ── Moodle completion sync ────────────────────────────────────────────────────

/**
 * Core logic: iterate ENROLLED activations and check completion in Moodle.
 * Returns { checked, completed, errors, skipped }.
 * Safe to call concurrently — uses moodle_completion_synced_at to avoid hammering.
 */
async function syncMoodleCompletions({ force = false } = {}) {
  const result = { checked: 0, course_completed: 0, completed: 0, errors: 0, skipped: 0 };

  // Chequea activaciones ENROLLED y COURSE_COMPLETED (ambas pendientes de avanzar)
  const minInterval = force ? null : new Date(Date.now() - 4 * 60 * 60 * 1000);
  const params = [];
  let whereExtra = '';
  if (minInterval) {
    params.push(minInterval);
    whereExtra = `AND (a.moodle_completion_synced_at IS NULL OR a.moodle_completion_synced_at < $1)`;
  }

  const rows = await pool.query(
    `SELECT a.id, a.moodle_user_id, a.moodle_status, c.moodle_course_id
     FROM activations a
     JOIN courses c ON c.id = a.course_id
     WHERE a.moodle_status IN ('ENROLLED', 'COURSE_COMPLETED')
       AND a.moodle_user_id IS NOT NULL
       AND c.moodle_course_id IS NOT NULL
       ${whereExtra}
     ORDER BY a.id`,
    params
  );

  for (const act of rows.rows) {
    result.checked++;

    // ── Nivel 2: ¿aprobó el quiz? → COMPLETED ──────────────────────────────
    // Busca el quiz del curso en Moodle para obtener su ID
    const quizResult = await moodleService.getCourseQuizzes(act.moodle_course_id);
    if (!quizResult.error && quizResult.quizzes.length > 0) {
      const quiz      = quizResult.quizzes[0];
      const gradeResult = await moodleService.getUserQuizBestGrade(
        act.moodle_user_id, quiz.id, 60
      );

      if (gradeResult.error) {
        result.errors++;
        await pool.query(`UPDATE activations SET moodle_completion_synced_at=NOW() WHERE id=$1`, [act.id]);
        continue;
      }

      if (gradeResult.passed) {
        result.completed++;
        await pool.query(
          `UPDATE activations
           SET moodle_status='COMPLETED',
               moodle_completed_at=NOW(),
               moodle_completion_synced_at=NOW()
           WHERE id=$1`,
          [act.id]
        );
        continue;
      }
    }

    // ── Nivel 1: ¿vio el contenido del curso? → COURSE_COMPLETED ───────────
    if (act.moodle_status === 'ENROLLED') {
      const activitiesResult = await moodleService.getActivitiesCompletion(
        act.moodle_user_id, act.moodle_course_id
      );

      if (activitiesResult.error) {
        result.errors++;
        await pool.query(`UPDATE activations SET moodle_completion_synced_at=NOW() WHERE id=$1`, [act.id]);
        continue;
      }

      // Busca si alguna actividad tipo 'page' está completada (state >= 1)
      const pageCompleted = activitiesResult.activities.some(
        a => a.modname === 'page' && a.state >= 1
      );

      if (pageCompleted) {
        result.course_completed++;
        await pool.query(
          `UPDATE activations
           SET moodle_status='COURSE_COMPLETED',
               moodle_completion_synced_at=NOW()
           WHERE id=$1`,
          [act.id]
        );
        continue;
      }
    }

    // Sin cambio aún
    result.skipped++;
    await pool.query(`UPDATE activations SET moodle_completion_synced_at=NOW() WHERE id=$1`, [act.id]);
  }

  return result;
}

// Admin: sync completion status for all ENROLLED activations
app.post('/admin/moodle/sync-completions',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    try {
      const force = req.query.force === 'true' || req.body?.force === true;
      const syncResult = await syncMoodleCompletions({ force });

      await logSystemEvent(
        'MOODLE_COMPLETION_SYNC', 'MOODLE', req.user.sub, null, null,
        syncResult, 'SUCCESS', null, req
      );

      res.json({ ok: true, ...syncResult });
    } catch (e) {
      console.error('❌ Error syncing Moodle completions:', e);
      res.status(500).json({ error: 'Error al sincronizar completaciones de Moodle' });
    }
  }
);

// Admin: test Moodle connection
app.get('/admin/moodle/test-connection',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    const result = await moodleService.testConnection();
    if (result.error) return res.status(502).json({ ok: false, error: result.error });
    res.json({ ok: true, sitename: result.sitename, username: result.username, mock: moodleService.isMockMode() });
  }
);

// Admin: preview courses available in Moodle (no DB changes)
app.get('/admin/moodle/courses',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    const result = await moodleService.getCourses();
    if (result.error) return res.status(502).json({ ok: false, error: result.error });
    res.json({ ok: true, courses: result.courses, total: result.courses.length });
  }
);

// Shared sync logic (used by endpoint and auto-sync)
async function syncMoodleCourses() {
  const result = await moodleService.getCourses();
  if (result.error) return { ok: false, error: result.error };

  const created = [], updated = [], deactivated = [], skipped = [];
  const activeMoodleIds = new Set();

  for (const mc of result.courses) {
    if (!mc.visible) { skipped.push({ moodle_id: mc.id, reason: 'hidden' }); continue; }
    const name = (mc.fullname || mc.shortname || '').trim();
    if (!name) { skipped.push({ moodle_id: mc.id, reason: 'no_name' }); continue; }
    activeMoodleIds.add(mc.id);

    const existing = await pool.query(
      'SELECT id, name, active FROM courses WHERE moodle_course_id = $1', [mc.id]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      const nameChanged   = row.name !== name;
      const needsActivate = !row.active;
      if (nameChanged || needsActivate) {
        await pool.query('UPDATE courses SET name=$1, active=TRUE, updated_at=NOW() WHERE moodle_course_id=$2', [name, mc.id]);
        updated.push({ moodle_id: mc.id, name, reactivated: needsActivate });
      } else {
        skipped.push({ moodle_id: mc.id, reason: 'unchanged' });
      }
    } else {
      const ins = await pool.query(
        'INSERT INTO courses (name, moodle_course_id, active) VALUES ($1,$2,TRUE) RETURNING id',
        [name, mc.id]
      );
      created.push({ id: ins.rows[0].id, moodle_id: mc.id, name });
    }
  }

  // Deactivate courses that no longer exist in Moodle
  // (only affects courses that have a moodle_course_id — manual courses are untouched)
  const linkedCourses = await pool.query(
    'SELECT id, name, moodle_course_id FROM courses WHERE moodle_course_id IS NOT NULL AND active = TRUE'
  );
  for (const c of linkedCourses.rows) {
    if (!activeMoodleIds.has(c.moodle_course_id)) {
      await pool.query('UPDATE courses SET active=FALSE, updated_at=NOW() WHERE id=$1', [c.id]);
      deactivated.push({ id: c.id, moodle_id: c.moodle_course_id, name: c.name });
    }
  }

  return { ok: true, created, updated, deactivated, skipped, total_moodle: result.courses.length };
}

// Admin: sync Moodle courses into platform courses table
app.post('/admin/moodle/sync-courses',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    const result = await syncMoodleCourses();
    if (!result.ok) return res.status(502).json(result);
    await logSystemEvent('MOODLE_COURSES_SYNCED', 'MOODLE', req.user.sub, null, null,
      { created: result.created.length, updated: result.updated.length, deactivated: result.deactivated.length },
      'SUCCESS', null, req);
    res.json(result);
  }
);

// Admin: map a platform course to a Moodle course ID
app.put('/admin/courses/:id/moodle-mapping',
  authenticate, requireRole('admin'), apiLimiter,
  param('id').isInt({ min: 1 }).withMessage('Course ID inválido'),
  body('moodle_course_id').isInt({ min: 1 }).withMessage('moodle_course_id debe ser un entero positivo'),
  handleValidationErrors,
  async (req, res) => {
    const { id } = req.params;
    const { moodle_course_id } = req.body;
    try {
      const result = await pool.query(
        'UPDATE courses SET moodle_course_id=$1 WHERE id=$2 RETURNING id, name, moodle_course_id',
        [moodle_course_id, id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Curso no encontrado' });
      }
      await logSystemEvent('COURSE_MOODLE_MAPPING_UPDATED', 'MOODLE', req.user.sub, null, null,
        { course_id: parseInt(id, 10), moodle_course_id }, 'SUCCESS', null, req);
      res.json({ ok: true, course: result.rows[0] });
    } catch (e) {
      res.status(500).json({ error: 'Error al actualizar mapping de Moodle' });
    }
  }
);

// Admin: full activations context (voucher + partner + course + moodle)
app.get('/admin/activations',
  authenticate, requireRole('admin'), apiLimiter,
  async (req, res) => {
    try {
      const { partner_id, moodle_status, course_id, limit = 50, offset = 0 } = req.query;
      const filterConds = [];
      const filterVals  = [];

      if (partner_id)    { filterVals.push(parseInt(partner_id, 10)); filterConds.push(`pr.id=$${filterVals.length}`); }
      if (moodle_status) { filterVals.push(moodle_status.toUpperCase()); filterConds.push(`a.moodle_status=$${filterVals.length}`); }
      if (course_id)     { filterVals.push(parseInt(course_id, 10)); filterConds.push(`a.course_id=$${filterVals.length}`); }

      const whereClause = filterConds.length ? filterConds.join(' AND ') : '1=1';

      const result = await pool.query(
        `SELECT
           a.id                  AS activation_id,
           a.activated_at,
           a.user_name,
           a.user_email,
           a.final_client,
           a.moodle_status,
           a.moodle_user_id,
           a.moodle_error,
           a.moodle_enrolled_at,
           a.moodle_retry_count,
           a.moodle_username,
           a.moodle_temp_password,
           a.moodle_completed_at,
           a.moodle_completion_synced_at,
           a.expires_at,
           a.activation_status,
           v.id                  AS voucher_id,
           v.code                AS voucher_code,
           v.purchase_id,
           c.id                  AS course_id,
           c.name                AS course_name,
           c.moodle_course_id,
           pr.id                 AS partner_id,
           pr.name               AS partner_name,
           pr.email              AS partner_email
         FROM activations a
         JOIN vouchers v  ON v.id = a.voucher_id
         JOIN courses  c  ON c.id = a.course_id
         JOIN partners pr ON pr.id = v.partner_id
         WHERE ${whereClause}
         ORDER BY a.activated_at DESC
         LIMIT $${filterVals.length + 1} OFFSET $${filterVals.length + 2}`,
        [...filterVals, parseInt(limit, 10), parseInt(offset, 10)]
      );

      const countRes = await pool.query(
        `SELECT COUNT(*) FROM activations a
         JOIN vouchers v  ON v.id = a.voucher_id
         JOIN courses  c  ON c.id = a.course_id
         JOIN partners pr ON pr.id = v.partner_id
         WHERE ${whereClause}`,
        filterVals
      );

      res.json({
        activations: result.rows,
        total: parseInt(countRes.rows[0].count, 10)
      });
    } catch (e) {
      console.error('❌ Error fetching admin activations:', e);
      res.status(500).json({ error: 'Error al obtener activaciones' });
    }
  }
);

// Partner: stats/statistics
app.get('/partner/:id/stats', authenticate, async (req,res)=>{
  const pid = req.params.id;
  try{
    const r = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS total,
        COUNT(*) FILTER (WHERE v.status='CONSUMED')::int                       AS used,
        COUNT(*) FILTER (WHERE v.status='AVAILABLE')::int                      AS available,
        COUNT(*) FILTER (WHERE v.voucher_type='COMPLIMENTARY')::int            AS complimentary,
        (SELECT COUNT(*)::int FROM activations a
           INNER JOIN vouchers vv ON vv.id = a.voucher_id
           WHERE vv.partner_id = $1 AND a.moodle_status = 'COMPLETED')        AS completed_courses,
        (SELECT COUNT(DISTINCT a.course_id)::int FROM activations a
           INNER JOIN vouchers vv ON vv.id = a.voucher_id
           WHERE vv.partner_id = $1 AND a.moodle_status = 'COMPLETED')        AS completed_unique_courses
      FROM vouchers v WHERE v.partner_id = $1
    `, [pid]);
    const row = r.rows[0] || {};
    res.json({
      total:                   row.total                   || 0,
      used:                    row.used                    || 0,
      available:               row.available               || 0,
      complimentary:           row.complimentary           || 0,
      completed_courses:       row.completed_courses       || 0,
      completed_unique_courses:row.completed_unique_courses|| 0
    });
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

// Admin: vouchers by partner summary
app.get('/admin/partners/:id/summary', async (req,res)=>{
  const pid = req.params.id;
  const total = await pool.query('SELECT count(*) FROM vouchers WHERE partner_id=$1',[pid]);
  const consumed = await pool.query("SELECT count(*) FROM vouchers WHERE partner_id=$1 AND status='CONSUMED'",[pid]);
  res.json({ total: parseInt(total.rows[0].count), consumed: parseInt(consumed.rows[0].count), available: parseInt(total.rows[0].count)-parseInt(consumed.rows[0].count) });
});

// Admin: partner stats (alias for summary with different response format)
app.get('/admin/partners/:id/stats', authenticate, requireRole('admin'), async (req,res)=>{
  const pid = req.params.id;
  try{
    const r = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS total,
        COUNT(*) FILTER (WHERE v.status='CONSUMED')::int                       AS used,
        COUNT(*) FILTER (WHERE v.status='AVAILABLE')::int                      AS available,
        COUNT(*) FILTER (WHERE v.voucher_type='COMPLIMENTARY')::int            AS complimentary,
        (SELECT COUNT(*)::int FROM activations a
           INNER JOIN vouchers vv ON vv.id = a.voucher_id
           WHERE vv.partner_id = $1 AND a.moodle_status = 'COMPLETED')        AS completed_courses,
        (SELECT COUNT(DISTINCT a.course_id)::int FROM activations a
           INNER JOIN vouchers vv ON vv.id = a.voucher_id
           WHERE vv.partner_id = $1 AND a.moodle_status = 'COMPLETED')        AS completed_unique_courses
      FROM vouchers v WHERE v.partner_id = $1
    `, [pid]);
    const row = r.rows[0] || {};
    res.json({
      total:                   row.total                   || 0,
      used:                    row.used                    || 0,
      available:               row.available               || 0,
      complimentary:           row.complimentary           || 0,
      completed_courses:       row.completed_courses       || 0,
      completed_unique_courses:row.completed_unique_courses|| 0
    });
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

// Catalogs
app.get('/catalogs', async (req,res)=>{
  const r = await pool.query('SELECT * FROM catalogs');
  res.json(r.rows);
});

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
    
    // Check token expiration
    const tokenAge = Date.now() - new Date(row.created_at).getTime();
    const maxAge = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    if(tokenAge > maxAge) {
      await pool.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1',[row.id]);
      logSecurityEvent('REFRESH_FAILED', { reason: 'expired_token', ip: req.ip });
      await logSystemEvent('REFRESH_FAILED', 'AUTH', row.user_id, null, null, { reason: 'expired_token' }, 'FAILED', 'token_expired', req);
      return res.status(401).json({error:'token_expired'});
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
app.post('/admin/users', 
  authenticate, 
  requireRole('admin'),
  apiLimiter,
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('password')
    .isLength({ min: 8 }).withMessage('Contraseña debe tener al menos 8 caracteres')
    .matches(/[A-Z]/).withMessage('Contraseña debe contener al menos una mayúscula')
    .matches(/[a-z]/).withMessage('Contraseña debe contener al menos una minúscula')
    .matches(/[0-9]/).withMessage('Contraseña debe contener al menos un número')
    .matches(/[!@#$%^&*]/).withMessage('Contraseña debe contener al menos un caracter especial (!@#$%^&*)'),
  body('role').trim().isLength({ min: 2, max: 50 }).withMessage('Rol inválido'),
  body('partner_id').optional().isInt().withMessage('Partner ID debe ser un número'),
  body('first_name').optional().trim().isLength({ max: 100 }).withMessage('Nombre debe tener máximo 100 caracteres'),
  body('last_name').optional().trim().isLength({ max: 100 }).withMessage('Apellido debe tener máximo 100 caracteres'),
  handleValidationErrors,
  async (req,res)=>{
  const email = req.body.email;
  const password = req.body.password;
  const role = normalizeRoleName(req.body.role);
  const { partner_id, first_name, last_name, password_expires_days } = req.body;
  try{
        const roleExists = await pool.query('SELECT name FROM roles WHERE name=$1 AND active=TRUE', [role]);
        if (roleExists.rowCount === 0) {
          return res.status(400).json({ error: 'Rol inválido o desactivado' });
        }

    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email=$1',[email]);
    if(existing.rowCount > 0) {
      await logSystemEvent('USER_CREATE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, { email, role }, 'FAILED', 'Email ya registrado', req);
      return res.status(400).json({error:'Email ya registrado'});
    }

    let resolvedPartnerId = partner_id;

    if (resolvedPartnerId !== undefined && resolvedPartnerId !== null) {
      const partnerExists = await pool.query('SELECT id FROM partners WHERE id=$1', [resolvedPartnerId]);
      if (partnerExists.rowCount === 0) {
        await logSystemEvent('USER_CREATE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, { email, role, partner_id: resolvedPartnerId }, 'FAILED', 'Partner no encontrado', req);
        return res.status(400).json({ error: 'Partner no encontrado' });
      }
    }

    if (role === 'partner' && (resolvedPartnerId === undefined || resolvedPartnerId === null || resolvedPartnerId === '')) {
      const existingPartnerByEmail = await pool.query('SELECT id FROM partners WHERE LOWER(email)=LOWER($1) LIMIT 1', [email]);
      if (existingPartnerByEmail.rowCount > 0) {
        resolvedPartnerId = existingPartnerByEmail.rows[0].id;
      } else {
        const defaultPricingProfileId = await getDefaultPricingProfileId();
        const partnerName = [first_name, last_name].filter(Boolean).join(' ').trim() || email.split('@')[0];
        const createdPartner = await pool.query(
          'INSERT INTO partners (name,email,pricing_profile_id) VALUES ($1,$2,$3) RETURNING id',
          [partnerName, email, defaultPricingProfileId]
        );
        resolvedPartnerId = createdPartner.rows[0].id;
      }
    }

    const hash = await bcrypt.hash(password, 10);
    // Siempre forzar cambio en primer inicio para usuarios nuevos
    const mustChangePassword = true;

    // Calcular password_expires_at: usar días del request, o bien la política global
    let expiryDays = parseInt(password_expires_days) || 0;
    if (expiryDays === 0) {
      const policyR = await pool.query("SELECT value FROM system_settings WHERE key='password_expiry_days'");
      expiryDays = policyR.rows.length ? parseInt(policyR.rows[0].value) || 0 : 0;
    }

    const r = await pool.query(
      `INSERT INTO users (email,password,role,partner_id,first_name,last_name,must_change_password,password_expires_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8>0 THEN NOW() + ($8 * INTERVAL '1 day') ELSE NULL END, NOW())
       RETURNING id,email,role,partner_id,first_name,last_name,must_change_password,password_expires_at`,
      [email, hash, role, resolvedPartnerId || null, first_name||null, last_name||null, mustChangePassword, expiryDays]
    );
    const userId = r.rows[0].id;
    
    if (role === 'partner') {
      // Solo usuarios partner se sincronizan con Stripe.
      try {
        const displayName = [first_name, last_name].filter(Boolean).join(' ') || email.split('@')[0];
        const stripeCustomerId = await syncUserWithStripe(email, displayName, userId);
        await logSystemEvent('USER_CREATED', 'USER_MANAGEMENT', userId, stripeCustomerId, null, { email, role, partnerId: resolvedPartnerId || null }, 'SUCCESS', null, req);

        // Return user with stripe customer id
        const userWithStripe = await pool.query('SELECT id, email, role, partner_id, stripe_customer_id FROM users WHERE id=$1', [userId]);
        res.json(userWithStripe.rows[0]);
      } catch (stripeError) {
        console.error('⚠️ Advertencia: Usuario partner creado pero sincronización con Stripe falló:', stripeError.message);
        await logSystemEvent('USER_CREATED_STRIPE_SYNC_FAILED', 'USER_MANAGEMENT', userId, null, null, { email, role, error: stripeError.message }, 'PARTIAL_SUCCESS', stripeError.message, req);

        // Return user anyway (Stripe sync is not critical)
        const userWithoutStripe = await pool.query('SELECT id, email, role, partner_id, stripe_customer_id FROM users WHERE id=$1', [userId]);
        res.json(userWithoutStripe.rows[0]);
      }
    } else {
      await logSystemEvent('USER_CREATED', 'USER_MANAGEMENT', userId, null, null, { email, role, partnerId: resolvedPartnerId || null }, 'SUCCESS', null, req);
      const userCreated = await pool.query('SELECT id, email, role, partner_id, stripe_customer_id FROM users WHERE id=$1', [userId]);
      res.json(userCreated.rows[0]);
    }
    
    logSecurityEvent('USER_CREATED', { userId, email, role, adminId: req.user.sub });
  }catch(e){ 
    await logSystemEvent('USER_CREATE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, { email, role }, 'FAILED', e.message, req);
    logSecurityEvent('USER_CREATE_ERROR', { error: e.message, adminId: req.user.sub });
    res.status(400).json({error:'Error al crear usuario'}); 
  }
});

// List all users (admin)
app.get('/admin/users', authenticate, requireRole('admin'), apiLimiter, async (req,res)=>{
  try{
    const r = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.partner_id, u.stripe_customer_id,
              u.must_change_password, u.first_login_at, u.created_at,
              u.password_expires_at, COALESCE(u.active, TRUE) AS active,
              COALESCE(r.permissions, '{}'::jsonb) AS role_permissions,
              p.name AS partner_name,
              base.name AS pricing_profile_name,
              base.code AS pricing_profile_code,
              special.name AS special_pricing_profile_name,
              special.code AS special_pricing_profile_code
       FROM users u
       LEFT JOIN roles r ON r.name = u.role
       LEFT JOIN partners p ON p.id = u.partner_id
       LEFT JOIN pricing_profiles base ON base.id = p.pricing_profile_id
       LEFT JOIN pricing_profiles special ON special.id = p.special_pricing_profile_id
       ORDER BY u.created_at DESC`
    );
    res.json(r.rows);
  }catch(e){ console.error('GET /admin/users error:', e); res.status(400).json({error:'Error al obtener usuarios'}); }
});

// Get specific user (admin)
app.get('/admin/users/:id', authenticate, requireRole('admin'), apiLimiter, 
  param('id').isInt().withMessage('User ID inválido'),
  handleValidationErrors,
  async (req,res)=>{
  try{
    const r = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.partner_id, u.stripe_customer_id, u.must_change_password, u.first_login_at, u.created_at,
              COALESCE(rol.permissions, '{}'::jsonb) AS role_permissions,
              p.name AS partner_name,
              base.name AS pricing_profile_name,
              base.code AS pricing_profile_code,
              special.name AS special_pricing_profile_name,
              special.code AS special_pricing_profile_code
       FROM users u
       LEFT JOIN roles rol ON rol.name = u.role
       LEFT JOIN partners p ON p.id = u.partner_id
       LEFT JOIN pricing_profiles base ON base.id = p.pricing_profile_id
       LEFT JOIN pricing_profiles special ON special.id = p.special_pricing_profile_id
       WHERE u.id=$1`,
      [req.params.id]
    );
    if(r.rowCount === 0) return res.status(404).json({error:'Usuario no encontrado'});
    res.json(r.rows[0]);
  }catch(e){ res.status(400).json({error:'Error al obtener usuario'}); }
});

// Update user (admin) - can change password, role, partner_id, first_name, last_name, expiry
app.put('/admin/users/:id', authenticate, requireRole('admin'), async (req,res)=>{
  const userId = req.params.id;
  const { password, partner_id, first_name, last_name, active, must_change_password, password_expires_days } = req.body;
  const role = req.body.role !== undefined ? normalizeRoleName(req.body.role) : '';
  try{
    const currentUserQ = await pool.query('SELECT id, role, partner_id, email, first_name, last_name FROM users WHERE id=$1', [userId]);
    if(currentUserQ.rowCount === 0) return res.status(404).json({error:'User not found'});

    const currentUser = currentUserQ.rows[0];
    const nextRole = role || currentUser.role;
    let nextPartnerId = partner_id !== undefined ? (partner_id || null) : currentUser.partner_id;

    if (role) {
      const roleExists = await pool.query('SELECT name FROM roles WHERE name=$1 AND active=TRUE', [role]);
      if (roleExists.rowCount === 0) return res.status(400).json({ error: 'Rol inválido o desactivado' });
    }

    if (nextRole === 'partner' && !nextPartnerId) {
      // Auto-crear registro de partner si no existe
      const userEmail = currentUser.email;
      const existingByEmail = await pool.query('SELECT id FROM partners WHERE email=$1 LIMIT 1', [userEmail]);
      if(existingByEmail.rowCount > 0){
        nextPartnerId = existingByEmail.rows[0].id;
      } else {
        const partnerName = [first_name || currentUser.first_name, last_name || currentUser.last_name].filter(Boolean).join(' ').trim() || userEmail.split('@')[0];
        const defaultPricingProfileId = await getDefaultPricingProfileId();
        const newPartner = await pool.query(
          'INSERT INTO partners (name, email, pricing_profile_id) VALUES ($1, $2, $3) RETURNING id',
          [partnerName, userEmail, defaultPricingProfileId]
        );
        nextPartnerId = newPartner.rows[0].id;
      }
    }

    if(partner_id !== undefined && partner_id !== null){
      const partnerExists = await pool.query('SELECT id FROM partners WHERE id=$1', [partner_id]);
      if(partnerExists.rowCount === 0) return res.status(400).json({error:'Partner no encontrado'});
    }

    let query = 'UPDATE users SET ';
    let updates = [];
    let params = [];
    let paramNum = 1;

    if(password){
      const hash = await bcrypt.hash(password, 10);
      updates.push(`password = $${paramNum}`);
      params.push(hash);
      paramNum++;
    }
    if(role){
      updates.push(`role = $${paramNum}`);
      params.push(role);
      paramNum++;
    }
    if(partner_id !== undefined || nextPartnerId !== currentUser.partner_id){
      updates.push(`partner_id = $${paramNum}`);
      params.push(nextPartnerId || null);
      paramNum++;
    }
    if(first_name !== undefined){
      updates.push(`first_name = $${paramNum}`);
      params.push(first_name ? first_name.trim() : null);
      paramNum++;
    }
    if(last_name !== undefined){
      updates.push(`last_name = $${paramNum}`);
      params.push(last_name ? last_name.trim() : null);
      paramNum++;
    }
    if(active !== undefined){
      const nextActive = active === true || active === 'true';
      // Protección: no desactivar si es el único admin activo
      if (!nextActive && currentUser.role === 'admin') {
        const activeAdmins = await pool.query(
          "SELECT COUNT(*) FROM users WHERE role='admin' AND active=TRUE AND id != $1", [userId]
        );
        if (parseInt(activeAdmins.rows[0].count, 10) === 0) {
          return res.status(400).json({ error: 'No puedes desactivar al único administrador activo del sistema.' });
        }
      }
      updates.push(`active = $${paramNum}`);
      params.push(nextActive);
      paramNum++;
    }
    if(must_change_password !== undefined){
      updates.push(`must_change_password = $${paramNum}`);
      params.push(must_change_password === true || must_change_password === 'true');
      paramNum++;
    }
    if(password_expires_days !== undefined){
      const days = parseInt(password_expires_days) || 0;
      if(days > 0){
        updates.push(`password_expires_at = NOW() + ($${paramNum} * INTERVAL '1 day')`);
        params.push(days);
      } else {
        updates.push(`password_expires_at = NULL`);
      }
      paramNum++;
    }

    if(updates.length === 0) return res.status(400).json({error:'No fields to update'});

    query += updates.join(', ') + `, updated_at=NOW() WHERE id = $${paramNum} RETURNING id,email,role,partner_id,first_name,last_name`;
    params.push(userId);

    const r = await pool.query(query, params);
    if(r.rowCount === 0) return res.status(404).json({error:'User not found'});
    await logSystemEvent('USER_UPDATED', 'USER_MANAGEMENT', req.user.sub, null, null, {
      updated_user_id: parseInt(userId, 10),
      changed_fields: Object.keys(req.body || {})
    }, 'SUCCESS', null, req);
    res.json(r.rows[0]);
  }catch(e){
    await logSystemEvent('USER_UPDATE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, {
      updated_user_id: parseInt(userId, 10)
    }, 'FAILED', e.message, req);
    res.status(400).json({error:e.message});
  }
});

// Política global de contraseñas
app.get('/admin/password-policy', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query("SELECT key, value FROM system_settings WHERE key='password_expiry_days'");
    const expiryDays = r.rows.length ? parseInt(r.rows[0].value) || 0 : 0;
    res.json({ expiry_days: expiryDays });
  } catch(e) { res.status(500).json({ error: 'Error al obtener política de contraseñas' }); }
});

app.put('/admin/password-policy', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const expiryDays = Math.max(0, parseInt(req.body.expiry_days) || 0);
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('password_expiry_days', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [String(expiryDays)]
    );
    await logSystemEvent('PASSWORD_POLICY_UPDATED', 'USER_MANAGEMENT', req.user.sub, null, null,
      { expiry_days: expiryDays }, 'SUCCESS', null, req);
    res.json({ ok: true, expiry_days: expiryDays });
  } catch(e) { res.status(500).json({ error: 'Error al guardar política de contraseñas' }); }
});

// Configuración de activación (partner la lee, admin la escribe)
app.get('/partner/settings', authenticate, requireRole('partner'), async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='max_activation_months'");
    const maxMonths = r.rows.length ? (parseInt(r.rows[0].value) || 12) : 12;
    res.json({ max_activation_months: maxMonths });
  } catch(e) { res.status(500).json({ error: 'Error al obtener configuración' }); }
});

app.get('/admin/settings/activation', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='max_activation_months'");
    const maxMonths = r.rows.length ? (parseInt(r.rows[0].value) || 12) : 12;
    res.json({ max_activation_months: maxMonths });
  } catch(e) { res.status(500).json({ error: 'Error al obtener configuración' }); }
});

app.put('/admin/settings/activation', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const maxMonths = Math.min(120, Math.max(1, parseInt(req.body.max_activation_months) || 12));
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('max_activation_months', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [String(maxMonths)]
    );
    await logSystemEvent('ACTIVATION_SETTINGS_UPDATED', 'USER_MANAGEMENT', req.user.sub, null, null,
      { max_activation_months: maxMonths }, 'SUCCESS', null, req);
    res.json({ ok: true, max_activation_months: maxMonths });
  } catch(e) { res.status(500).json({ error: 'Error al guardar configuración' }); }
});

// Roles and permissions (admin only)

// Config endpoint — frontend lee esto para construir la UI de permisos dinámicamente
app.get('/admin/roles/config', authenticate, requireRole('admin'), apiLimiter, (req, res) => {
  res.json({
    types:       ROLE_TYPES,
    type_labels: ROLE_TYPE_LABELS,
    modules:     ROLE_PERMISSION_MODULES,
    levels:      ROLE_PERMISSION_LEVELS
  });
});

app.get('/admin/roles', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, display_name, active, is_system,
              COALESCE(role_type, 'system_role') AS role_type,
              COALESCE(permissions, '{}'::jsonb) AS permissions
       FROM roles
       ORDER BY is_system DESC, name ASC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('❌ Error fetching roles:', e);
    res.status(500).json({ error: 'Error al obtener roles' });
  }
});

app.post('/admin/roles', authenticate, requireRole('admin'), apiLimiter,
  body('name').trim().isLength({ min: 2, max: 50 }).withMessage('Nombre de rol inválido'),
  body('display_name').optional().trim().isLength({ min: 2, max: 100 }).withMessage('Nombre visible inválido'),
  body('role_type').optional().isIn(ROLE_TYPES).withMessage('Tipo de rol inválido'),
  handleValidationErrors,
  async (req, res) => {
    const name      = normalizeRoleName(req.body.name);
    const displayName = (req.body.display_name || name).toString().trim();
    const roleType  = ROLE_TYPES.includes(req.body.role_type) ? req.body.role_type : 'client_role';
    const permissions = sanitizeRolePermissions(req.body.permissions || getDefaultPermissionsForRole(name), roleType);

    if (!name) return res.status(400).json({ error: 'Nombre de rol inválido' });
    try {
      const created = await pool.query(
        `INSERT INTO roles (name, display_name, permissions, active, is_system, role_type, updated_at)
         VALUES ($1, $2, $3::jsonb, TRUE, FALSE, $4, NOW())
         RETURNING name, display_name, active, is_system, role_type, permissions`,
        [name, displayName, JSON.stringify(permissions), roleType]
      );
      await logSystemEvent('ROLE_CREATED', 'ROLE_MANAGEMENT', req.user.sub, null, null, {
        role_name: created.rows[0].name,
        display_name: created.rows[0].display_name,
        role_type: roleType
      }, 'SUCCESS', null, req);
      res.status(201).json(created.rows[0]);
    } catch (e) {
      if (e.code === '23505') {
        await logSystemEvent('ROLE_CREATE_ERROR', 'ROLE_MANAGEMENT', req.user.sub, null, null, { role_name: name }, 'FAILED', 'El rol ya existe', req);
        return res.status(409).json({ error: 'El rol ya existe' });
      }
      await logSystemEvent('ROLE_CREATE_ERROR', 'ROLE_MANAGEMENT', req.user.sub, null, null, { role_name: name }, 'FAILED', e.message, req);
      console.error('❌ Error creating role:', e);
      res.status(500).json({ error: 'Error al crear rol' });
    }
  }
);

app.put('/admin/roles/:name', authenticate, requireRole('admin'), apiLimiter,
  body('display_name').optional().trim().isLength({ min: 1, max: 100 }),
  body('role_type').optional().isIn(ROLE_TYPES).withMessage('Tipo de rol inválido'),
  handleValidationErrors,
  async (req, res) => {
    const roleName = normalizeRoleName(req.params.name);
    if (!roleName) return res.status(400).json({ error: 'Rol inválido' });
    const { display_name, role_type } = req.body;
    if (!display_name && !role_type) return res.status(400).json({ error: 'Nada que actualizar' });
    try {
      const existing = await pool.query('SELECT name, is_system, role_type, permissions FROM roles WHERE name=$1', [roleName]);
      if (existing.rowCount === 0) return res.status(404).json({ error: 'Rol no encontrado' });
      const cur = existing.rows[0];

      // Si cambia role_type, re-sanitize permissions para limpiar módulos prohibidos
      let newPermissions = cur.permissions;
      if (role_type && role_type !== cur.role_type) {
        newPermissions = sanitizeRolePermissions(cur.permissions, role_type);
      }

      const updated = await pool.query(
        `UPDATE roles
         SET display_name = COALESCE($1, display_name),
             role_type    = COALESCE($2, role_type),
             permissions  = $3::jsonb,
             updated_at   = NOW()
         WHERE name = $4
         RETURNING name, display_name, active, is_system, role_type, permissions`,
        [display_name || null, role_type || null, JSON.stringify(newPermissions), roleName]
      );
      await logSystemEvent('ROLE_UPDATED', 'ROLE_MANAGEMENT', req.user.sub, null, null, {
        role_name: roleName, display_name, role_type, permissions_sanitized: !!role_type
      }, 'SUCCESS', null, req);
      res.json({ ok: true, role: updated.rows[0] });
    } catch (e) {
      console.error('❌ Error updating role:', e);
      res.status(500).json({ error: 'Error al actualizar rol' });
    }
  }
);

app.delete('/admin/roles/:name', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const roleName = normalizeRoleName(req.params.name);
  if (!roleName) return res.status(400).json({ error: 'Rol inválido' });

  try {
    const existing = await pool.query('SELECT name FROM roles WHERE name=$1', [roleName]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Rol no encontrado' });
    if (roleName === 'admin') return res.status(400).json({ error: 'No se puede eliminar el rol administrador' });

    const usersWithRole = await pool.query('SELECT COUNT(*) FROM users WHERE role=$1', [roleName]);
    if (parseInt(usersWithRole.rows[0].count, 10) > 0) {
      return res.status(400).json({ error: 'No se puede eliminar el rol porque tiene usuarios asignados' });
    }

    await pool.query('DELETE FROM roles WHERE name=$1', [roleName]);
    await logSystemEvent('ROLE_DELETED', 'ROLES', req.user.sub, null, null, { role_name: roleName }, 'SUCCESS', null, req);
    res.json({ message: `Rol "${roleName}" eliminado correctamente` });
  } catch (e) {
    console.error('Error al eliminar rol:', e.message);
    res.status(500).json({ error: 'Error al eliminar rol' });
  }
});

app.put('/admin/roles/:name/permissions', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const roleName = normalizeRoleName(req.params.name);
  if (!roleName) return res.status(400).json({ error: 'Rol inválido' });

  try {
    // Lee el role_type actual para aplicar las restricciones correctas
    const roleRow = await pool.query('SELECT role_type FROM roles WHERE name=$1', [roleName]);
    if (roleRow.rowCount === 0) return res.status(404).json({ error: 'Rol no encontrado' });
    const roleType = roleRow.rows[0].role_type || 'system_role';

    const permissions = sanitizeRolePermissions(req.body.permissions, roleType);

    const updated = await pool.query(
      `UPDATE roles
       SET permissions=$1::jsonb, updated_at=NOW()
       WHERE name=$2
       RETURNING name, display_name, active, is_system, role_type, permissions`,
      [JSON.stringify(permissions), roleName]
    );
    await logSystemEvent('ROLE_PERMISSIONS_UPDATED', 'ROLE_MANAGEMENT', req.user.sub, null, null, {
      role_name: roleName,
      role_type: roleType,
      permissions
    }, 'SUCCESS', null, req);
    res.json({ ok: true, role: updated.rows[0] });
  } catch (e) {
    await logSystemEvent('ROLE_PERMISSIONS_UPDATE_ERROR', 'ROLE_MANAGEMENT', req.user.sub, null, null, {
      role_name: roleName
    }, 'FAILED', e.message, req);
    console.error('❌ Error updating role permissions:', e);
    res.status(500).json({ error: 'Error al actualizar permisos del rol' });
  }
});

// Delete user (admin) - also delete refresh tokens
app.delete('/admin/users/:id', authenticate, requireRole('admin'), async (req,res)=>{
  const userId = req.params.id;
  const client = await pool.connect();
  try{
    console.log('Deleting user:', userId);
    
    // Protección: no eliminar si es el único admin activo
    const targetUser = await client.query('SELECT role, active FROM users WHERE id=$1', [userId]);
    if (targetUser.rowCount > 0 && targetUser.rows[0].role === 'admin') {
      const activeAdmins = await client.query(
        "SELECT COUNT(*) FROM users WHERE role='admin' AND active=TRUE"
      );
      if (parseInt(activeAdmins.rows[0].count, 10) <= 1) {
        client.release();
        return res.status(400).json({ error: 'No puedes eliminar al único administrador activo del sistema.' });
      }
    }

    // Start transaction
    await client.query('BEGIN');

    // First delete all refresh tokens for this user
    const delTokens = await client.query('DELETE FROM refresh_tokens WHERE user_id=$1',[userId]);
    console.log('Deleted refresh tokens:', delTokens.rowCount);

    // Delete system_events for this user (FK constraint)
    const delEvents = await client.query('DELETE FROM system_events WHERE user_id=$1',[userId]);
    console.log('Deleted system events:', delEvents.rowCount);
    
    // Then delete the user
    const r = await client.query('DELETE FROM users WHERE id=$1 RETURNING id,email,role',[userId]);
    console.log('Delete result rows:', r.rowCount);
    
    if(r.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({error:'User not found'});
    }
    
    // Commit transaction
    await client.query('COMMIT');
    await logSystemEvent('USER_DELETED', 'USER_MANAGEMENT', req.user.sub, null, null, {
      deleted_user_id: parseInt(userId, 10),
      deleted_user_email: r.rows[0].email,
      deleted_user_role: r.rows[0].role
    }, 'SUCCESS', null, req);
    res.json({ok:true,user:r.rows[0]});
  }catch(e){ 
    try { await client.query('ROLLBACK'); } catch(rollbackErr) {}
    await logSystemEvent('USER_DELETE_ERROR', 'USER_MANAGEMENT', req.user.sub, null, null, {
      deleted_user_id: parseInt(userId, 10)
    }, 'FAILED', e.message, req);
    console.error('Delete error:', e);
    res.status(400).json({error:e.message}); 
  }finally{
    client.release();
  }
});

// Middleware: authenticate with improved security
function authenticate(req,res,next){
  const h = req.headers['authorization'];
  if(!h || !h.startsWith('Bearer ')) {
    logSecurityEvent('AUTH_MISSING_TOKEN', { ip: req.ip, path: req.path });
    return res.status(401).json({error:'missing_token'});
  }
  const token = h.slice(7);
  try{
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  }catch(e){ 
    logSecurityEvent('AUTH_INVALID_TOKEN', { error: e.message, ip: req.ip, path: req.path });
    return res.status(401).json({error:'invalid_token', message: e.message}); 
  }
}

function requireRole(...allowedRoles){
  return (req,res,next)=>{
    if(!req.user) {
      logSecurityEvent('AUTHZ_MISSING_USER', { ip: req.ip, path: req.path });
      return res.status(401).json({error:'missing_token'});
    }
    // Admin can access all roles
    if(req.user.role === 'admin') {
      return next();
    }
    // Check if user's role is in allowed roles
    if(!allowedRoles.includes(req.user.role)) {
      logSecurityEvent('AUTHZ_FORBIDDEN', { userId: req.user.sub, role: req.user.role, requiredRoles: allowedRoles, ip: req.ip, path: req.path });
      return res.status(403).json({error:'forbidden', message: 'No tienes permisos para acceder a este recurso'});
    }
    next();
  };
}

// Verifica que el usuario tenga al menos `level` (none < view < edit) en `module`.
function requirePermission(module, level) {
  const LEVELS = { none: 0, view: 1, edit: 2 };
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'missing_token' });
    if (req.user.role === 'admin') return next();
    try {
      const roleRow = await pool.query('SELECT permissions FROM roles WHERE name=$1', [req.user.role]);
      const perms     = roleRow.rows[0]?.permissions || {};
      const userLevel = LEVELS[perms[module] || 'none'] ?? 0;
      if (userLevel >= LEVELS[level]) return next();
      logSecurityEvent('AUTHZ_PERMISSION_DENIED', {
        userId: req.user.sub, role: req.user.role, module, requiredLevel: level, ip: req.ip, path: req.path
      });
      return res.status(403).json({ error: 'forbidden', module, required: level });
    } catch (e) {
      return res.status(500).json({ error: 'Error validando permisos' });
    }
  };
}

// Igual que requirePermission pero pasa si el usuario tiene el nivel en CUALQUIERA de los módulos.
function requireAnyPermission(modules, level) {
  const LEVELS = { none: 0, view: 1, edit: 2 };
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'missing_token' });
    if (req.user.role === 'admin') return next();
    try {
      const roleRow = await pool.query('SELECT permissions FROM roles WHERE name=$1', [req.user.role]);
      const perms = roleRow.rows[0]?.permissions || {};
      const hasAny = modules.some(mod => (LEVELS[perms[mod] || 'none'] ?? 0) >= LEVELS[level]);
      if (hasAny) return next();
      logSecurityEvent('AUTHZ_PERMISSION_DENIED', {
        userId: req.user.sub, role: req.user.role, modules, requiredLevel: level, ip: req.ip, path: req.path
      });
      return res.status(403).json({ error: 'forbidden', modules, required: level });
    } catch (e) {
      return res.status(500).json({ error: 'Error validando permisos' });
    }
  };
}

function generateVoucherCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

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

// Admin: Get all system events (with pagination and filters)
app.get('/admin/events', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const eventType = req.query.event_type;
    const eventCategory = req.query.event_category;
    const userId = req.query.user_id;
    const status = req.query.status;
    
    let query = 'SELECT * FROM system_events WHERE 1=1';
    let params = [];
    let paramNum = 1;
    
    if (eventType) {
      query += ` AND event_type = $${paramNum}`;
      params.push(eventType);
      paramNum++;
    }
    if (eventCategory) {
      query += ` AND event_category = $${paramNum}`;
      params.push(eventCategory);
      paramNum++;
    }
    if (userId) {
      query += ` AND user_id = $${paramNum}`;
      params.push(userId);
      paramNum++;
    }
    if (status) {
      query += ` AND status = $${paramNum}`;
      params.push(status);
      paramNum++;
    }
    
    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM system_events WHERE 1=1 ${eventType ? `AND event_type=$${paramNum - (params.length - 1)}` : ''} ${eventCategory ? `AND event_category=$${paramNum - (params.length - 2)}` : ''} ${userId ? `AND user_id=$${paramNum - (params.length - 3)}` : ''} ${status ? `AND status=$${paramNum - (params.length - 4)}` : ''}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);
    
    // Get paginated results
    query += ` ORDER BY created_at DESC LIMIT $${paramNum} OFFSET $${paramNum + 1}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    res.json({
      events: result.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error('❌ Error fetching events:', e);
    res.status(400).json({ error: 'Error al obtener eventos' });
  }
});

// Admin: Get events by user
app.get('/admin/events/user/:userId', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const userId = req.params.userId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    const result = await pool.query(
      `SELECT * FROM system_events 
       WHERE user_id=$1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM system_events WHERE user_id=$1',
      [userId]
    );
    const total = parseInt(countResult.rows[0].count);
    
    res.json({
      events: result.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error('❌ Error fetching user events:', e);
    res.status(400).json({ error: 'Error al obtener eventos del usuario' });
  }
});

// Admin: Get event statistics
app.get('/admin/events/stats/dashboard', authenticate, requireAnyPermission(['dashboard', 'audit'], 'view'), apiLimiter, async (req, res) => {
  try {
    const totalEvents = await pool.query('SELECT COUNT(*) FROM system_events');
    const successfulEvents = await pool.query(`SELECT COUNT(*) FROM system_events WHERE status='SUCCESS'`);
    const failedEvents = await pool.query(`SELECT COUNT(*) FROM system_events WHERE status='FAILED'`);
    const partialEvents = await pool.query(`SELECT COUNT(*) FROM system_events WHERE status='PARTIAL_SUCCESS'`);
    
    const eventsByCategory = await pool.query(`
      SELECT event_category, COUNT(*) as count 
      FROM system_events 
      GROUP BY event_category 
      ORDER BY count DESC
    `);
    
    const eventsByType = await pool.query(`
      SELECT event_type, COUNT(*) as count 
      FROM system_events 
      GROUP BY event_type 
      ORDER BY count DESC 
      LIMIT 10
    `);
    
    const recentEvents = await pool.query(`
      SELECT * FROM system_events 
      ORDER BY created_at DESC 
      LIMIT 10
    `);
    
    res.json({
      summary: {
        total: parseInt(totalEvents.rows[0].count),
        successful: parseInt(successfulEvents.rows[0].count),
        failed: parseInt(failedEvents.rows[0].count),
        partial: parseInt(partialEvents.rows[0].count)
      },
      by_category: eventsByCategory.rows,
      by_type: eventsByType.rows,
      recent: recentEvents.rows
    });
  } catch (e) {
    console.error('❌ Error fetching event stats:', e);
    res.status(400).json({ error: 'Error al obtener estadísticas de eventos' });
  }
});

// Admin: Export events to CSV or JSON
app.get('/admin/events/export/:format', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const format = req.params.format.toLowerCase();
    const eventType = req.query.event_type;
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    
    let query = 'SELECT * FROM system_events WHERE 1=1';
    let params = [];
    let paramNum = 1;
    
    if (eventType) {
      query += ` AND event_type=$${paramNum++}`;
      params.push(eventType);
    }
    if (startDate) {
      query += ` AND created_at >= $${paramNum++}`;
      params.push(new Date(startDate));
    }
    if (endDate) {
      query += ` AND created_at <= $${paramNum++}`;
      params.push(new Date(endDate));
    }
    
    query += ' ORDER BY created_at DESC';
    const events = await pool.query(query, params);
    
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=events.json');
      res.json({ events: events.rows, exported_at: new Date().toISOString() });
    } else if (format === 'csv') {
      const csv = convertToCSV(events.rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=events.csv');
      res.send(csv);
    } else {
      res.status(400).json({ error: 'Formato no válido. Use json o csv' });
    }
  } catch (e) {
    console.error('❌ Error exporting events:', e);
    res.status(400).json({ error: 'Error al exportar eventos' });
  }
});

// Helper function to convert to CSV
function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  
  const headers = Object.keys(data[0]).join(',');
  const rows = data.map(item => {
    return Object.values(item)
      .map(value => {
        if (value === null) return '';
        if (typeof value === 'object') return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
        if (typeof value === 'string') return `"${value.replace(/"/g, '""')}"`;
        return value;
      })
      .join(',');
  });
  
  return [headers, ...rows].join('\n');
}

function buildAuditMovementsCTE() {
  return `
    WITH movements AS (
      SELECT
        CONCAT('sys-', se.id) AS movement_id,
        'SYSTEM'::varchar AS source,
        se.event_type::varchar AS movement_type,
        se.event_category::varchar AS category,
        COALESCE(se.status, 'UNKNOWN')::varchar AS status,
        se.created_at AS occurred_at,
        se.user_id,
        COALESCE(p.partner_id, u.partner_id) AS partner_id,
        se.purchase_id,
        NULL::varchar AS stripe_event_id,
        NULL::varchar AS payment_intent_id,
        CONCAT('Evento ', se.event_type, ' (', se.event_category, ')')::text AS summary,
        jsonb_build_object(
          'event_data', se.event_data,
          'error_message', se.error_message,
          'ip_address', se.ip_address,
          'user_agent', se.user_agent,
          'stripe_customer_id', se.stripe_customer_id
        ) AS details
      FROM system_events se
      LEFT JOIN purchases p ON p.id = se.purchase_id
      LEFT JOIN users u ON u.id = se.user_id

      UNION ALL

      SELECT
        CONCAT('tx-', te.id) AS movement_id,
        'TRANSACTION'::varchar AS source,
        te.event_type::varchar AS movement_type,
        'PAYMENT'::varchar AS category,
        COALESCE(te.new_status, 'UNKNOWN')::varchar AS status,
        te.created_at AS occurred_at,
        NULL::integer AS user_id,
        te.partner_id,
        te.purchase_id,
        te.stripe_event_id,
        te.payment_intent_id,
        CONCAT('Transacción ', COALESCE(te.previous_status, 'N/A'), ' → ', COALESCE(te.new_status, 'N/A'))::text AS summary,
        jsonb_build_object(
          'previous_status', te.previous_status,
          'new_status', te.new_status,
          'metadata', te.metadata,
          'stripe_event_data', te.stripe_event_data
        ) AS details
      FROM transaction_events te

      UNION ALL

      SELECT
        CONCAT('st-', st.id) AS movement_id,
        'STRIPE'::varchar AS source,
        st.event_type::varchar AS movement_type,
        'WEBHOOK'::varchar AS category,
        (CASE WHEN st.processed THEN 'PROCESSED' ELSE 'PENDING' END)::varchar AS status,
        st.created_at AS occurred_at,
        NULL::integer AS user_id,
        NULL::integer AS partner_id,
        NULL::integer AS purchase_id,
        st.stripe_event_id,
        NULL::varchar AS payment_intent_id,
        CONCAT('Webhook ', st.event_type)::text AS summary,
        jsonb_build_object(
          'processed', st.processed,
          'processed_at', st.processed_at,
          'event_data', st.event_data
        ) AS details
      FROM stripe_events st

      UNION ALL

      SELECT
        CONCAT('ac-', a.id) AS movement_id,
        'ACTIVATION'::varchar AS source,
        'VOUCHER_ACTIVATED'::varchar AS movement_type,
        'VOUCHER'::varchar AS category,
        'SUCCESS'::varchar AS status,
        a.activated_at AS occurred_at,
        NULL::integer AS user_id,
        v.partner_id,
        v.purchase_id,
        NULL::varchar AS stripe_event_id,
        NULL::varchar AS payment_intent_id,
        CONCAT('Voucher activado por ', COALESCE(a.user_email, a.user_name, 'usuario'))::text AS summary,
        jsonb_build_object(
          'voucher_id', a.voucher_id,
          'voucher_code', v.code,
          'course_id', a.course_id,
          'user_name', a.user_name,
          'user_email', a.user_email,
          'final_client', a.final_client
        ) AS details
      FROM activations a
      LEFT JOIN vouchers v ON v.id = a.voucher_id

      UNION ALL

      SELECT
        CONCAT('pu-', p.id) AS movement_id,
        'PURCHASE'::varchar AS source,
        'PURCHASE_CREATED'::varchar AS movement_type,
        'PURCHASE'::varchar AS category,
        COALESCE(p.status, 'PENDING')::varchar AS status,
        p.created_at AS occurred_at,
        NULL::integer AS user_id,
        p.partner_id,
        p.id AS purchase_id,
        NULL::varchar AS stripe_event_id,
        p.payment_intent_id,
        CONCAT('Compra #', p.id, ' creada')::text AS summary,
        jsonb_build_object(
          'qty', p.qty,
          'total_price', p.total_price,
          'stripe_status', p.stripe_status,
          'stripe_session_id', p.stripe_session_id,
          'pricing_details', p.pricing_details
        ) AS details
      FROM purchases p
    )`;
}

function buildAuditFilters(req) {
  const whereParts = [];
  const params = [];

  const addFilter = (condition, value) => {
    params.push(value);
    whereParts.push(condition.replace('?', `$${params.length}`));
  };

  const source = req.query.source ? String(req.query.source).trim().toUpperCase() : '';
  const status = req.query.status ? String(req.query.status).trim().toUpperCase() : '';
  const category = req.query.category ? String(req.query.category).trim().toUpperCase() : '';
  const eventType = req.query.event_type ? String(req.query.event_type).trim().toUpperCase() : '';
  const partnerId = req.query.partner_id ? parseInt(req.query.partner_id, 10) : null;
  const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  const purchaseId = req.query.purchase_id ? parseInt(req.query.purchase_id, 10) : null;
  const search = req.query.search ? String(req.query.search).trim().toLowerCase() : '';
  const startDate = req.query.start_date ? new Date(req.query.start_date) : null;
  const endDate = req.query.end_date ? new Date(req.query.end_date) : null;

  if (source) addFilter('m.source = ?', source);
  if (status) addFilter('UPPER(m.status) = ?', status);
  if (category) addFilter('UPPER(m.category) = ?', category);
  if (eventType) addFilter('UPPER(m.movement_type) = ?', eventType);
  if (Number.isInteger(partnerId)) addFilter('m.partner_id = ?', partnerId);
  if (Number.isInteger(userId)) addFilter('m.user_id = ?', userId);
  if (Number.isInteger(purchaseId)) addFilter('m.purchase_id = ?', purchaseId);
  if (startDate && !Number.isNaN(startDate.getTime())) addFilter('m.occurred_at >= ?', startDate);
  if (endDate && !Number.isNaN(endDate.getTime())) addFilter('m.occurred_at <= ?', endDate);
  if (search) {
    const searchParam = `%${search}%`;
    const base = params.length + 1;
    whereParts.push(`(
      LOWER(COALESCE(m.summary, '')) LIKE $${base} OR
      LOWER(COALESCE(m.movement_type, '')) LIKE $${base + 1} OR
      LOWER(COALESCE(m.category, '')) LIKE $${base + 2} OR
      LOWER(COALESCE(m.status, '')) LIKE $${base + 3} OR
      CAST(COALESCE(m.purchase_id, 0) AS TEXT) LIKE $${base + 4} OR
      CAST(COALESCE(m.partner_id, 0) AS TEXT) LIKE $${base + 5}
    )`);
    params.push(searchParam, searchParam, searchParam, searchParam, searchParam, searchParam);
  }

  return {
    whereClause: whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '',
    params
  };
}

// Admin: módulo de auditoría unificada (todos los movimientos)
app.get('/admin/audit/movements', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const cte = buildAuditMovementsCTE();
    const { whereClause, params } = buildAuditFilters(req);

    const countQuery = `${cte}
      SELECT COUNT(*)::int AS total
      FROM movements m
      ${whereClause}`;

    const countResult = await pool.query(countQuery, params);
    const total = countResult.rows[0] ? parseInt(countResult.rows[0].total, 10) : 0;

    const listParams = [...params, limit, offset];
    const listQuery = `${cte}
      SELECT
        m.movement_id,
        m.source,
        m.movement_type,
        m.category,
        m.status,
        m.occurred_at,
        m.user_id,
        m.partner_id,
        m.purchase_id,
        m.stripe_event_id,
        m.payment_intent_id,
        m.summary,
        m.details
      FROM movements m
      ${whereClause}
      ORDER BY m.occurred_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}`;

    const movementsResult = await pool.query(listQuery, listParams);

    res.json({
      movements: movementsResult.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error('❌ Error fetching unified audit movements:', e);
    res.status(400).json({ error: 'Error al obtener movimientos de auditoría' });
  }
});

// Admin: resumen de auditoría para dashboard
app.get('/admin/audit/movements/summary', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const cte = buildAuditMovementsCTE();
    const { whereClause, params } = buildAuditFilters(req);

    const summaryQuery = `${cte}
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE m.occurred_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
        COUNT(*) FILTER (
          WHERE UPPER(COALESCE(m.status, '')) IN ('FAILED', 'ERROR', 'CANCELED', 'CANCELLED')
        )::int AS failed
      FROM movements m
      ${whereClause}`;

    const sourceQuery = `${cte}
      SELECT m.source, COUNT(*)::int AS count
      FROM movements m
      ${whereClause}
      GROUP BY m.source
      ORDER BY count DESC`;

    const [summaryResult, sourceResult] = await Promise.all([
      pool.query(summaryQuery, params),
      pool.query(sourceQuery, params)
    ]);

    const summary = summaryResult.rows[0] || { total: 0, last_24h: 0, failed: 0 };

    res.json({
      summary: {
        total: parseInt(summary.total, 10) || 0,
        last_24h: parseInt(summary.last_24h, 10) || 0,
        failed: parseInt(summary.failed, 10) || 0
      },
      by_source: sourceResult.rows
    });
  } catch (e) {
    console.error('❌ Error fetching audit summary:', e);
    res.status(400).json({ error: 'Error al obtener resumen de auditoría' });
  }
});

// Admin: exportar auditoría unificada en CSV (único formato permitido)
app.get('/admin/audit/movements/export/csv', authenticate, requirePermission('audit', 'view'), apiLimiter, async (req, res) => {
  try {
    const cte = buildAuditMovementsCTE();
    const { whereClause, params } = buildAuditFilters(req);

    const query = `${cte}
      SELECT
        m.movement_id,
        m.source,
        m.movement_type,
        m.category,
        m.status,
        m.occurred_at,
        m.user_id,
        m.partner_id,
        m.purchase_id,
        m.stripe_event_id,
        m.payment_intent_id,
        m.summary,
        m.details
      FROM movements m
      ${whereClause}
      ORDER BY m.occurred_at DESC
      LIMIT 10000`;

    const result = await pool.query(query, params);
    const csv = convertToCSV(result.rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=auditoria_movimientos.csv');
    res.send(csv);
  } catch (e) {
    console.error('❌ Error exporting audit movements CSV:', e);
    res.status(400).json({ error: 'Error al exportar auditoría en CSV' });
  }
});

// ─────────────────────────────────────────────
// REPORTERÍA
// ─────────────────────────────────────────────

// GET /admin/reports/summary  – KPIs globales
app.get('/admin/reports/summary', authenticate, requireAnyPermission(['dashboard', 'stats', 'reports'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date, partner_id } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`p.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (partner_id && /^\d+$/.test(partner_id)) { params.push(parseInt(partner_id, 10)); conditions.push(`p.partner_id = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const purchasesQ = await pool.query(`
      SELECT
        COUNT(*)::int                                                                                           AS total_purchases,
        COALESCE(SUM(p.total_price),0)::numeric                                                                AS total_revenue,
        COALESCE(SUM(p.qty),0)::int                                                                            AS total_vouchers_sold,
        COUNT(*) FILTER (WHERE p.status='COMPLETED')::int                                                      AS completed_purchases,
        COUNT(*) FILTER (WHERE p.status='PENDING')::int                                                        AS pending_purchases,
        COUNT(*) FILTER (WHERE p.status='CANCELLED')::int                                                      AS cancelled_purchases,
        COUNT(*) FILTER (WHERE p.payment_method='complimentary')::int                                          AS complimentary_purchases,
        COALESCE(SUM(p.total_price) FILTER (WHERE p.payment_method != 'complimentary'),0)::numeric             AS paid_revenue,
        COALESCE(SUM(p.total_price) FILTER (WHERE p.payment_method = 'stripe'),0)::numeric                     AS stripe_revenue,
        COALESCE(SUM(p.total_price) FILTER (WHERE p.payment_method NOT IN ('stripe','complimentary')),0)::numeric AS external_revenue
      FROM purchases p ${where}
    `, params);

    const vPartnerFilter = partner_id && /^\d+$/.test(partner_id) ? `WHERE v.partner_id = ${parseInt(partner_id, 10)}` : '';
    const vouchersQ = await pool.query(`
      SELECT
        COUNT(*)::int                                                      AS total_vouchers,
        COUNT(*) FILTER (WHERE v.status='AVAILABLE')::int                  AS available_vouchers,
        COUNT(*) FILTER (WHERE v.status='CONSUMED')::int                   AS consumed_vouchers,
        COUNT(*) FILTER (WHERE v.status='EXPIRED')::int                    AS expired_vouchers,
        COUNT(*) FILTER (WHERE v.voucher_type='COMPLIMENTARY')::int        AS complimentary_vouchers
      FROM vouchers v
      ${vPartnerFilter}
    `);

    const actWhere = [
      start_date ? `a.activated_at >= '${start_date}'`                               : null,
      end_date   ? `a.activated_at <= '${end_date}'::date + INTERVAL '1 day'`        : null,
      partner_id && /^\d+$/.test(partner_id)
                 ? `a.voucher_id IN (SELECT id FROM vouchers WHERE partner_id=${parseInt(partner_id,10)})` : null
    ].filter(Boolean);
    const activationsQ = await pool.query(`
      SELECT
        COUNT(*)::int                                                        AS total_activations,
        COUNT(*) FILTER (WHERE a.moodle_status='COMPLETED')::int            AS completed_courses,
        COUNT(*) FILTER (WHERE a.moodle_status='ENROLLED')::int             AS enrolled_courses,
        COUNT(DISTINCT a.course_id) FILTER (WHERE a.moodle_status='COMPLETED')::int AS completed_unique_courses
      FROM activations a
      ${actWhere.length ? 'WHERE ' + actWhere.join(' AND ') : ''}
    `);

    const partnersQ = await pool.query(`SELECT COUNT(DISTINCT id)::int AS total_partners FROM partners`);

    res.json({
      summary: {
        ...purchasesQ.rows[0],
        ...vouchersQ.rows[0],
        ...activationsQ.rows[0],
        total_partners: partnersQ.rows[0].total_partners
      }
    });
  } catch (e) {
    console.error('❌ Error en reports/summary:', e);
    res.status(500).json({ error: 'Error al obtener resumen de reportería' });
  }
});

// GET /admin/reports/monthly  – Compras y revenue agrupados por mes
app.get('/admin/reports/monthly', authenticate, requireAnyPermission(['dashboard', 'stats', 'reports'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date, partner_id } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    if (partner_id && /^\d+$/.test(partner_id)) { params.push(parseInt(partner_id,10)); conditions.push(`partner_id = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COUNT(*)::int                                         AS purchases,
        COALESCE(SUM(total_price),0)::numeric                 AS revenue,
        COALESCE(SUM(qty),0)::int                             AS vouchers_sold
      FROM purchases ${where}
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
      LIMIT 24
    `, params);

    res.json({ monthly: result.rows });
  } catch (e) {
    console.error('❌ Error en reports/monthly:', e);
    res.status(500).json({ error: 'Error al obtener datos mensuales' });
  }
});

// GET /admin/reports/top-partners  – Top partners por ingresos
app.get('/admin/reports/top-partners', authenticate, requireAnyPermission(['dashboard', 'stats', 'reports'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`p.created_at <= $${params.length}::date + INTERVAL '1 day'`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        pt.id                                  AS partner_id,
        pt.name AS partner_name,
        COUNT(p.id)::int                       AS total_purchases,
        COALESCE(SUM(p.total_price),0)::numeric AS total_revenue,
        COALESCE(SUM(p.qty),0)::int            AS vouchers_sold,
        COUNT(p.id) FILTER (WHERE p.status='COMPLETED')::int AS completed
      FROM partners pt
      LEFT JOIN purchases p ON p.partner_id = pt.id ${where.replace('WHERE','AND')}
      GROUP BY pt.id, pt.name
      ORDER BY total_revenue DESC
      LIMIT 20
    `, params);

    res.json({ top_partners: result.rows });
  } catch (e) {
    console.error('❌ Error en reports/top-partners:', e);
    res.status(500).json({ error: 'Error al obtener top partners' });
  }
});

// GET /admin/reports/top-courses  – Top cursos por activaciones
app.get('/admin/reports/top-courses', authenticate, requireAnyPermission(['dashboard', 'stats', 'reports'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`a.activated_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`a.activated_at <= $${params.length}::date + INTERVAL '1 day'`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        c.id                          AS course_id,
        c.name                        AS course_name,
        COUNT(a.id)::int              AS total_activations,
        COUNT(DISTINCT v.partner_id)::int AS partners_count
      FROM courses c
      LEFT JOIN activations a ON a.course_id = c.id ${where.replace('WHERE','AND')}
      LEFT JOIN vouchers v ON v.id = a.voucher_id
      GROUP BY c.id, c.name
      ORDER BY total_activations DESC
      LIMIT 20
    `, params);

    res.json({ top_courses: result.rows });
  } catch (e) {
    console.error('❌ Error en reports/top-courses:', e);
    res.status(500).json({ error: 'Error al obtener top cursos' });
  }
});

// GET /admin/reports/purchases  – Listado de compras con nombre de partner y paginación
app.get('/admin/reports/purchases', authenticate, requireAnyPermission(['reports', 'purchases', 'financial_ops'], 'view'), async (req, res) => {
  try {
    const { start_date, end_date, partner_id, status, page = 1, limit = 25 } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`p.created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    if (partner_id && /^\d+$/.test(partner_id)) { params.push(parseInt(partner_id,10)); conditions.push(`p.partner_id = $${params.length}`); }
    if (status)     { params.push(status.toUpperCase()); conditions.push(`p.status = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const pageNum  = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset   = (pageNum - 1) * limitNum;

    params.push(limitNum); const limitIdx  = params.length;
    params.push(offset);   const offsetIdx = params.length;

    const [dataQ, countQ] = await Promise.all([
      pool.query(`
        SELECT
          p.id,
          p.partner_id,
          pt.name AS partner_name,
          p.qty,
          p.total_price,
          p.status,
          p.stripe_status,
          p.created_at,
          p.updated_at,
          (SELECT COUNT(*)::int FROM vouchers v WHERE v.purchase_id = p.id AND v.status='CONSUMED') AS vouchers_used
        FROM purchases p
        LEFT JOIN partners pt ON pt.id = p.partner_id
        ${where}
        ORDER BY p.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, params),
      pool.query(`SELECT COUNT(*)::int AS total FROM purchases p ${where}`, params.slice(0, params.length - 2))
    ]);

    const total = countQ.rows[0].total;
    const pages = Math.ceil(total / limitNum) || 1;

    res.json({
      purchases: dataQ.rows,
      pagination: { page: pageNum, limit: limitNum, total, pages }
    });
  } catch (e) {
    console.error('❌ Error en reports/purchases:', e);
    res.status(500).json({ error: 'Error al obtener compras para reporte' });
  }
});

// GET /admin/reports/export/csv  – Exportar compras con filtros en CSV
app.get('/admin/reports/export/csv', authenticate, requirePermission('reports', 'view'), async (req, res) => {
  try {
    const { start_date, end_date, partner_id, status } = req.query;
    const conditions = [];
    const params = [];

    if (start_date) { params.push(start_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (end_date)   { params.push(end_date);   conditions.push(`p.created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    if (partner_id && /^\d+$/.test(partner_id)) { params.push(parseInt(partner_id,10)); conditions.push(`p.partner_id = $${params.length}`); }
    if (status)     { params.push(status.toUpperCase()); conditions.push(`p.status = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        p.id                           AS "ID Compra",
        pt.name AS "Partner",
        p.qty                          AS "Qty Vouchers",
        p.total_price                  AS "Total (€)",
        p.status                       AS "Estado",
        p.stripe_status                AS "Stripe Status",
        TO_CHAR(p.created_at,'YYYY-MM-DD HH24:MI') AS "Fecha Creación",
        TO_CHAR(p.updated_at,'YYYY-MM-DD HH24:MI') AS "Última Actualización",
        (SELECT COUNT(*)::int FROM vouchers v WHERE v.purchase_id = p.id AND v.status='CONSUMED') AS "Vouchers Usados"
      FROM purchases p
      LEFT JOIN partners pt ON pt.id = p.partner_id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT 10000
    `, params);

    const csv = convertToCSV(result.rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=reporte_compras.csv');
    res.send(csv);
  } catch (e) {
    console.error('❌ Error exportando reporte CSV:', e);
    res.status(500).json({ error: 'Error al exportar reporte en CSV' });
  }
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

  // ── Auto-sync de certificaciones desde Moodle ──────────────────────────────
  const MOODLE_SYNC_MINUTES = Math.max(5, parseInt(process.env.MOODLE_SYNC_INTERVAL_MINUTES || '60', 10));

  if (!moodleService.isMockMode()) {
    // Primera sincronización al arrancar (30 seg de delay para que la BD esté lista)
    setTimeout(async () => {
      console.log('🎓 [MOODLE] Sincronización inicial de certificaciones...');
      const r = await syncMoodleCourses();
      if (r.ok) {
        console.log(`🎓 [MOODLE] Sync inicial: +${r.created.length} nuevas, ~${r.updated.length} actualizadas, -${r.deactivated.length} desactivadas`);
      } else {
        console.warn(`⚠️ [MOODLE] Sync inicial falló: ${r.error}`);
      }
    }, 30_000);

    // Sincronización periódica
    setInterval(async () => {
      console.log(`🎓 [MOODLE] Auto-sync periódico (cada ${MOODLE_SYNC_MINUTES} min)...`);
      const r = await syncMoodleCourses();
      if (r.ok) {
        if (r.created.length || r.updated.length || r.deactivated.length) {
          console.log(`🎓 [MOODLE] Auto-sync: +${r.created.length} nuevas, ~${r.updated.length} actualizadas, -${r.deactivated.length} desactivadas`);
        }
      } else {
        console.warn(`⚠️ [MOODLE] Auto-sync falló: ${r.error}`);
      }
    }, MOODLE_SYNC_MINUTES * 60 * 1000);

    console.log(`✓ Moodle auto-sync activo: cada ${MOODLE_SYNC_MINUTES} min`);
  } else {
    console.log('ℹ️ Moodle auto-sync desactivado (MOODLE_MOCK=true)');
  }
  // ────────────────────────────────────────────────────────────────────────────
})
