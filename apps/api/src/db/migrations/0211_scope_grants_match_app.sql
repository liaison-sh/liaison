-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A scope grant matches in the database exactly as in the app.
--
-- The app's check (modules/permissions/permissions.ts hasScope) and the
-- database's (`app_<app>.app_has_scope`, `kernel.has_scope`) disagreed on
-- wildcards: a grant `a:b:*` held `a:b:c` in the app and nothing in the
-- database, and `a:*` held the bare `a` in the database but not in the app.
-- Each check now reads every grant, split on ':', as hasScope does:
--  - `*` holds every scope;
--  - otherwise a grant holds a scope that has at least as many segments and
--    repeats the grant's segments one for one, where a LAST segment `*`
--    stands for any one segment: `a:b` holds `a:b` and `a:b:c`; `a:b:*`
--    holds `a:b:c` and `a:b:c:d` but not `a:b`; `a:*` holds `a:x` but not `a`;
--  - a `*` before the last segment (`a:*:c`) holds nothing;
--  - an empty scope is held by nothing, and an empty grant holds nothing
--    (hasScope would match a scope starting with ':', which no scope does).
-- The answer stays false, never NULL (0210).
--
-- 0210's header said CREATE OR REPLACE keeps "each function's owner, grants
-- and attributes". It keeps the owner and the grants only: the attributes
-- (language, volatility, SECURITY DEFINER, search_path) are the ones the
-- statement states, so each statement here, as in 0210, restates them as the
-- function had them. The app-specific checks (kernel.session_is_admin,
-- app_knowledge.has_exact_scope) are not generic grants and stay as 0210 left
-- them. Re-runnable.

CREATE OR REPLACE FUNCTION app_tickets.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    _scope <> '' AND EXISTS (
      SELECT 1
      FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g,
           LATERAL (SELECT string_to_array(g, ':') AS gp, string_to_array(_scope, ':') AS rp) AS p
      WHERE g = '*'
         OR (
           g <> ''
           AND cardinality(p.gp) <= cardinality(p.rp)
           AND NOT ('*' = ANY (p.gp[1:cardinality(p.gp) - 1]))
           AND NOT EXISTS (
             SELECT 1 FROM generate_subscripts(p.gp, 1) AS i
             WHERE p.gp[i] <> '*' AND p.gp[i] IS DISTINCT FROM p.rp[i]
           )
         )
    ),
    false
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_projects.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    _scope <> '' AND EXISTS (
      SELECT 1
      FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g,
           LATERAL (SELECT string_to_array(g, ':') AS gp, string_to_array(_scope, ':') AS rp) AS p
      WHERE g = '*'
         OR (
           g <> ''
           AND cardinality(p.gp) <= cardinality(p.rp)
           AND NOT ('*' = ANY (p.gp[1:cardinality(p.gp) - 1]))
           AND NOT EXISTS (
             SELECT 1 FROM generate_subscripts(p.gp, 1) AS i
             WHERE p.gp[i] <> '*' AND p.gp[i] IS DISTINCT FROM p.rp[i]
           )
         )
    ),
    false
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_mcp_manager.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    _scope <> '' AND EXISTS (
      SELECT 1
      FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g,
           LATERAL (SELECT string_to_array(g, ':') AS gp, string_to_array(_scope, ':') AS rp) AS p
      WHERE g = '*'
         OR (
           g <> ''
           AND cardinality(p.gp) <= cardinality(p.rp)
           AND NOT ('*' = ANY (p.gp[1:cardinality(p.gp) - 1]))
           AND NOT EXISTS (
             SELECT 1 FROM generate_subscripts(p.gp, 1) AS i
             WHERE p.gp[i] <> '*' AND p.gp[i] IS DISTINCT FROM p.rp[i]
           )
         )
    ),
    false
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    _scope <> '' AND EXISTS (
      SELECT 1
      FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g,
           LATERAL (SELECT string_to_array(g, ':') AS gp, string_to_array(_scope, ':') AS rp) AS p
      WHERE g = '*'
         OR (
           g <> ''
           AND cardinality(p.gp) <= cardinality(p.rp)
           AND NOT ('*' = ANY (p.gp[1:cardinality(p.gp) - 1]))
           AND NOT EXISTS (
             SELECT 1 FROM generate_subscripts(p.gp, 1) AS i
             WHERE p.gp[i] <> '*' AND p.gp[i] IS DISTINCT FROM p.rp[i]
           )
         )
    ),
    false
  )
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_knowledge.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
BEGIN
  RETURN COALESCE(
    _scope <> '' AND EXISTS (
      SELECT 1
      FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g,
           LATERAL (SELECT string_to_array(g, ':') AS gp, string_to_array(_scope, ':') AS rp) AS p
      WHERE g = '*'
         OR (
           g <> ''
           AND cardinality(p.gp) <= cardinality(p.rp)
           AND NOT ('*' = ANY (p.gp[1:cardinality(p.gp) - 1]))
           AND NOT EXISTS (
             SELECT 1 FROM generate_subscripts(p.gp, 1) AS i
             WHERE p.gp[i] <> '*' AND p.gp[i] IS DISTINCT FROM p.rp[i]
           )
         )
    ),
    false
  );
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
