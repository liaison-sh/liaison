-- SPDX-License-Identifier: FSL-1.1-ALv2
-- rls_ctx.enter() checks the five request context variables in one pass.
--
-- 0186's enter() called rls_ctx.verified() once per variable. verified() is a
-- SECURITY DEFINER SQL function, which Postgres neither inlines nor keeps a
-- plan for: each of the five calls parsed and planned its query again, opened
-- rls_ctx.tag_key again and asked pg_has_role again. That planning, not the
-- hashing, was nearly all of enter()'s cost: about 200 us per call, against
-- about 15 us for the same five checks below (measured on PostgreSQL 17), and
-- enter() runs once per request transaction.
--
-- Now enter() asks pg_has_role once, reads the key's pads once (only on a
-- login that is not the privileged one, the only one that needs them), and
-- computes each tag with rls_ctx.tag_of(), an inlinable SQL expression, inside
-- PL/pgSQL statements whose plans the session keeps. The rule for each
-- variable is 0186's, unchanged:
--
--   on a login that can reach liaison_admin: the variable as set;
--   elsewhere: the variable when it is not empty and its tag variable equals
--   HMAC-SHA256(key, prefix || value), hex; the "none" value otherwise
--   (also when the variable is unset or the key is missing);
--
-- and the verified copies go to the same per-session secret slot. The readers
-- and rls_ctx.verified() (their fallback outside an entered transaction) are
-- untouched. Re-runnable.

-- HMAC-SHA256 of `message` with the key's pads, hex: sha256(opad || sha256(ipad || message)).
-- A plain function of its arguments (it holds no key), private to rls_ctx's
-- owner; not SECURITY DEFINER and not STRICT, so the planner inlines it
-- (STABLE, as convert_to is: a function more volatile than declared is not inlined).
CREATE OR REPLACE FUNCTION rls_ctx.tag_of(ipad bytea, opad bytea, message text)
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT pg_catalog.encode(pg_catalog.sha256(opad OPERATOR(pg_catalog.||)
    pg_catalog.sha256(ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(message, 'UTF8'))), 'hex')
$fn$;
--> statement-breakpoint
ALTER FUNCTION rls_ctx.tag_of(bytea, bytea, text) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rls_ctx.tag_of(bytea, bytea, text) FROM PUBLIC;
--> statement-breakpoint
-- expand-safe: same signature, same rule and same stored values; the previous release calls it unchanged.
CREATE OR REPLACE FUNCTION rls_ctx.enter()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $fn$
DECLARE
  slot text;
  admin boolean;
  ip bytea;
  op bytea;
  org text := pg_catalog.current_setting('app.current_org_id', true);
  usr text := pg_catalog.current_setting('app.current_user_id', true);
  scopes text := pg_catalog.current_setting('app.current_scopes', true);
  dims text := pg_catalog.current_setting('app.current_dimensions', true);
  roles text := pg_catalog.current_setting('app.current_roles', true);
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
  admin := pg_catalog.pg_has_role(session_user, 'liaison_admin', 'MEMBER');
  IF NOT admin THEN
    SELECT k.ipad, k.opad INTO ip, op FROM rls_ctx.tag_key AS k;
    -- No key row leaves both pads NULL: no tag matches, every variable reads as none.
    org := CASE WHEN org OPERATOR(pg_catalog.<>) ''
      AND pg_catalog.current_setting('app.current_org_tag', true) OPERATOR(pg_catalog.=) rls_ctx.tag_of(ip, op, org)
      THEN org ELSE '00000000-0000-0000-0000-000000000000' END;
    usr := CASE WHEN usr OPERATOR(pg_catalog.<>) ''
      AND pg_catalog.current_setting('app.current_user_tag', true) OPERATOR(pg_catalog.=)
        rls_ctx.tag_of(ip, op, 'user:' OPERATOR(pg_catalog.||) usr)
      THEN usr ELSE 'ffffffff-ffff-ffff-ffff-ffffffffffff' END;
    scopes := CASE WHEN scopes OPERATOR(pg_catalog.<>) ''
      AND pg_catalog.current_setting('app.current_scopes_tag', true) OPERATOR(pg_catalog.=)
        rls_ctx.tag_of(ip, op, 'scopes:' OPERATOR(pg_catalog.||) scopes)
      THEN scopes ELSE '__none__' END;
    dims := CASE WHEN dims OPERATOR(pg_catalog.<>) ''
      AND pg_catalog.current_setting('app.current_dimensions_tag', true) OPERATOR(pg_catalog.=)
        rls_ctx.tag_of(ip, op, 'dimensions:' OPERATOR(pg_catalog.||) dims)
      THEN dims ELSE '{}' END;
    roles := CASE WHEN roles OPERATOR(pg_catalog.<>) ''
      AND pg_catalog.current_setting('app.current_roles_tag', true) OPERATOR(pg_catalog.=)
        rls_ctx.tag_of(ip, op, 'roles:' OPERATOR(pg_catalog.||) roles)
      THEN roles ELSE '__none__' END;
  END IF;
  PERFORM
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.org', COALESCE(org, ''), true),
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.user', COALESCE(usr, ''), true),
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.scopes', COALESCE(scopes, ''), true),
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.dimensions', COALESCE(dims, ''), true),
    pg_catalog.set_config(slot OPERATOR(pg_catalog.||) '.roles', COALESCE(roles, ''), true),
    pg_catalog.set_config('rls_ctx.entered', pg_catalog.pg_backend_pid()::text, true);
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION rls_ctx.enter() OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rls_ctx.enter() FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE, no dynamic SQL; the grant 0186 gave, restated.
GRANT EXECUTE ON FUNCTION rls_ctx.enter() TO PUBLIC;
