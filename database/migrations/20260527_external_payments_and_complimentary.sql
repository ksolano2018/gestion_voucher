-- Migration: External payments and complimentary vouchers
-- Date: 2026-05-27
-- Adds payment_method, external_reference, notes to purchases
-- Adds voucher_type, complimentary_reason, complimentary_issued_by to vouchers

BEGIN;

ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS payment_method      VARCHAR(50)  DEFAULT 'stripe',
    ADD COLUMN IF NOT EXISTS external_reference  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS notes               TEXT;

-- Marcar registros Stripe existentes
UPDATE purchases SET payment_method = 'stripe' WHERE payment_method IS NULL;

ALTER TABLE vouchers
    ADD COLUMN IF NOT EXISTS voucher_type              VARCHAR(20) DEFAULT 'STANDARD',
    ADD COLUMN IF NOT EXISTS complimentary_reason      TEXT,
    ADD COLUMN IF NOT EXISTS complimentary_issued_by   INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_purchases_payment_method ON purchases(payment_method);
CREATE INDEX IF NOT EXISTS idx_vouchers_type            ON vouchers(voucher_type);

COMMIT;
