-- Jerarquía padre-hijo de certificaciones (Content/Simulator, legacy en transición).
-- Un hijo apunta a su padre; jerarquía de un solo nivel (validada en el endpoint,
-- no expresable como CHECK de Postgres). El partner solo ve/activa padres/standalone.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS parent_course_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_courses_parent_course_id ON courses(parent_course_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_courses_parent_course_id'
  ) THEN
    ALTER TABLE courses ADD CONSTRAINT fk_courses_parent_course_id
      FOREIGN KEY (parent_course_id) REFERENCES courses(id);
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- Matrícula de cursos hijo por activación. `activations` es 1:1 con un solo curso
-- (el padre); esta tabla registra el detalle N:1 del fan-out de matrícula Moodle
-- hacia cada hijo vinculado a ese padre en el momento de activar el voucher.
CREATE TABLE IF NOT EXISTS activation_child_enrollments (
  id SERIAL PRIMARY KEY,
  activation_id INTEGER NOT NULL REFERENCES activations(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  moodle_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  moodle_user_id INTEGER,
  moodle_username VARCHAR(100),
  moodle_temp_password VARCHAR(100),
  moodle_error TEXT,
  moodle_enrolled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (activation_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_ace_activation ON activation_child_enrollments(activation_id);

-- NOTA: este archivo es documentación/histórico. El esquema real que corre en cada
-- arranque vive en servicios/servicio-usuarios/src/schema/init.js (initDb()).
