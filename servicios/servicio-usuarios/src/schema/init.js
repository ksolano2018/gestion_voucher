'use strict';
// Bootstrap del esquema en runtime (CREATE IF NOT EXISTS + ALTER IF NOT EXISTS) y
// seeds por defecto (catálogo, perfiles de pricing, roles, admin y partner demo).
// Es el bootstrap de-facto que corre en cada arranque vía initDb(); idempotente.
//
// DEUDA TÉCNICA (Fase 1d, pendiente): consolidar esto + database/init.sql +
// database/migrations/ en un runner de migraciones versionadas como única fuente
// de verdad del esquema. Hoy database/migrations/ se aplica a mano y este initDb()
// es el que realmente crea/migra el esquema en local/QA/PD.
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { getDefaultPermissionsForRole, sanitizeRolePermissions, normalizeRoleName } = require('../lib/rbac');
const { ensureDefaultPricingProfilesAndRules, getDefaultPricingProfileId } = require('../modules/pricing/service');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@certjoin.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
    -- Backfill igual que database/migrations/20260412_users_first_last_name.sql
    UPDATE users SET
      first_name = CASE
        WHEN position('.' IN split_part(email, '@', 1)) > 0
          THEN initcap(split_part(split_part(email, '@', 1), '.', 1))
        WHEN position('_' IN split_part(email, '@', 1)) > 0
          THEN initcap(split_part(split_part(email, '@', 1), '_', 1))
        WHEN position('-' IN split_part(email, '@', 1)) > 0
          THEN initcap(split_part(split_part(email, '@', 1), '-', 1))
        ELSE
          initcap(split_part(email, '@', 1))
      END,
      last_name = CASE
        WHEN position('.' IN split_part(email, '@', 1)) > 0
          THEN NULLIF(initcap(split_part(split_part(email, '@', 1), '.', 2)), '')
        WHEN position('_' IN split_part(email, '@', 1)) > 0
          THEN NULLIF(initcap(split_part(split_part(email, '@', 1), '_', 2)), '')
        WHEN position('-' IN split_part(email, '@', 1)) > 0
          THEN NULLIF(initcap(split_part(split_part(email, '@', 1), '-', 2)), '')
        ELSE
          NULL
      END
    WHERE first_name IS NULL;

    -- Inactividad: marca de último uso del refresh token (ventana deslizante de sesión).
    ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

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

  // Plantillas de correo editables (cuerpo Mustache). Versionadas: 1 activa por clave.
  // Si una clave no tiene fila activa, el microservicio usa la plantilla por defecto
  // (diseño oficial en código) → el correo nunca depende de que exista una fila.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id SERIAL PRIMARY KEY,
      template_key VARCHAR(64) NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      body_text TEXT,
      description TEXT,
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      version INT NOT NULL DEFAULT 1,
      updated_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_email_templates_key ON email_templates(template_key);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_templates_active ON email_templates(template_key) WHERE is_active;
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

  // Rol "soporte": admin OPERATIVO sin gestión de usuarios/roles (users='none').
  // Es la cuenta con la que opera el equipo de soporte en PRD, distinta del admin
  // del cliente y revocable por él. Idempotente (no pisa si ya existe).
  const soportePerms = sanitizeRolePermissions({ ...getDefaultPermissionsForRole('admin'), users: 'none' }, 'system_role');
  await pool.query(
    `INSERT INTO roles (name, display_name, permissions, active, is_system, role_type, updated_at)
     VALUES ('soporte', 'Soporte', $1::jsonb, TRUE, FALSE, 'system_role', NOW())
     ON CONFLICT (name) DO NOTHING`,
    [JSON.stringify(soportePerms)]
  );

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

  // En PRD el admin y el soporte se siembran con contraseña TEMPORAL y se fuerza el
  // cambio en el primer login (el cliente/soporte pone la suya; nosotros no la sabemos).
  // Gateado por env para NO afectar local/QA (donde el admin ya existe y los tests
  // esperan login directo). El wizard setup.sh pone SEED_FORCE_PASSWORD_CHANGE=true.
  const forceChange = process.env.SEED_FORCE_PASSWORD_CHANGE === 'true';

  // Seed admin user if none
  const u = await pool.query("SELECT count(*) FROM users WHERE role='admin'");
  if(parseInt(u.rows[0].count) === 0){
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query('INSERT INTO users (email,password,role,must_change_password) VALUES ($1,$2,$3,$4)',[ADMIN_EMAIL,hash,'admin',forceChange]);
    console.log('Seeded admin user:', ADMIN_EMAIL, forceChange ? '(debe cambiar contraseña)' : '');
  }

  // Seed usuario de SOPORTE (nuestro) si se define por env y no existe. Rol 'soporte'.
  const supportEmail = process.env.SUPPORT_EMAIL;
  const supportPass = process.env.SUPPORT_PASSWORD;
  if (supportEmail && supportPass) {
    const se = await pool.query('SELECT 1 FROM users WHERE email=$1', [supportEmail]);
    if (se.rowCount === 0) {
      const shash = await bcrypt.hash(supportPass, 10);
      await pool.query('INSERT INTO users (email,password,role,must_change_password) VALUES ($1,$2,$3,$4)',[supportEmail, shash, 'soporte', forceChange]);
      console.log('Seeded support user:', supportEmail, forceChange ? '(debe cambiar contraseña)' : '');
    }
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

module.exports = { initDb };
