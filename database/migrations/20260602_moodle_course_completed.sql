-- Migración: nuevo estado COURSE_COMPLETED en activations.moodle_status
-- COURSE_COMPLETED: el estudiante completó las actividades del curso (vio el contenido)
-- COMPLETED: el estudiante aprobó la evaluación final (quiz ≥ 60%)
--
-- No se agrega CHECK constraint para mantener compatibilidad con valores existentes.
-- Estados válidos de moodle_status:
--   PENDING          → voucher activado, enrollment pendiente en Moodle
--   ENROLLED         → enrollado en Moodle, sin completar actividades
--   COURSE_COMPLETED → completó las actividades del curso (page visto)
--   COMPLETED        → aprobó la evaluación final (quiz ≥ 60%)
--   SKIPPED          → curso sin moodle_course_id mapeado
--   MOCKED           → modo mock (desarrollo)
--   FAILED           → error en enrollment

-- Columna ya existe como varchar(50), solo se agrega comentario en DB
COMMENT ON COLUMN activations.moodle_status IS
  'Estado Moodle del estudiante: PENDING|ENROLLED|COURSE_COMPLETED|COMPLETED|SKIPPED|MOCKED|FAILED';

-- Índice para filtrar por el nuevo estado
CREATE INDEX IF NOT EXISTS idx_activations_moodle_status_cc
  ON activations (moodle_status)
  WHERE moodle_status IN ('COURSE_COMPLETED', 'ENROLLED');
