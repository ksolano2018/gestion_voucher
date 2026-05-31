-- Crear bases de datos necesarias
SELECT 'CREATE DATABASE admin' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'admin')\gexec
SELECT 'CREATE DATABASE proyectodb' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'proyectodb')\gexec
SELECT 'CREATE DATABASE voucherdb' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'voucherdb')\gexec

-- Conectar a proyectodb (BD principal de la aplicación)
\c proyectodb;

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
    stripe_status VARCHAR(50),
    payment_intent_id VARCHAR(200),
    pricing_details JSONB,
    status VARCHAR(50) DEFAULT 'PENDING',
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_vouchers_course_id'
    ) THEN
        ALTER TABLE vouchers
            ADD CONSTRAINT fk_vouchers_course_id
            FOREIGN KEY (course_id) REFERENCES courses(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_activations_course_id'
    ) THEN
        ALTER TABLE activations
            ADD CONSTRAINT fk_activations_course_id
            FOREIGN KEY (course_id) REFERENCES courses(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_partners_pricing_profile_id'
    ) THEN
        ALTER TABLE partners
            ADD CONSTRAINT fk_partners_pricing_profile_id
            FOREIGN KEY (pricing_profile_id) REFERENCES pricing_profiles(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_partners_special_pricing_profile_id'
    ) THEN
        ALTER TABLE partners
            ADD CONSTRAINT fk_partners_special_pricing_profile_id
            FOREIGN KEY (special_pricing_profile_id) REFERENCES pricing_profiles(id);
    END IF;
END $$;

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
    first_name VARCHAR(100),
    last_name  VARCHAR(100),
    stripe_customer_id VARCHAR(200) UNIQUE,
    must_change_password BOOLEAN DEFAULT TRUE,
    first_login_at TIMESTAMP,
    active BOOLEAN DEFAULT TRUE,
    password_expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO system_settings (key, value, description)
VALUES ('password_expiry_days', '0', 'Días de validez de contraseña. 0 = sin caducidad')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    token VARCHAR(200) UNIQUE NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tablas para manejo de Stripe
CREATE TABLE IF NOT EXISTS stripe_customers (
    id SERIAL PRIMARY KEY,
    stripe_customer_id VARCHAR(200) UNIQUE NOT NULL,
    customer_email VARCHAR(200),
    customer_name VARCHAR(200),
    partner_id INTEGER REFERENCES partners(id),
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_line_items (
    id SERIAL PRIMARY KEY,
    purchase_id INTEGER REFERENCES purchases(id),
    stripe_product_id VARCHAR(200),
    product_name VARCHAR(500),
    quantity INTEGER,
    unit_amount NUMERIC(10,2),
    total_amount NUMERIC(10,2),
    currency VARCHAR(10),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_events (
    id SERIAL PRIMARY KEY,
    stripe_event_id VARCHAR(200) UNIQUE NOT NULL,
    event_type VARCHAR(100),
    event_data JSONB,
    processed BOOLEAN DEFAULT FALSE,
    processed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de auditoría: Todos los eventos del sistema
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

CREATE TABLE IF NOT EXISTS partner_final_clients (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Índices para búsqueda rápida
CREATE INDEX IF NOT EXISTS idx_system_events_user_id ON system_events(user_id);
CREATE INDEX IF NOT EXISTS idx_system_events_stripe_customer_id ON system_events(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_event_type ON system_events(event_type);
CREATE INDEX IF NOT EXISTS idx_system_events_event_category ON system_events(event_category);
CREATE INDEX IF NOT EXISTS idx_partner_final_clients_partner_id ON partner_final_clients(partner_id);

INSERT INTO pricing_profiles (code, name, profile_type, description, active, is_system)
SELECT seed.code, seed.name, seed.profile_type, seed.description, TRUE, TRUE
FROM (
        VALUES
                ('silver', 'Silver', 'CATEGORY', 'Categoría base para partners Silver'),
                ('plate', 'Plate', 'CATEGORY', 'Categoría comercial intermedia para partners Plate'),
                ('gold', 'Gold', 'CATEGORY', 'Categoría premium para partners Gold')
) AS seed(code, name, profile_type, description)
WHERE NOT EXISTS (
        SELECT 1 FROM pricing_profiles pp WHERE pp.code = seed.code
);

INSERT INTO pricing_rules (profile_id, min_qty, max_qty, unit_price, active)
SELECT pp.id, seed.min_qty, seed.max_qty, seed.unit_price, TRUE
FROM pricing_profiles pp
JOIN (
        VALUES
                ('silver', 1, 5, 100.00),
                ('silver', 6, 20, 90.00),
                ('silver', 21, NULL, 80.00),
                ('plate', 1, 5, 96.00),
                ('plate', 6, 20, 86.00),
                ('plate', 21, NULL, 76.00),
                ('gold', 1, 5, 92.00),
                ('gold', 6, 20, 82.00),
                ('gold', 21, NULL, 72.00)
) AS seed(code, min_qty, max_qty, unit_price)
    ON pp.code = seed.code
WHERE NOT EXISTS (
        SELECT 1 FROM pricing_rules pr
        WHERE pr.profile_id = pp.id
);

UPDATE partners
SET pricing_profile_id = pp.id
FROM pricing_profiles pp
WHERE partners.pricing_profile_id IS NULL
    AND pp.code = 'silver';