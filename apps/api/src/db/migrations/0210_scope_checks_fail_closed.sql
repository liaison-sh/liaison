-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Scope checks fail closed whatever the pooled connection held.
--
-- `app.current_scopes` is a custom setting. A transaction that never set it
-- reads NULL on a connection where no transaction ever did, and '' on one where
-- an earlier RLS transaction set it (reverted at its commit). The scope checks
-- answered NULL for NULL (`NULL = '*' OR EXISTS (… unnest(NULL) …)`), and
-- `IF NOT NULL` does not raise: app_projects.allocate_task_number let a
-- privileged transaction through on a fresh connection and refused it on a
-- reused one (an import that failed every task only on some connections).
--
-- Now:
--  1. every scope check returns false, never NULL (COALESCE): no scope in the
--     context is no scope, whether the setting is NULL or '';
--  2. allocate_task_number refuses unless the check is true;
--  3. the personal-agent guard trigger lets the privileged ROLE through
--     (current_user can act as liaison_admin) instead of an empty scope context,
--     which a reused connection could not tell apart from a request's.
-- The privileged transactions set their context explicitly (db/privileged.ts,
-- setPrivilegedContext): the actor's scopes when they write for someone, '' (so
-- refused here) otherwise.
--
-- The per-app copies live here only (tickets, projects, knowledge, mcp_manager
-- and the kernel's): an installed app's policies inline their own predicate
-- (modules/permissions/rls-generator.ts), where NULL already denies. CREATE OR
-- REPLACE keeps each function's owner, grants and attributes. Re-runnable.

CREATE OR REPLACE FUNCTION app_tickets.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    rls_ctx.scopes() = '*'
    OR EXISTS (
      SELECT 1
      FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g
      WHERE g = '*'
        OR g = _scope
        OR g = split_part(_scope, ':', 1) || ':*'
        OR g = split_part(_scope, ':', 1)
        OR starts_with(_scope, g || ':')
    ),
    false
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_projects.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    rls_ctx.scopes() = '*'
    OR EXISTS (
      SELECT 1
      FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g
      WHERE g = '*'
        OR g = _scope
        OR g = split_part(_scope, ':', 1) || ':*'
        OR g = split_part(_scope, ':', 1)
        OR starts_with(_scope, g || ':')
    ),
    false
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_mcp_manager.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    rls_ctx.scopes() = '*'
    OR EXISTS (
      SELECT 1
      FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g
      WHERE g = '*'
        OR g = _scope
        OR g = split_part(_scope, ':', 1) || ':*'
        OR g = split_part(_scope, ':', 1)
        OR starts_with(_scope, g || ':')
    ),
    false
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_knowledge.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
BEGIN
  RETURN COALESCE(
    rls_ctx.scopes() = '*'
    OR EXISTS (
      SELECT 1 FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g
      WHERE g = '*'
        OR g = _scope
        OR g = 'knowledge:*'
        OR g = 'knowledge'
        OR starts_with(_scope, g || ':')
    ),
    false
  );
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_knowledge.has_exact_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
BEGIN
  RETURN COALESCE(_scope = ANY(string_to_array(rls_ctx.scopes(), ',')), false);
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    rls_ctx.scopes() = '*'
      OR EXISTS (
        SELECT 1
          FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g
         WHERE g = '*' OR g = _scope OR starts_with(_scope, g || ':')
            OR g = split_part(_scope, ':', 1) || ':*'
      ),
    false
  )
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.session_is_admin() RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    rls_ctx.scopes() = '*'
      OR EXISTS (
        SELECT 1
        FROM unnest(string_to_array(rls_ctx.scopes(), ',')) AS g
        WHERE g IN ('*', 'kernel', 'kernel:*', 'kernel:users:admin')
      ),
    false
  )
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_projects.allocate_task_number(_project_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_projects, pg_catalog
AS $FUNCTION_BODY$
DECLARE
  n integer;
  org uuid;
BEGIN
  IF NOT COALESCE(app_projects.app_has_scope('projects:tasks:write'), false) THEN
    RAISE EXCEPTION 'insufficient_scope: projects:tasks:write required';
  END IF;
  org := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  IF org IS NULL THEN
    RAISE EXCEPTION 'no org context';
  END IF;
  UPDATE app_projects.projects
     SET next_task_number = next_task_number + 1
   WHERE id = _project_id AND org_id = org
  RETURNING next_task_number - 1 INTO n;
  RETURN n;
END
$FUNCTION_BODY$;
--> statement-breakpoint
-- A personal agent's owner may rename it, never widen it. The privileged role
-- (and a login that can become it: migrations, the operator) may change any
-- field; a request transaction runs as liaison_rls and needs an admin scope.
CREATE OR REPLACE FUNCTION kernel.agents_personal_owner_rename_only() RETURNS trigger AS $FUNCTION_BODY$
DECLARE
  acting_scopes text[];
BEGIN
  IF NEW.kind != 'personal' THEN
    RETURN NEW;
  END IF;

  IF pg_catalog.pg_has_role(current_user, 'liaison_admin', 'MEMBER') THEN
    RETURN NEW;
  END IF;

  acting_scopes := COALESCE(string_to_array(rls_ctx.scopes(), ','), ARRAY[]::text[]);
  IF '*' = ANY(acting_scopes) OR 'kernel:agents:admin' = ANY(acting_scopes) THEN
    RETURN NEW;
  END IF;

  IF NEW.scope_ceiling IS DISTINCT FROM OLD.scope_ceiling
    OR NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
    OR NEW.tool_allowlist IS DISTINCT FROM OLD.tool_allowlist
    OR NEW.tool_denylist IS DISTINCT FROM OLD.tool_denylist
  THEN
    RAISE EXCEPTION 'agents_personal_owner_rename_only';
  END IF;

  RETURN NEW;
END;
$FUNCTION_BODY$ LANGUAGE plpgsql;
