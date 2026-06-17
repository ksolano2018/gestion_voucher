const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { body, param, validationResult } = require('express-validator');
require('dotenv').config();

const moodleService = require('./moodle-service');

// ── Módulos internos (refactor incremental hacia src/) ─────────────────────────
const pool = require('./src/db/pool');
const { logSecurityEvent, logSystemEvent, logTransactionEvent } = require('./src/lib/audit');
const { authLimiter, apiLimiter } = require('./src/lib/rateLimit');
const { handleValidationErrors } = require('./src/lib/validation');
const { authenticate, requireRole, requirePermission, requireAnyPermission } = require('./src/lib/auth');
// Envío de correo delegado al microservicio servicio-notificaciones (cliente HTTP).
const { sendStudentWelcomeEmail } = require('./src/integrations/notifications');
// Lógica de pricing (usada por purchases/checkout/users/stripe-sync inline + módulo pricing).
const {
  normalizePricingProfileCode, normalizePricingRules, ensureDefaultPricingProfilesAndRules,
  getPricingProfilesDetailed, getPartnerPricingAssignment, getDefaultPricingProfileId,
  findMatchingPricingRule, getPartnerCumulativePaidQty, resolvePartnerPricing,
} = require('./src/modules/pricing/service');
// Integración Stripe (cliente + sync customers↔partners + job background).
const {
  stripe, isMissingStripeCustomerError, syncUserWithStripe, upsertPartnerAndUserFromStripeCustomer,
  syncAllStripeCustomersToPartners, enqueueStripeSyncJob, getStripeSyncJob, getLatestStripeSyncJob,
} = require('./src/integrations/stripe');
// Sincronización Moodle (completaciones + cursos): usada por schedulers, webhook y rutas.
const { syncMoodleCompletions, syncMoodleCourses } = require('./src/modules/moodle/service');

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

// Reenvío manual del correo de notificación al estudiante (control anti-spam).
// Configurable por entorno; valores por defecto: 1 reenvío por activación, 10 min de cooldown.
const MAX_PARTNER_EMAIL_RETRIES = parseInt(process.env.MAX_PARTNER_EMAIL_RETRIES) || 1;
const EMAIL_RESEND_COOLDOWN_MIN = parseInt(process.env.EMAIL_RESEND_COOLDOWN_MIN) || 10;

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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@certjoin.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS) || 7;
const SESSION_TIMEOUT_MINUTES = parseInt(process.env.SESSION_TIMEOUT_MINUTES) || 15;
// El cliente Stripe y la lógica de sync viven en src/integrations/stripe.js (importados arriba).
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

// DEFAULT_PRICING_PROFILES y los helpers de pricing viven en src/modules/pricing/service.js (importados arriba).

// Helpers/constantes RBAC ahora viven en src/lib/rbac.js (compartidos por roles y users).
const {
  ROLE_TYPES, ROLE_TYPE_LABELS, ROLE_PERMISSION_MODULES, ROLE_PERMISSION_LEVELS,
  buildRolePermissionsDefault, getDefaultPermissionsForRole, sanitizeRolePermissions,
  normalizeRoleName, getPermissionsByRole,
} = require('./src/lib/rbac');

// normalizePricingProfileCode / normalizePricingRules → src/modules/pricing/service.js

// generateTemporaryPassword / isMissingStripeCustomerError / upsertStripeCustomerRecord
// → src/integrations/stripe.js (isMissingStripeCustomerError importado arriba).

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

// ensureDefaultPricingProfilesAndRules, getPricingProfilesDetailed, getPartnerPricingAssignment,
// getDefaultPricingProfileId, findMatchingPricingRule, getPartnerCumulativePaidQty y
// resolvePartnerPricing → src/modules/pricing/service.js (importados arriba).

// logSecurityEvent / logSystemEvent ahora viven en src/lib/audit.js (importados arriba).

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
// syncUserWithStripe → src/integrations/stripe.js (importado arriba).

// upsertPartnerAndUserFromStripeCustomer → src/integrations/stripe.js (importado arriba).

// syncAllStripeCustomersToPartners + el job de sincronización (stripeSyncJobs, runStripeSyncJob,
// getStripeSyncJobResponse) → src/integrations/stripe.js (importados arriba vía enqueue/get/getLatest).

