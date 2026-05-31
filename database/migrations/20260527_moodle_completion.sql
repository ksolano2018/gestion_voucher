-- Migration: Moodle course completion tracking
-- Date: 2026-05-27
-- Adds completion columns to activations

BEGIN;

ALTER TABLE activations
    ADD COLUMN IF NOT EXISTS moodle_completed_at        TIMESTAMP,
    ADD COLUMN IF NOT EXISTS moodle_completion_synced_at TIMESTAMP;

-- Índice para sincronización eficiente: solo los ENROLLED con moodle_user_id
CREATE INDEX IF NOT EXISTS idx_activations_completion_sync
    ON activations(moodle_user_id, course_id)
    WHERE moodle_status = 'ENROLLED' AND moodle_user_id IS NOT NULL;

COMMIT;
