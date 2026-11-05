-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The runtime role can read the migration ledger.
--
-- /healthz reports migrationHead from a count of drizzle.__drizzle_migrations,
-- read through the app's own connection. The drizzle schema belongs to the
-- migration role, and liaison_app was never granted anything on it, so every
-- probe failed with "permission denied for schema drizzle", read as zero
-- applied, and reported pending:0/N on a fully migrated database.
--
-- Read only: USAGE on the schema and SELECT on the ledger table. The runtime
-- role still cannot write the ledger. Skipped where liaison_app does not exist
-- (single-role deployments connect as the owner and already read it).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT USAGE ON SCHEMA drizzle TO liaison_app;
    GRANT SELECT ON drizzle.__drizzle_migrations TO liaison_app;
  END IF;
END $$;
