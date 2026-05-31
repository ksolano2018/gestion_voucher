-- Migration: Moodle LMS integration
-- Date: 2026-05-14
-- Adds moodle_course_id to courses and Moodle enrollment tracking to activations

BEGIN;

ALTER TABLE courses
    ADD COLUMN IF NOT EXISTS moodle_course_id INTEGER;

ALTER TABLE activations
    ADD COLUMN IF NOT EXISTS moodle_status       VARCHAR(50)  DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS moodle_user_id      INTEGER,
    ADD COLUMN IF NOT EXISTS moodle_error        TEXT,
    ADD COLUMN IF NOT EXISTS moodle_enrolled_at  TIMESTAMP,
    ADD COLUMN IF NOT EXISTS moodle_retried_at   TIMESTAMP,
    ADD COLUMN IF NOT EXISTS moodle_retry_count  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_activations_moodle_status
    ON activations(moodle_status)
    WHERE moodle_status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_courses_moodle_course_id
    ON courses(moodle_course_id)
    WHERE moodle_course_id IS NOT NULL;

COMMIT;
