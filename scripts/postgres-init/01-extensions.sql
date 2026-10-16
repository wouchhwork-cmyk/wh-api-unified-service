-- Extensions the schema depends on. Created here so a fresh dev database has
-- them before the first migration runs; production creates them in migration 1.
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram customer name search (schema.md §16)
