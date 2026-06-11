-- Migration: notificación por correo al crear estudiante en Moodle
-- Date: 2026-06-10
-- Añade tracking del correo de bienvenida enviado al estudiante en activations

BEGIN;

ALTER TABLE activations
    ADD COLUMN IF NOT EXISTS email_status  VARCHAR(30),   -- SENT | FAILED | SKIPPED
    ADD COLUMN IF NOT EXISTS email_error   TEXT,
    ADD COLUMN IF NOT EXISTS email_to      VARCHAR(200),
    ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMP;

COMMIT;
