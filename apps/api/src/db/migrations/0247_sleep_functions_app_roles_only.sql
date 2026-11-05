-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The pg_sleep family runs only for the application roles.
--
-- Postgres grants EXECUTE on pg_sleep, pg_sleep_for and pg_sleep_until to
-- PUBLIC, so every login could call them, the database connector's read-only
-- role (liaison_readonly) included: a holder of its credentials could keep
-- connections busy for the whole statement_timeout. A privilege granted to
-- PUBLIC cannot be denied to one role, so the grant moves: the application
-- roles that exist get it explicitly, then PUBLIC loses it. liaison_readonly
-- and any other login keep no EXECUTE on these functions. Superusers are not
-- affected. Re-runnable.
--
-- The functions belong to the bootstrap superuser: run as another role, the
-- REVOKE only warns and changes nothing (MIGRATION_DATABASE_URL is the
-- superuser in the shipped compose file).

-- reviewed-dynamic: GRANT EXECUTE on three built-in functions to each existing application role; no DDL
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'liaison_app',
    'liaison_admin',
    'liaison_definer',
    'liaison_request',
    'liaison_rls',
    'liaison_schema_admin'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision), '
        'pg_catalog.pg_sleep_for(interval), '
        'pg_catalog.pg_sleep_until(timestamp with time zone) TO %I',
        r
      );
    END IF;
  END LOOP;
END $$;

-- reviewed-dynamic: a REVOKE of the EXECUTE privilege, no dynamic SQL
-- expand-safe: the previous release calls these functions only as the application roles, granted above
REVOKE EXECUTE ON FUNCTION
  pg_catalog.pg_sleep(double precision),
  pg_catalog.pg_sleep_for(interval),
  pg_catalog.pg_sleep_until(timestamp with time zone)
FROM PUBLIC;
