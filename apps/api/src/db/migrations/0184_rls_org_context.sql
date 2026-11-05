-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An org context the request login cannot forge.
--
-- The policies read the transaction's org from `app.current_org_id`, a
-- variable any SQL can set: a statement run from a request transaction could
-- `set_config('app.current_org_id', <another org>, true)` and read that org's
-- rows. Now:
--
--  1. rls_ctx.tag_key holds a random per-database key. Only the privileged
--     login (liaison_app) and liaison_definer can read it; the request login
--     (liaison_request, through liaison_rls) cannot.
--  2. withRlsContext sets `app.current_org_tag` = HMAC-SHA256(key, org id)
--     next to the org (db/rls.ts). SQL inside the transaction cannot compute
--     the tag of another org.
--  3. rls_ctx.org_id() is what the policies and functions read instead of the
--     variable. On a login that can reach liaison_admin (the privileged login,
--     migrations, superusers) it returns the variable as is: that login can
--     bypass row-level security anyway. On any other login it returns the
--     variable only when the tag matches, and the nil uuid otherwise, also
--     when the org was cleared, so a function that falls back to an org
--     argument "in a transaction without one" refuses there.
--  4. Every policy and function that read `current_setting('app.current_org_id')`
--     reads rls_ctx.org_id() instead. Functions, and policies that already
--     hold a sub-select, read `(SELECT rls_ctx.org_id())`: an InitPlan,
--     computed once per statement, not per row. Policies without one call
--     `rls_ctx.org_id()` directly (once per scan where it is an index
--     condition): a sub-select would give them a sublink, and Postgres refuses
--     a policy that reaches its own table through policies with sublinks
--     (infinite recursion), so each policy keeps the sublinks it had. Apps
--     register their policies through modules/permissions/rls-generator.ts,
--     which emits the direct call.
--
-- rls_ctx is its own schema: the test schema cloner copies kernel and app_*,
-- and every clone must share the one key and reader. Re-runnable.

CREATE SCHEMA IF NOT EXISTS rls_ctx;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rls_ctx.tag_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  key bytea NOT NULL,
  -- The key padded to the SHA-256 block (64 bytes) XOR 0x36 and XOR 0x5c:
  -- HMAC = sha256(opad || sha256(ipad || message)).
  ipad bytea NOT NULL,
  opad bytea NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE
  k bytea;
  padded bytea;
  ip bytea;
  op bytea;
BEGIN
  IF EXISTS (SELECT 1 FROM rls_ctx.tag_key) THEN
    RETURN;
  END IF;
  -- 32 bytes from the server's strong random source (two v4 uuids).
  k := decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex');
  padded := k || decode(repeat('00', 64 - length(k)), 'hex');
  ip := padded;
  op := padded;
  FOR i IN 0..63 LOOP
    ip := set_byte(ip, i, get_byte(padded, i) # 54);
    op := set_byte(op, i, get_byte(padded, i) # 92);
  END LOOP;
  INSERT INTO rls_ctx.tag_key (key, ipad, opad) VALUES (k, ip, op);
END $$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA rls_ctx FROM PUBLIC;
--> statement-breakpoint
-- Any role evaluating a policy calls the reader; the key stays unreadable.
GRANT USAGE ON SCHEMA rls_ctx TO PUBLIC;
--> statement-breakpoint
REVOKE ALL ON rls_ctx.tag_key FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON rls_ctx.tag_key TO liaison_definer, liaison_app, liaison_admin;
--> statement-breakpoint
-- A migration login that is not a superuser hands the reader to liaison_definer,
-- which then needs CREATE on its schema. No login reaches liaison_definer.
GRANT CREATE ON SCHEMA rls_ctx TO liaison_definer;
--> statement-breakpoint
-- No SET clause (it would make every policy parallel unsafe): each name is
-- schema-qualified instead, operators included, so a caller's search_path
-- resolves nothing in here.
CREATE OR REPLACE FUNCTION rls_ctx.org_id()
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER AS $fn$
  SELECT CASE
    WHEN pg_catalog.pg_has_role(session_user, 'liaison_admin', 'MEMBER') THEN v.org
    WHEN v.org OPERATOR(pg_catalog.<>) ''
     AND pg_catalog.current_setting('app.current_org_tag', true) OPERATOR(pg_catalog.=)
         pg_catalog.encode(pg_catalog.sha256(k.opad OPERATOR(pg_catalog.||)
           pg_catalog.sha256(k.ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(v.org, 'UTF8'))), 'hex')
      THEN v.org
    ELSE '00000000-0000-0000-0000-000000000000'
  END
  FROM (SELECT pg_catalog.current_setting('app.current_org_id', true) AS org) AS v
  LEFT JOIN rls_ctx.tag_key AS k ON true
$fn$;
--> statement-breakpoint
ALTER FUNCTION rls_ctx.org_id() OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rls_ctx.org_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rls_ctx.org_id() TO PUBLIC;
--> statement-breakpoint
-- Policies: the deparsed form is `current_setting('app.current_org_id'::text, true)`.
DO $$
DECLARE
  r record;
  pat constant text := 'current_setting\(''app\.current_org_id''::text(, true)?\)';
  repl text;
  stmt text;
BEGIN
  FOR r IN
    SELECT p.polname, p.polrelid::regclass AS rel,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS chk,
           coalesce(p.polqual::text, '') || coalesce(p.polwithcheck::text, '') LIKE '%{SUBLINK %' AS has_sublink
      FROM pg_policy p
     WHERE coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ pat
        OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ pat
  LOOP
    repl := CASE WHEN r.has_sublink THEN '(SELECT rls_ctx.org_id())' ELSE 'rls_ctx.org_id()' END;
    stmt := format('ALTER POLICY %I ON %s', r.polname, r.rel);
    IF r.qual IS NOT NULL THEN
      stmt := stmt || format(' USING (%s)', regexp_replace(r.qual, pat, repl, 'g'));
    END IF;
    IF r.chk IS NOT NULL THEN
      stmt := stmt || format(' WITH CHECK (%s)', regexp_replace(r.chk, pat, repl, 'g'));
    END IF;
    EXECUTE stmt;
  END LOOP;
END $$;
--> statement-breakpoint
-- Functions (policy helpers, triggers, the SECURITY DEFINER functions of 0178):
-- the source form as written. CREATE OR REPLACE keeps owner, grants and
-- SECURITY DEFINER.
DO $$
DECLARE
  r record;
  pat constant text := 'current_setting\(\s*''app\.current_org_id''(::text)?\s*(,\s*true\s*)?\)';
BEGIN
  FOR r IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosrc ~ pat AND n.nspname <> 'rls_ctx' AND p.prokind IN ('f', 'p')
  LOOP
    EXECUTE regexp_replace(pg_get_functiondef(r.oid), pat, '(SELECT rls_ctx.org_id())', 'g');
  END LOOP;
END $$;
