-- Migration: vouchers activation by course + final client
-- Date: 2026-03-25

BEGIN;

CREATE TABLE IF NOT EXISTS courses (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE vouchers
    ADD COLUMN IF NOT EXISTS course_id INTEGER;

ALTER TABLE activations
    ADD COLUMN IF NOT EXISTS course_id INTEGER,
    ADD COLUMN IF NOT EXISTS final_client VARCHAR(200);

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

INSERT INTO courses (name)
SELECT c.title
FROM catalogs c
WHERE NOT EXISTS (SELECT 1 FROM courses);

INSERT INTO courses (name)
SELECT seed.name
FROM (
    VALUES ('Curso Java'), ('Curso JavaScript'), ('Curso Python')
) AS seed(name)
WHERE NOT EXISTS (SELECT 1 FROM courses);

COMMIT;