// handleValidationErrors ahora vive en src/lib/validation.js (importado arriba).

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
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS email_retry_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE activations ADD COLUMN IF NOT EXISTS email_last_attempt_at TIMESTAMP;
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

// Partners (alta/listado + stats/summary) → src/modules/partners
app.use(require('./src/modules/partners/routes'));

// Pricing (perfiles, reglas, asignación por partner, preview) → src/modules/pricing
app.use(require('./src/modules/pricing/routes'));

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
  const { job_id, response } = enqueueStripeSyncJob();
  res.status(202).json({
    ok: true,
    message: 'Sincronización iniciada en segundo plano',
    job: response,
    status_endpoint: `/admin/stripe/sync-customers/async/${job_id}`
  });
});

app.get('/admin/stripe/sync-customers/async/latest', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const { hasJobs, response } = getLatestStripeSyncJob();
  if (!hasJobs) {
    return res.status(404).json({ error: 'No hay jobs de sincronización registrados' });
  }
  if (!response) {
    return res.status(404).json({ error: 'Job no encontrado' });
  }
  return res.json({ ok: true, job: response });
});

app.get('/admin/stripe/sync-customers/async/:jobId', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const response = getStripeSyncJob(req.params.jobId);
  if (!response) {
    return res.status(404).json({ error: 'Job no encontrado' });
  }
  return res.json({ ok: true, job: response });
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

// /partner/:id/pricing-preview ahora vive en src/modules/pricing/routes.js

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

// Moodle (webhook + matrículas/retry + sync + test/courses/mapping) → src/modules/moodle
app.use(require('./src/modules/moodle/routes'));

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
              a.moodle_completed_at, a.expires_at,
              a.id AS activation_id,
              a.email_status, a.email_error, a.email_sent_at,
              a.email_retry_count, a.email_last_attempt_at
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

// Courses (CRUD admin + cursos del partner + catalogs) → src/modules/courses
app.use(require('./src/modules/courses/routes'));

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
// Final clients (clientes finales del partner) → src/modules/final-clients
app.use(require('./src/modules/final-clients/routes'));

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

      // Correo al estudiante (no bloqueante):
      //  - cuenta nueva en Moodle        → bienvenida con credenciales (usuario + contraseña temporal)
      //  - cuenta existente, curso nuevo → aviso de nueva certificación (misma plantilla, sin contraseña)
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
      } else if ((moodleStatus === 'ENROLLED' || moodleStatus === 'MOCKED') && !moodleResult.createdNewUser) {
        await sendStudentWelcomeEmail({
          activationId,
          to:           user_email,
          studentName:  user_name,
          courseName:   course.rows[0].name,
          months:       reqMonths,
          expiresAt,
          userId:       req.user.sub,
          isNewEnrollment: true,
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

// Reenvío manual del correo de notificación al estudiante, desde el partner.
//
// Controles anti-abuso/anti-spam (todos en backend, no en el botón):
//  - Tope: máx. MAX_PARTNER_EMAIL_RETRIES reenvíos por activación (luego solo admin).
//  - Cooldown: mínimo EMAIL_RESEND_COOLDOWN_MIN minutos entre intentos.
//  - Solo aplica a correos ya intentados (email_status FAILED o SENT).
//  - Ownership: la activación debe pertenecer al partner autenticado.
//  - Cada intento queda auditado en system_events (EMAIL_MANUAL_RESEND_*).
app.post('/partner/:id/activations/:activationId/resend-email',
  authenticate, requireRole('partner'), apiLimiter,
  param('id').isInt().withMessage('Partner ID inválido'),
  param('activationId').isInt({ min: 1 }).withMessage('activationId inválido'),
  handleValidationErrors,
  async (req, res) => {
    const pid = req.params.id;
    const { activationId } = req.params;

    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    try {
      const r = await pool.query(
        `SELECT a.id, a.user_name, a.user_email, a.expires_at,
                a.moodle_status, a.moodle_username, a.moodle_temp_password,
                a.email_status, a.email_retry_count, a.email_last_attempt_at,
                c.name AS course_name, v.partner_id
         FROM activations a
         JOIN vouchers v ON v.id = a.voucher_id
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.id = $1`,
        [activationId]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Activación no encontrada' });
      }
      const act = r.rows[0];

      // Ownership: el voucher de la activación debe ser de este partner
      if (String(act.partner_id) !== String(pid)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      // Solo se reenvía un correo que ya se intentó antes (FAILED o SENT)
      if (!['FAILED', 'SENT'].includes(act.email_status)) {
        return res.status(400).json({
          error: 'No hay un correo de notificación para reenviar en esta activación.',
          code: 'NOTHING_TO_RESEND'
        });
      }

      // Tope de reintentos del partner
      const retryCount = act.email_retry_count || 0;
      if (retryCount >= MAX_PARTNER_EMAIL_RETRIES) {
        await logSystemEvent('EMAIL_MANUAL_RESEND_BLOCKED', 'EMAIL', req.user.sub, null, null,
          { activation_id: parseInt(activationId, 10), reason: 'retry_limit', retry_count: retryCount }, 'FAILED', 'retry_limit_reached', req);
        return res.status(429).json({
          error: `Alcanzaste el máximo de reenvíos (${MAX_PARTNER_EMAIL_RETRIES}). Si el estudiante aún no recibe el correo, contacta a un administrador.`,
          code: 'RETRY_LIMIT_REACHED'
        });
      }

      // Cooldown entre intentos
      if (act.email_last_attempt_at) {
        const elapsedMin = (Date.now() - new Date(act.email_last_attempt_at).getTime()) / 60000;
        if (elapsedMin < EMAIL_RESEND_COOLDOWN_MIN) {
          const wait = Math.max(1, Math.ceil(EMAIL_RESEND_COOLDOWN_MIN - elapsedMin));
          return res.status(429).json({
            error: `Debes esperar ${wait} min antes de reenviar de nuevo.`,
            code: 'COOLDOWN',
            retry_after_minutes: wait
          });
        }
      }

      // Registrar el intento ya (el cooldown se mide por intento, exitoso o no)
      await pool.query('UPDATE activations SET email_last_attempt_at = NOW() WHERE id=$1', [activationId]);

      // Variante: con credenciales (cuenta nueva) o aviso de nueva certificación (cuenta existente)
      const isNewEnrollment = !act.moodle_temp_password;

      const emailStatus = await sendStudentWelcomeEmail({
        activationId:  parseInt(activationId, 10),
        to:            act.user_email,
        studentName:   act.user_name,
        courseName:    act.course_name,
        username:      act.moodle_username,
        tempPassword:  act.moodle_temp_password,
        expiresAt:     act.expires_at,
        userId:        req.user.sub,
        isNewEnrollment,
        force:         true,
        req
      });

      // El tope solo consume un reintento cuando el correo SÍ se entregó (anti-spam:
      // limita notificaciones efectivas, no castiga fallos transitorios de SMTP).
      let newRetryCount = retryCount;
      if (emailStatus === 'SENT') {
        const upd = await pool.query(
          'UPDATE activations SET email_retry_count = email_retry_count + 1 WHERE id=$1 RETURNING email_retry_count',
          [activationId]
        );
        newRetryCount = upd.rows[0].email_retry_count;
      }

      await logSystemEvent(
        `EMAIL_MANUAL_RESEND_${emailStatus || 'SKIPPED'}`,
        'EMAIL', req.user.sub, null, null,
        { activation_id: parseInt(activationId, 10), to: act.user_email, new_enrollment: isNewEnrollment, retry_count: newRetryCount },
        emailStatus === 'SENT' ? 'SUCCESS' : 'FAILED',
        emailStatus === 'SENT' ? null : `email_status=${emailStatus}`, req
      );

      if (emailStatus !== 'SENT') {
        return res.status(502).json({
          error: 'No se pudo reenviar el correo en este momento. Intenta de nuevo más tarde.',
          code: 'SEND_FAILED',
          email_status: emailStatus
        });
      }

      return res.json({
        ok: true,
        email_status: emailStatus,
        email_retry_count: newRetryCount,
        retries_remaining: Math.max(0, MAX_PARTNER_EMAIL_RETRIES - newRetryCount)
      });
    } catch (e) {
      console.error('❌ Error en reenvío de correo del partner:', e);
      res.status(500).json({ error: 'Error al reenviar el correo' });
    }
  }
);

// Reenvío del correo de notificación al estudiante, desde el admin (vía de escalación).
// A diferencia del partner: NO aplica tope ni cooldown, y puede enviar aunque el correo
// nunca se haya intentado (útil para activaciones previas a esta función), siempre que
// la matrícula en Moodle esté activa (ENROLLED/MOCKED). Queda auditado en system_events.
app.post('/admin/activations/:activationId/resend-email',
  authenticate, requireRole('admin'), apiLimiter,
  param('activationId').isInt({ min: 1 }).withMessage('activationId inválido'),
  handleValidationErrors,
  async (req, res) => {
    const { activationId } = req.params;
    try {
      const r = await pool.query(
        `SELECT a.id, a.user_name, a.user_email, a.expires_at,
                a.moodle_status, a.moodle_username, a.moodle_temp_password, a.email_status,
                c.name AS course_name
         FROM activations a
         LEFT JOIN courses c ON c.id = a.course_id
         WHERE a.id = $1`,
        [activationId]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Activación no encontrada' });
      }
      const act = r.rows[0];

      // Debe existir acceso al curso que justifique la notificación
      const notifiableStatuses = ['ENROLLED', 'MOCKED', 'COMPLETED', 'COURSE_COMPLETED'];
      if (!notifiableStatuses.includes((act.moodle_status || '').toUpperCase())) {
        return res.status(400).json({
          error: 'La activación no tiene una matrícula activa en Moodle; no hay nada que notificar.',
          code: 'NO_ACTIVE_ENROLLMENT'
        });
      }

      await pool.query('UPDATE activations SET email_last_attempt_at = NOW() WHERE id=$1', [activationId]);

      const isNewEnrollment = !act.moodle_temp_password;

      const emailStatus = await sendStudentWelcomeEmail({
        activationId:  parseInt(activationId, 10),
        to:            act.user_email,
        studentName:   act.user_name,
        courseName:    act.course_name,
        username:      act.moodle_username,
        tempPassword:  act.moodle_temp_password,
        expiresAt:     act.expires_at,
        userId:        req.user.sub,
        isNewEnrollment,
        force:         true,
        req
      });

      await logSystemEvent(
        `EMAIL_ADMIN_RESEND_${emailStatus || 'SKIPPED'}`,
        'EMAIL', req.user.sub, null, null,
        { activation_id: parseInt(activationId, 10), to: act.user_email, new_enrollment: isNewEnrollment },
        emailStatus === 'SENT' ? 'SUCCESS' : 'FAILED',
        emailStatus === 'SENT' ? null : `email_status=${emailStatus}`, req
      );

      if (emailStatus !== 'SENT') {
        return res.status(502).json({
          error: 'No se pudo reenviar el correo en este momento. Intenta de nuevo más tarde.',
          code: 'SEND_FAILED',
          email_status: emailStatus
        });
      }

      return res.json({ ok: true, email_status: emailStatus, new_enrollment: isNewEnrollment });
    } catch (e) {
      console.error('❌ Error en reenvío de correo del admin:', e);
      res.status(500).json({ error: 'Error al reenviar el correo' });
    }
  }
);


// (rutas de matrículas/retry de Moodle movidas a src/modules/moodle)

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
// syncMoodleCompletions → src/modules/moodle/service.js (importado arriba).

// (rutas /admin/moodle/* y /admin/courses/:id/moodle-mapping movidas a src/modules/moodle)

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
           -- moodle_temp_password NO se expone en el listado admin (dato sensible);
           -- el reenvío de credenciales lo usa solo del lado servidor.
           a.moodle_completed_at,
           a.moodle_completion_synced_at,
           a.expires_at,
           a.activation_status,
           a.email_status,
           a.email_error,
           a.email_sent_at,
           a.email_retry_count,
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
// Users (CRUD /admin/users) → src/modules/users
app.use(require('./src/modules/users/routes'));

// (rutas GET/GET:id/PUT/DELETE de /admin/users movidas a src/modules/users)

// Settings (política de contraseñas + configuración de activación) → src/modules/settings
app.use(require('./src/modules/settings/routes'));

// Roles and permissions (admin only)

// Roles & permisos → src/modules/roles
app.use(require('./src/modules/roles/routes'));

// (rutas PUT/DELETE/permissions de roles movidas a src/modules/roles)

// (DELETE /admin/users/:id movido a src/modules/users)

// authenticate / requireRole / requirePermission / requireAnyPermission
// ahora viven en src/lib/auth.js (importados arriba).

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
