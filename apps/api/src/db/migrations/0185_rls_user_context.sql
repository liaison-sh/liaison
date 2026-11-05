-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A user context the request login cannot forge, like the org (0184).
--
-- The policies read the transaction's user from `app.current_user_id`, a
-- variable any SQL can set: a statement run from a request transaction could
-- set it to another user and read that user's own rows (preferences,
-- subscriptions, personal agents), or clear it to the nil uuid, which some
-- generated policies treat as a system context. Now:
--
--  1. withRlsContext sets `app.current_user_tag` = HMAC-SHA256(key,
--     'user:' || user id) next to the user (db/rls.ts), under the key of 0184
--     (rls_ctx.tag_key). The 'user:' prefix keeps a user tag apart from an org
--     tag.
--  2. rls_ctx.user_id() is what the policies and functions read instead of the
--     variable. On a login that can reach liaison_admin it returns the variable
--     as is. On any other login it returns the variable only when the tag
--     matches, and otherwise the max uuid: no user's id, and not the nil uuid
--     a system context carries, so a forged or cleared user is nobody rather
--     than the system.
--  3. Every policy and function that read `current_setting('app.current_user_id')`
--     reads rls_ctx.user_id() instead, with the same rule as 0184: functions,
--     and policies that already hold a sub-select, read
--     `(SELECT rls_ctx.user_id())`; the others call it directly, so no policy
--     gains a sublink. modules/permissions/rls-generator.ts emits the direct
--     call.
--
-- Re-runnable.

-- No SET clause (it would make every policy parallel unsafe): each name is
-- schema-qualified instead, operators included.
CREATE OR REPLACE FUNCTION rls_ctx.user_id()
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER AS $fn$
  SELECT CASE
    WHEN pg_catalog.pg_has_role(session_user, 'liaison_admin', 'MEMBER') THEN v.uid
    WHEN v.uid OPERATOR(pg_catalog.<>) ''
     AND pg_catalog.current_setting('app.current_user_tag', true) OPERATOR(pg_catalog.=)
         pg_catalog.encode(pg_catalog.sha256(k.opad OPERATOR(pg_catalog.||)
           pg_catalog.sha256(k.ipad OPERATOR(pg_catalog.||)
             pg_catalog.convert_to('user:' OPERATOR(pg_catalog.||) v.uid, 'UTF8'))), 'hex')
      THEN v.uid
    ELSE 'ffffffff-ffff-ffff-ffff-ffffffffffff'
  END
  FROM (SELECT pg_catalog.current_setting('app.current_user_id', true) AS uid) AS v
  LEFT JOIN rls_ctx.tag_key AS k ON true
$fn$;
--> statement-breakpoint
ALTER FUNCTION rls_ctx.user_id() OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rls_ctx.user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rls_ctx.user_id() TO PUBLIC;
--> statement-breakpoint
-- Policies: the deparsed form is `current_setting('app.current_user_id'::text, true)`.
DO $$
DECLARE
  r record;
  pat constant text := 'current_setting\(''app\.current_user_id''::text(, true)?\)';
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
    repl := CASE WHEN r.has_sublink THEN '(SELECT rls_ctx.user_id())' ELSE 'rls_ctx.user_id()' END;
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
-- Functions: the source form as written. CREATE OR REPLACE keeps owner, grants
-- and SECURITY DEFINER.
DO $$
DECLARE
  r record;
  pat constant text := 'current_setting\(\s*''app\.current_user_id''(::text)?\s*(,\s*true\s*)?\)';
BEGIN
  FOR r IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosrc ~ pat AND n.nspname <> 'rls_ctx' AND p.prokind IN ('f', 'p')
  LOOP
    EXECUTE regexp_replace(pg_get_functiondef(r.oid), pat, '(SELECT rls_ctx.user_id())', 'g');
  END LOOP;
END $$;
