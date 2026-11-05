-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The application roles may use the public schema whatever its ACL says.
--
-- The product relies on extensions installed in `public`: pg_trgm's
-- `similarity()` dedupes agent memory facts and its operator classes back the
-- ticket search indexes. Every liaison_* role resolved those through the
-- default grant of USAGE on `public` to PUBLIC. A database whose public schema
-- lost that grant (restored from a dump of a hardened cluster, or hardened by
-- hand) still ran, but a role without USAGE skips `public` when it resolves a
-- name, so `similarity(text, unknown) does not exist` failed every query that
-- calls one, and the memory consolidation job with them.
--
-- Granting USAGE to each role the migrations create makes the product work on
-- such a database too, and changes nothing on one that kept the default.
-- USAGE only: no role gains CREATE on `public`. Only roles that exist are
-- granted (a cluster provisioned by hand may lack the optional ones).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'liaison_app',
    'liaison_admin',
    'liaison_definer',
    'liaison_readonly',
    'liaison_request',
    'liaison_rls',
    'liaison_schema_admin'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
    END IF;
  END LOOP;
END $$;
