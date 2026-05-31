-- Migration: add more language and architecture courses
-- Date: 2026-04-06

BEGIN;

INSERT INTO catalogs (title, description, price)
SELECT seed.title, seed.description, seed.price
FROM (
    VALUES
        ('Curso Python', 'Automatización y desarrollo backend con Python', 189.00),
        ('Curso Go', 'Servicios concurrentes y APIs de alto rendimiento con Go', 209.00),
        ('Curso Rust', 'Sistemas seguros y software de alto rendimiento con Rust', 219.00),
        ('Curso Node.js', 'APIs escalables y eventos con Node.js', 199.00),
        ('Arquitectura de Microservicios', 'Diseño distribuido, resiliencia y observabilidad', 249.00),
        ('Arquitectura Hexagonal', 'Puertos y adaptadores para sistemas mantenibles', 229.00),
        ('Arquitectura Event-Driven', 'Integración asíncrona con eventos y mensajería', 239.00),
        ('Arquitectura Cloud Native', 'Patrones modernos para despliegues en contenedores', 259.00)
) AS seed(title, description, price)
WHERE NOT EXISTS (
    SELECT 1 FROM catalogs c WHERE LOWER(c.title) = LOWER(seed.title)
);

INSERT INTO courses (name)
SELECT seed.name
FROM (
    VALUES
        ('Curso Python'),
        ('Curso Go'),
        ('Curso Rust'),
        ('Curso Node.js'),
        ('Arquitectura de Microservicios'),
        ('Arquitectura Hexagonal'),
        ('Arquitectura Event-Driven'),
        ('Arquitectura Cloud Native')
) AS seed(name)
WHERE NOT EXISTS (
    SELECT 1 FROM courses c WHERE LOWER(c.name) = LOWER(seed.name)
);

COMMIT;