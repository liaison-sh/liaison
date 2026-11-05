-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The request context is verified once per transaction, not once per row, and
-- the scopes, dimension grants and roles are bound to the server like the org
-- (0184) and the user (0185).
--
-- 0184/0185 verify `app.current_org_id` / `app.current_user_id` against their
-- HMAC tag on every call of rls_ctx.org_id() / rls_ctx.user_id(). A policy
-- helper evaluated per row (app_tickets.can_read_ticket on every message row)
-- calls them per row, and each call costs two SHA-256 and a role check, so
-- large reads slowed down by several times. Now:
--
--  1. withRlsContext sets a tag for each of the five variables (db/rls.ts):
--     HMAC-SHA256 of '<prefix><value>' under the 0184 key, with the prefixes
--     '' (org), 'user:', 'scopes:', 'dimensions:' and 'roles:'. It then calls
--     rls_ctx.enter(), once per transaction.
--  2. rls_ctx.enter() verifies each variable against its tag, exactly as the
--     0184/0185 readers do (rls_ctx.verified), and copies the verified values
--     into transaction-local settings whose names carry a per-session secret:
--     `rls_ctx_<a>_<b>.<variable>`, where a and b are drawn from the server's
--     strong random source the first time the session enters and kept in two
--     sequences only liaison_definer can read (currval). The request login
--     cannot read those sequences, and Postgres does not list settings it
--     does not know (pg_settings, SHOW ALL), so SQL run inside the
--     transaction cannot name, and so cannot overwrite, the verified copies.
--     Setting `app.current_*` itself changes nothing the policies read.
--  3. The readers (rls_ctx.org_id, user_id, scopes, dimensions, roles) return
--     the verified copy when the transaction entered in this backend: one
--     settings lookup and two currval calls, no hashing. Elsewhere (the
--     privileged login, a transaction that never entered, a parallel worker,
--     which has no currval) they fall back to the per-call verification of
--     0184/0185, so a worker or a context-less transaction is exactly as
--     strict as before.
--  4. Every policy and function that read `current_setting('app.current_scopes')`,
--     `app.current_dimensions` or `app.current_roles` reads the reader instead
--     On the request login a forged value reads as none: no scope
--     ('__none__'), no dimension grant ('{}'), no role ('__none__').
--  5. Every policy that holds a sublink calls the readers in a sub-select
--     (an InitPlan, once per statement), and the ticket message policy checks
--     its ticket through a sublink instead of a per-row function call, and
--     app_tickets.can_read_ticket asks the tickets policy instead of
--     restating it (all below).
--
-- Re-runnable.

CREATE SEQUENCE IF NOT EXISTS rls_ctx.slot_a MINVALUE 1 MAXVALUE 1152921504606846976 NO CYCLE;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS rls_ctx.slot_b MINVALUE 1 MAXVALUE 1152921504606846976 NO CYCLE;
--> statement-breakpoint
ALTER SEQUENCE rls_ctx.slot_a OWNER TO liaison_definer;
--> statement-breakpoint
ALTER SEQUENCE rls_ctx.slot_b OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE rls_ctx.slot_a, rls_ctx.slot_b FROM PUBLIC;
--> statement-breakpoint
-- The 0184/0185 check, for any variable: on a login that can reach
-- liaison_admin the variable as is; elsewhere the variable when its tag
-- matches, and `otherwise` when it does not. Private to the readers.
CREATE OR REPLACE FUNCTION rls_ctx.verified(var text, tag_var text, prefix text, otherwise text)
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER AS $fn$
  SELECT CASE
    WHEN pg_catalog.pg_has_role(session_user, 'liaison_admin', 'MEMBER') THEN v.val
    WHEN v.val OPERATOR(pg_catalog.<>) ''
     AND pg_catalog.current_setting(tag_var, true) OPERATOR(pg_catalog.=)
         pg_catalog.encode(pg_catalog.sha256(k.opad OPERATOR(pg_catalog.||)
           pg_catalog.sha256(k.ipad OPERATOR(pg_catalog.||)
             pg_catalog.convert_to(prefix OPERATOR(pg_catalog.||) v.val, 'UTF8'))), 'hex')
      THEN v.val
    ELSE otherwise
  END
  FROM (SELECT pg_catalog.current_setting(var, true) AS val) AS v
  LEFT JOIN rls_ctx.tag_key AS k ON true
