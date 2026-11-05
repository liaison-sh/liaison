-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The request role (liaison_rls) holds on app tables only what it holds on
-- kernel tables: SELECT, INSERT, UPDATE, DELETE, REFERENCES.
--
-- Runtime app registration used to GRANT ALL on every table of an app schema,
-- and set the same as the schema's default privileges. ALL includes TRUNCATE
-- and TRIGGER, which ignore row-level security (FORCE included): on the request
-- connection one TRUNCATE empties every org's rows and a trigger runs on every
-- org's writes. Registration now grants the baseline list
-- (modules/apps/runtime.ts); this takes the excess back from tables and
-- defaults already in place, since registration skips a schema whose DDL is
-- current. Re-runnable.
DO $$
DECLARE
  s record;
  d record;
  extra text := CASE WHEN current_setting('server_version_num')::int >= 170000
                     THEN 'TRUNCATE, TRIGGER, MAINTAIN' ELSE 'TRUNCATE, TRIGGER' END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    RETURN;
  END IF;
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\_%' LOOP
    EXECUTE format('REVOKE %s ON ALL TABLES IN SCHEMA %I FROM liaison_rls', extra, s.nspname);
  END LOOP;
  FOR d IN
    SELECT n.nspname, pg_get_userbyid(da.defaclrole) AS grantor
    FROM pg_default_acl da
    JOIN pg_namespace n ON n.oid = da.defaclnamespace
    WHERE n.nspname LIKE 'app\_%' AND da.defaclobjtype = 'r'
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE %s ON TABLES FROM liaison_rls',
        d.grantor, d.nspname, extra);
    EXCEPTION WHEN insufficient_privilege THEN
      -- The next registration of that schema narrows its own defaults.
      RAISE NOTICE 'default privileges of % in % left to the next registration', d.grantor, d.nspname;
    END;
  END LOOP;
END $$;
