-- ════════════════════════════════════════════════════════════════════
-- 0009 · Attempted move of pg_net out of public schema (advisor lint 0014).
-- pg_net doesn't support `ALTER EXTENSION ... SET SCHEMA`, so this
-- migration is a no-op for the schema move itself. Documented here so
-- the migration sequence is gap-free; the WARN-level lint remains.
-- ════════════════════════════════════════════════════════════════════

create schema if not exists extensions;
-- alter extension pg_net set schema extensions;  -- fails: not supported