$fn$;
--> statement-breakpoint
ALTER FUNCTION rls_ctx.verified(text, text, text, text) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rls_ctx.verified(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
-- Called by withRlsContext once per transaction, after it set the variables.
-- Any login may call it: it stores only what verifies, so calling it again
-- after forging a variable stores the "none" value for that variable.
CREATE OR REPLACE FUNCTION rls_ctx.enter()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $fn$
DECLARE
  slot text;
BEGIN
  BEGIN
    slot := 'rls_ctx_' OPERATOR(pg_catalog.||) pg_catalog.currval('rls_ctx.slot_a'::pg_catalog.regclass)::text
      OPERATOR(pg_catalog.||) '_' OPERATOR(pg_catalog.||) pg_catalog.currval('rls_ctx.slot_b'::pg_catalog.regclass)::text;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    -- First entry of this session: 60 bits per sequence from gen_random_uuid
    -- (the server's strong random source; random() can be seeded by SQL).
    slot := 'rls_ctx_' OPERATOR(pg_catalog.||) pg_catalog.setval('rls_ctx.slot_a'::pg_catalog.regclass,
        ('x' OPERATOR(pg_catalog.||) pg_catalog.substr(pg_catalog.md5(pg_catalog.gen_random_uuid()::text
          OPERATOR(pg_catalog.||) pg_catalog.gen_random_uuid()::text), 1, 15))::bit(60)::bigint OPERATOR(pg_catalog.+) 1)::text
      OPERATOR(pg_catalog.||) '_' OPERATOR(pg_catalog.||) pg_catalog.setval('rls_ctx.slot_b'::pg_catalog.regclass,
        ('x' OPERATOR(pg_catalog.||) pg_catalog.substr(pg_catalog.md5(pg_catalog.gen_random_uuid()::text
          OPERATOR(pg_catalog.||) pg_catalog.gen_random_uuid()::text), 1, 15))::bit(60)::bigint OPERATOR(pg_catalog.+) 1)::text;
  END;
  PERFORM
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.org', COALESCE(rls_ctx.verified(
      'app.current_org_id', 'app.current_org_tag', '', '00000000-0000-0000-0000-000000000000'), ''), true),
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.user', COALESCE(rls_ctx.verified(
      'app.current_user_id', 'app.current_user_tag', 'user:', 'ffffffff-ffff-ffff-ffff-ffffffffffff'), ''), true),
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.scopes', COALESCE(rls_ctx.verified(
      'app.current_scopes', 'app.current_scopes_tag', 'scopes:', '__none__'), ''), true),
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.dimensions', COALESCE(rls_ctx.verified(
      'app.current_dimensions', 'app.current_dimensions_tag', 'dimensions:', '{}'), ''), true),
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.roles', COALESCE(rls_ctx.verified(
      'app.current_roles', 'app.current_roles_tag', 'roles:', '__none__'), ''), true),
    pg_catalog.set_config('rls_ctx.entered', pg_catalog.pg_backend_pid()::text, true);
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION rls_ctx.enter() OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rls_ctx.enter() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rls_ctx.enter() TO PUBLIC;
--> statement-breakpoint
-- The readers. `rls_ctx.entered` is a hint the request login can set: set
-- wrongly it sends the reader to the per-call check (or to a currval that the
-- session never defined, an error), never to a value that did not verify.
-- No SET clause (it would make every policy parallel unsafe): each name is
-- schema-qualified instead, operators included.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('org_id', 'org', 'app.current_org_id', 'app.current_org_tag', '', '00000000-0000-0000-0000-000000000000'),
      ('user_id', 'user', 'app.current_user_id', 'app.current_user_tag', 'user:', 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
      ('scopes', 'scopes', 'app.current_scopes', 'app.current_scopes_tag', 'scopes:', '__none__'),
      ('dimensions', 'dimensions', 'app.current_dimensions', 'app.current_dimensions_tag', 'dimensions:', '{}'),
      ('roles', 'roles', 'app.current_roles', 'app.current_roles_tag', 'roles:', '__none__')
    ) AS t(fn, field, var, tag_var, prefix, otherwise)
  LOOP
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION rls_ctx.%1$I()
      RETURNS text
      LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER AS $body$
      BEGIN
        IF pg_catalog.current_setting('rls_ctx.entered', true) OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()::text THEN
          RETURN COALESCE(pg_catalog.current_setting(
            'rls_ctx_' OPERATOR(pg_catalog.||) pg_catalog.currval('rls_ctx.slot_a'::pg_catalog.regclass)::text
              OPERATOR(pg_catalog.||) '_' OPERATOR(pg_catalog.||) pg_catalog.currval('rls_ctx.slot_b'::pg_catalog.regclass)::text
              OPERATOR(pg_catalog.||) %2$L, true), %6$L);
        END IF;
        RETURN rls_ctx.verified(%3$L, %4$L, %5$L, %6$L);
      END
      $body$
    $f$, r.fn, '.' || r.field, r.var, r.tag_var, r.prefix, r.otherwise);
    EXECUTE format('ALTER FUNCTION rls_ctx.%I() OWNER TO liaison_definer', r.fn);
    EXECUTE format('REVOKE ALL ON FUNCTION rls_ctx.%I() FROM PUBLIC', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION rls_ctx.%I() TO PUBLIC', r.fn);
  END LOOP;
END $$;
--> statement-breakpoint
-- Policies: the deparsed form is `current_setting('app.current_scopes'::text, true)`.
DO $$
DECLARE
  r record;
  v record;
  qual text;
  chk text;
  stmt text;
BEGIN
  FOR r IN
    SELECT p.polname, p.polrelid::regclass AS rel,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS chk
      FROM pg_policy p
     WHERE coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           ~ 'current_setting\(''app\.current_(scopes|dimensions|roles)''::text(, true)?\)'
  LOOP
    qual := r.qual;
    chk := r.chk;
    FOR v IN SELECT * FROM (VALUES ('scopes'), ('dimensions'), ('roles')) AS t(name) LOOP
      qual := regexp_replace(qual, format('current_setting\(''app\.current_%s''::text(, true)?\)', v.name), format('rls_ctx.%s()', v.name), 'g');
      chk := regexp_replace(chk, format('current_setting\(''app\.current_%s''::text(, true)?\)', v.name), format('rls_ctx.%s()', v.name), 'g');
    END LOOP;
    stmt := format('ALTER POLICY %I ON %s', r.polname, r.rel);
    IF qual IS NOT NULL THEN
      stmt := stmt || format(' USING (%s)', qual);
    END IF;
    IF chk IS NOT NULL THEN
      stmt := stmt || format(' WITH CHECK (%s)', chk);
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
  v record;
  def text;
BEGIN
  FOR r IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosrc ~ 'current_setting\(\s*''app\.current_(scopes|dimensions|roles)'''
       AND n.nspname <> 'rls_ctx' AND p.prokind IN ('f', 'p')
  LOOP
    def := pg_get_functiondef(r.oid);
    FOR v IN SELECT * FROM (VALUES ('scopes'), ('dimensions'), ('roles')) AS t(name) LOOP
      def := regexp_replace(def, format('current_setting\(\s*''app\.current_%s''(::text)?\s*(,\s*true\s*)?\)', v.name), format('rls_ctx.%s()', v.name), 'g');
    END LOOP;
    EXECUTE def;
  END LOOP;
END $$;
--> statement-breakpoint
-- Every policy that already holds a sublink reads the readers in a sub-select:
-- an InitPlan, computed once per statement instead of once per row (a plain
-- call is evaluated per row wherever it is not an index condition). A policy
-- without a sublink keeps the plain call (a cheap settings lookup per row
-- now): giving it a sublink would make Postgres check it for recursion, and a
-- table whose write policies read the same table (kernel.thread_participants)
-- would then fail with "infinite recursion detected". 0184 drew the same line.
-- modules/permissions/rls-generator.ts applies the same rule to app policies.
DO $$
DECLARE
  r record;
  pat constant text := '(?<!SELECT )(?<!SELECT \()rls_ctx\.(org_id|user_id|scopes|dimensions|roles)\(\)';
  stmt text;
BEGIN
  FOR r IN
    SELECT p.polname, p.polrelid::regclass AS rel,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS chk
      FROM pg_policy p
     WHERE (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ pat
            OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ pat)
       AND coalesce(p.polqual::text, '') || coalesce(p.polwithcheck::text, '') LIKE '%{SUBLINK %'
  LOOP
    stmt := format('ALTER POLICY %I ON %s', r.polname, r.rel);
    IF r.qual IS NOT NULL THEN
      stmt := stmt || format(' USING (%s)', regexp_replace(r.qual, pat, '(SELECT rls_ctx.\1())', 'g'));
    END IF;
    IF r.chk IS NOT NULL THEN
      stmt := stmt || format(' WITH CHECK (%s)', regexp_replace(r.chk, pat, '(SELECT rls_ctx.\1())', 'g'));
    END IF;
    EXECUTE stmt;
  END LOOP;
END $$;
--> statement-breakpoint
-- A ticket message is visible when its ticket is: the tickets policy decides,
-- through a sublink whose InitPlans run once per statement. The policy called
-- app_tickets.can_read_ticket per message row, which re-ran the ticket check,
-- tickets policy included, for every row (0171 keeps that function equal to the
-- tickets policy; it still gates ticket_reads).
DO $$
BEGIN
  IF to_regclass('app_tickets.messages') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'app_tickets.messages'::regclass AND polname = 'messages_select') THEN
    ALTER POLICY messages_select ON app_tickets.messages
      USING (EXISTS (SELECT 1 FROM app_tickets.tickets t WHERE t.id = messages.ticket_id));
  END IF;
END $$;
--> statement-breakpoint
-- app_tickets.can_read_ticket (still the ticket_reads policies' gate) asks the
-- tickets policy instead of restating it. 0171 made its body equal to that
-- policy, and as an invoker function it already ran under it, so the result is
-- the same; each call no longer evaluates the predicate twice.
DO $$
BEGIN
  IF to_regclass('app_tickets.tickets') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION app_tickets.can_read_ticket(_ticket_id uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (SELECT 1 FROM app_tickets.tickets t WHERE t.id = _ticket_id)
    $fn$;
  END IF;
END $$;
