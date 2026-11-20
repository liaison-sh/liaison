-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A scope only its exact grant holds is held that way where row security reads a stamp.
--
-- Some scopes are held only by their exact grant: no `*`, `:*` glob or parent scope covers them.
-- The rows they guard check them with `app_has_exact_scope`, and the app's coverage check
-- (`isExactOnlyScope`, modules/agent/scopes/scope-coverage.ts) refuses them to any grant but
-- their own. A stamp of what a turn read (a message's required scopes, an agent's memory and
-- checkpoints, a secret request's required scopes, an app log line's scope tags, an approval's
-- taint audience) carries such a scope when the turn read such a figure, and the database still
-- let a person holding `*` read the stamped row: a figure its own tool would refuse them.
--
-- 1. kernel.scope_is_exact_only(scope): the SQL twin of `isExactOnlyScope`, the listed scopes
--    plus every bare marker scope (no `:`), `*` excepted. scope-coverage.test.ts keeps its list
--    equal to EXACT_ONLY_SCOPES and to the scopes the migrations check with
--    `app_has_exact_scope`, and 0343_stamp_exact_only_scopes.test.ts compares the two answers.
-- 2. kernel.scopes_covered (messages, 0249/0331): an exact-only entry is covered by its exact
--    grant only. Same signature and attributes; every other entry as before.
-- 3. kernel.scopes_cover_ceiling (agent memory and checkpoints, a routine's ceiling): `*` no
--    longer covers an exact-only entry; an exact match still does.
-- 4. kernel.stamp_scope_held(scope): kernel.has_scope for a stamp entry, an exact-only one by its
--    exact grant. The secret request, app log and approval policies read their stamps through
--    it; the rest of each policy is unchanged (kernel.has_scope stays the generic grant check).
-- Re-runnable.

-- The policy swaps below lock their tables: fail the deploy cleanly behind a long transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.scope_is_exact_only(scope text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT scope OPERATOR(pg_catalog.<>) '*'
     AND (pg_catalog.strpos(scope, ':') OPERATOR(pg_catalog.=) 0
          OR scope OPERATOR(pg_catalog.=) ANY (ARRAY[
            'projects:cost_rates:write',
            'projects:margin:read',
            'projects:timesheet:read'
          ]::text[]))
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: privilege grants on the function above, no dynamic SQL
GRANT EXECUTE ON FUNCTION kernel.scope_is_exact_only(text)
  TO liaison_rls, liaison_app, liaison_admin, liaison_definer;
--> statement-breakpoint
-- expand-safe: covers what 0331's version covers, minus an exact-only entry under a wildcard, glob or parent grant; the previous release reads the same messages or fewer.
CREATE OR REPLACE FUNCTION kernel.scopes_covered(required text[], cover jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
  r text;
  i integer;
  j integer;
  hit boolean;
BEGIN
  IF required IS NULL OR cover IS NULL THEN
    RETURN required IS NOT NULL AND pg_catalog.cardinality(required) OPERATOR(pg_catalog.=) 0;
  END IF;
  FOREACH r IN ARRAY required LOOP
    IF r IS NULL OR r OPERATOR(pg_catalog.=) '' THEN
      RETURN false;
    END IF;
    -- A restricted record's scope: no grant covers it, `*` included.
    IF pg_catalog.left(r, 11) OPERATOR(pg_catalog.=) 'restricted:' THEN
      RETURN false;
    END IF;
    CONTINUE WHEN cover OPERATOR(pg_catalog.?) ('=' OPERATOR(pg_catalog.||) r);
    -- An exact-only scope: its exact grant (just above) is the only one that covers it.
    IF kernel.scope_is_exact_only(r) THEN
      RETURN false;
    END IF;
    CONTINUE WHEN cover OPERATOR(pg_catalog.?) '*';
    hit := false;
    i := 0;
    LOOP
      j := pg_catalog.strpos(pg_catalog.substr(r, i OPERATOR(pg_catalog.+) 1), ':');
      EXIT WHEN j OPERATOR(pg_catalog.=) 0;
      i := i OPERATOR(pg_catalog.+) j;
      IF cover OPERATOR(pg_catalog.?) ('>' OPERATOR(pg_catalog.||) pg_catalog.left(r, i)) THEN
        hit := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT hit THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$fn$;
--> statement-breakpoint
-- expand-safe: covers what 0048's version covers, minus an exact-only entry under the grant `*`; the previous release reads the same rows or fewer.
CREATE OR REPLACE FUNCTION kernel.scopes_cover_ceiling(caller_scopes text[], ceiling jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(coalesce(ceiling, '[]'::jsonb)) AS c(scope)
    WHERE c.scope <> ALL(caller_scopes)
      AND (NOT ('*' = ANY(caller_scopes)) OR kernel.scope_is_exact_only(c.scope))
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.stamp_scope_held(_scope text)
RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN kernel.scope_is_exact_only(_scope)
      THEN COALESCE(_scope <> '' AND _scope = ANY (string_to_array(rls_ctx.scopes(), ',')), false)
    ELSE kernel.has_scope(_scope)
  END
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: privilege grants on the function above, no dynamic SQL
GRANT EXECUTE ON FUNCTION kernel.stamp_scope_held(text)
  TO liaison_rls, liaison_app, liaison_admin, liaison_definer;
--> statement-breakpoint
-- expand-safe: 0241's predicate with each stamp entry read through kernel.stamp_scope_held; the previous release reads the same rows or fewer.
ALTER POLICY secret_requests_select ON kernel.secret_requests
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      requested_by = (SELECT rls_ctx.user_id())::uuid
      OR kernel.is_thread_participant(thread_id, (SELECT rls_ctx.user_id())::uuid)
    )
    AND NOT EXISTS (
      SELECT 1 FROM unnest(required_scopes) AS req(scope)
       WHERE req.scope <> '' AND NOT kernel.stamp_scope_held(req.scope)
    )
  );
--> statement-breakpoint
-- expand-safe: 0277's predicate with each scope tag read through kernel.stamp_scope_held; the previous release reads the same rows or fewer.
ALTER POLICY app_logs_select ON kernel.app_logs
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND NOT EXISTS (
      SELECT 1 FROM unnest(scope_tags) AS t(tag) WHERE NOT kernel.stamp_scope_held(t.tag)
    )
    AND (
      (draft_id IS NULL AND (SELECT kernel.has_scope('kernel:apps:logs')))
      OR (
        draft_id IS NOT NULL
        AND actor_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        AND (
          (SELECT kernel.has_scope('kernel:apps:logs'))
          OR (SELECT kernel.has_scope('kernel:apps:build'))
        )
      )
    )
  );
--> statement-breakpoint
-- expand-safe: 0261's predicate with each taint audience scope read through kernel.stamp_scope_held; the previous release reads the same rows or fewer.
ALTER POLICY approval_requests_select ON kernel.approval_requests
  USING (
((org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND (((resource_owner_id IS NOT NULL) AND ((requested_by = (NULLIF(( SELECT rls_ctx.user_id() AS user_id), ''::text))::uuid) OR (resource_owner_id = (NULLIF(( SELECT rls_ctx.user_id() AS user_id), ''::text))::uuid))) OR ((resource_owner_id IS NULL) AND ((requested_by = (( SELECT rls_ctx.user_id() AS user_id))::uuid) OR (EXISTS ( SELECT 1
   FROM ( VALUES ('kernel:approvals:admin'::text), ('kernel:users:admin'::text)) required(scope)
  WHERE ((EXISTS ( SELECT 1
           FROM kernel.user_scope_grants g
          WHERE ((g.user_id = (( SELECT rls_ctx.user_id() AS user_id))::uuid) AND (g.org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND ((g.scope = '*'::text) OR (g.scope = required.scope) OR ("left"(required.scope, (length(g.scope) + 1)) = (g.scope || ':'::text)) OR (("right"(g.scope, 2) = ':*'::text) AND (strpos("left"(g.scope, (length(g.scope) - 1)), '*'::text) = 0) AND ("left"(required.scope, (length(g.scope) - 1)) = "left"(g.scope, (length(g.scope) - 1)))))))) OR (EXISTS ( SELECT 1
           FROM (kernel.user_roles ur
             JOIN kernel.role_scope_grants rsg ON ((rsg.role_id = ur.role_id)))
          WHERE ((ur.user_id = (( SELECT rls_ctx.user_id() AS user_id))::uuid) AND (ur.org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND ((rsg.scope = '*'::text) OR (rsg.scope = required.scope) OR ("left"(required.scope, (length(rsg.scope) + 1)) = (rsg.scope || ':'::text)) OR (("right"(rsg.scope, 2) = ':*'::text) AND (strpos("left"(rsg.scope, (length(rsg.scope) - 1)), '*'::text) = 0) AND ("left"(required.scope, (length(rsg.scope) - 1)) = "left"(rsg.scope, (length(rsg.scope) - 1))))))))))) OR (((( SELECT rls_ctx.user_id() AS user_id))::uuid = ANY (notify_user_ids)) AND (NOT kernel.app_access_denied(org_id, (( SELECT rls_ctx.user_id() AS user_id))::uuid, split_part(tool_name, ':'::text, 1))) AND (EXISTS ( SELECT 1
   FROM ( SELECT COALESCE(approval_requests.approve_scope, (split_part(approval_requests.tool_name, ':'::text, 1) || ':approve'::text)) AS scope) required
  WHERE (kernel.every_member_scope_covers(approval_requests.org_id, (( SELECT rls_ctx.user_id() AS user_id))::uuid, required.scope) OR (EXISTS ( SELECT 1
           FROM kernel.user_scope_grants g
          WHERE ((g.user_id = (( SELECT rls_ctx.user_id() AS user_id))::uuid) AND (g.org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND ((g.scope = '*'::text) OR (g.scope = required.scope) OR ("left"(required.scope, (length(g.scope) + 1)) = (g.scope || ':'::text)) OR (("right"(g.scope, 2) = ':*'::text) AND (strpos("left"(g.scope, (length(g.scope) - 1)), '*'::text) = 0) AND ("left"(required.scope, (length(g.scope) - 1)) = "left"(g.scope, (length(g.scope) - 1)))))))) OR (EXISTS ( SELECT 1
           FROM (kernel.user_roles ur
             JOIN kernel.role_scope_grants rsg ON ((rsg.role_id = ur.role_id)))
          WHERE ((ur.user_id = (( SELECT rls_ctx.user_id() AS user_id))::uuid) AND (ur.org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND ((rsg.scope = '*'::text) OR (rsg.scope = required.scope) OR ("left"(required.scope, (length(rsg.scope) + 1)) = (rsg.scope || ':'::text)) OR (("right"(rsg.scope, 2) = ':*'::text) AND (strpos("left"(rsg.scope, (length(rsg.scope) - 1)), '*'::text) = 0) AND ("left"(required.scope, (length(rsg.scope) - 1)) = "left"(rsg.scope, (length(rsg.scope) - 1)))))))))))) OR ((tool_name ~~ 'tickets:%'::text) AND app_tickets.app_has_scope('tickets:tickets:read'::text) AND (NOT (EXISTS ( SELECT 1
   FROM jsonb_array_elements_text(
        CASE
            WHEN (jsonb_typeof((approval_requests.metadata -> 'taintAudienceMustHold'::text)) = 'array'::text) THEN (approval_requests.metadata -> 'taintAudienceMustHold'::text)
            ELSE '[]'::jsonb
        END) must(scope)
  WHERE (NOT kernel.stamp_scope_held(must.scope)))))) OR ((tool_name ~~ 'mail:%'::text) AND app_tickets.app_has_scope('mail:conversations:read'::text) AND (NOT (EXISTS ( SELECT 1
   FROM jsonb_array_elements_text(
        CASE
            WHEN (jsonb_typeof((approval_requests.metadata -> 'taintAudienceMustHold'::text)) = 'array'::text) THEN (approval_requests.metadata -> 'taintAudienceMustHold'::text)
            ELSE '[]'::jsonb
        END) must(scope)
  WHERE (NOT kernel.stamp_scope_held(must.scope))))))))))
  );
