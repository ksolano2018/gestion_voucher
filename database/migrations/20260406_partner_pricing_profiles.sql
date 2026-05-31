-- Migration: configurable partner pricing by category and quantity
-- Date: 2026-04-06

BEGIN;

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

ALTER TABLE partners ADD COLUMN IF NOT EXISTS pricing_profile_id INTEGER;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS special_pricing_profile_id INTEGER;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS pricing_details JSONB;

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

COMMIT;