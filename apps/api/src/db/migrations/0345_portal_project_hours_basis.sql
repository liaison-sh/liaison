-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Why a shared project shows no hours on the portal.
--
-- `portal.project_hours` answers no row both when the hours share is closed and when the project
-- bills by milestone (a fixed project has no billed hours). The portal says the second in words:
-- "This project bills by milestone, so it has no billed hours". This function answers
-- 'by_milestone' for exactly that case, behind the same predicate as `portal.project_hours`
-- (the caller's own open company, a live work project using time and budgets, an open hours
-- share on it), and nothing otherwise: a closed share answers nothing, as before. It reads the
-- billing basis only, never a row, a person, a task or real time. Re-runnable.

CREATE OR REPLACE FUNCTION portal.project_hours_basis(p_project uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_basis text;
BEGIN
  IF v_org IS NULL OR p_project IS NULL THEN RETURN NULL; END IF;
  SELECT tp.basis INTO v_basis
    FROM app_projects.projects p
    JOIN app_projects.project_time_plan tp ON tp.project_id = p.id AND tp.org_id = p.org_id
   WHERE p.id = p_project
     AND p.org_id = v_org
     AND p.company_id = (SELECT portal.company_id())
     AND p.kind = 'work'
     AND p.archived_at IS NULL
     AND p.time_budgets_on
     AND EXISTS (
       SELECT 1 FROM portal.shares s WHERE s.kind = 'project_hours' AND s.object_id = p.id
     );
  IF v_basis = 'fixed' THEN RETURN 'by_milestone'; END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION portal.project_hours_basis(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION portal.project_hours_basis(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.project_hours_basis(uuid) TO liaison_portal;
