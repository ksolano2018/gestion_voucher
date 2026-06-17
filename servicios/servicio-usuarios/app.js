const express = require('express');
const cors = require('cors');
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
const { logSecurityEvent, logSystemEvent } = require('./src/lib/audit');
const { authLimiter, apiLimiter } = require('./src/lib/rateLimit');
const { handleValidationErrors } = require('./src/lib/validation');
const { authenticate, requireRole, requirePermission, requireAnyPermission } = require('./src/lib/auth');
// Envío de correo delegado al microservicio servicio-notificaciones (cliente HTTP).
const { sendStudentWelcomeEmail } = require('./src/integrations/notifications');
// Pricing: app.js sólo usa los defaults de initDb; el resto de helpers viven en el módulo pricing.
const { ensureDefaultPricingProfilesAndRules, getDefaultPricingProfileId } = require('./src/modules/pricing/service');
// backfillPaidPurchaseVouchers: usado por las rutas de activación/vouchers (aún inline).
const { backfillPaidPurchaseVouchers } = require('./src/modules/purchases/service');
// La integración Stripe (cliente + sync + webhook) vive en src/integrations/stripe.js y
// src/modules/purchases/routes.js; app.js ya no la usa directamente.
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

// backfillPaidPurchaseVouchers → src/modules/purchases/service.js (importado arriba).

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

// Compras + pagos Stripe (checkout, webhook, transaction-events, pagos, cortesía/externas/ajuste) → src/modules/purchases
app.use(require("./src/modules/purchases/routes"));

// Moodle (webhook + matrículas/retry + sync + test/courses/mapping) → src/modules/moodle
app.use(require('./src/modules/moodle/routes'));


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

// Vouchers de cortesía, compras externas, ajuste y detalle de compra → src/modules/purchases

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
