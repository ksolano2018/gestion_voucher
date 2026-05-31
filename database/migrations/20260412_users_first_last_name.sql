-- Migration: Add first_name and last_name to users table
-- Date: 2026-04-12

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS last_name  VARCHAR(100);

-- Backfill: derive first/last name from email for pre-existing users
-- Priority of separator detection: dot (.) > underscore (_) > hyphen (-)
-- Examples:
--   juan.perez@mail.com   -> Juan / Perez
--   maria_lopez@mail.com  -> Maria / Lopez
--   carlos-rojas@mail.com -> Carlos / Rojas
--   admin@mail.com        -> Admin / NULL
UPDATE users
SET
  first_name = CASE
    WHEN position('.' IN split_part(email, '@', 1)) > 0
      THEN initcap(split_part(split_part(email, '@', 1), '.', 1))
    WHEN position('_' IN split_part(email, '@', 1)) > 0
      THEN initcap(split_part(split_part(email, '@', 1), '_', 1))
    WHEN position('-' IN split_part(email, '@', 1)) > 0
      THEN initcap(split_part(split_part(email, '@', 1), '-', 1))
    ELSE
      initcap(split_part(email, '@', 1))
  END,
  last_name = CASE
    WHEN position('.' IN split_part(email, '@', 1)) > 0
      THEN NULLIF(initcap(split_part(split_part(email, '@', 1), '.', 2)), '')
    WHEN position('_' IN split_part(email, '@', 1)) > 0
      THEN NULLIF(initcap(split_part(split_part(email, '@', 1), '_', 2)), '')
    WHEN position('-' IN split_part(email, '@', 1)) > 0
      THEN NULLIF(initcap(split_part(split_part(email, '@', 1), '-', 2)), '')
    ELSE
      NULL
  END
WHERE first_name IS NULL;
