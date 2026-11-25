-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The Friday client report: a status report on a project that a person approves
-- before it goes to the client, by mail and on the client portal.
--
--   app_projects.client_reports   one report per project and period end. A draft
--                                 holds its sections, what was left out and the
--                                 sources it was written from; once a person sends
--                                 it, sections_sent holds exactly what went out and
--                                 never changes again (trigger). RLS: the org, and
--                                 projects:reports:read to read, projects:reports:write
--                                 to write. Nothing deletes a report.
--   portal.client_reports         what a client reads of the sent reports of their
--                                 company's projects, behind an open reports share:
--                                 the sent sections, the period, who sent it. Never
--                                 the draft, its sources or what was left out.
--
-- The company is stamped on the report when it is drafted (the project's client
-- company), never followed afterwards; a company merge re-points it.
CREATE TABLE app_projects.client_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES app_projects.projects(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sent', 'rejected', 'expired')),
  sections jsonb NOT NULL,
  sections_sent jsonb,
  left_out jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_contact_id uuid,
  approved_by_user_id uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  mail_message_id text,
  edited boolean NOT NULL DEFAULT false,
  routine_id uuid,
  thread_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_reports_sent_has_body CHECK (status <> 'sent' OR sections_sent IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX client_reports_project_period_uidx
  ON app_projects.client_reports (project_id, period_end);
--> statement-breakpoint
CREATE INDEX client_reports_org_status_idx ON app_projects.client_reports (org_id, status);
--> statement-breakpoint
CREATE INDEX client_reports_company_idx ON app_projects.client_reports (org_id, company_id);
--> statement-breakpoint
-- What was sent is written once: a set sections_sent never changes, and a sent report's
-- body, recipient and sender stay as they went out.
CREATE FUNCTION app_projects.client_reports_sent_once_fn() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF OLD.sections_sent IS NOT NULL AND NEW.sections_sent IS DISTINCT FROM OLD.sections_sent THEN
    RAISE EXCEPTION 'immutable_row: client_reports.sections_sent is written once' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'sent' AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.sections IS DISTINCT FROM OLD.sections
       OR NEW.recipient_contact_id IS DISTINCT FROM OLD.recipient_contact_id
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.sent_at IS DISTINCT FROM OLD.sent_at) THEN
    RAISE EXCEPTION 'immutable_row: a sent client report does not change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_projects.client_reports_sent_once_fn() OWNER TO liaison_admin;
--> statement-breakpoint
CREATE TRIGGER client_reports_sent_once BEFORE UPDATE ON app_projects.client_reports
  FOR EACH ROW EXECUTE FUNCTION app_projects.client_reports_sent_once_fn();
--> statement-breakpoint
ALTER TABLE app_projects.client_reports OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.client_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.client_reports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app_projects.client_reports TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint
CREATE POLICY client_reports_select ON app_projects.client_reports FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_projects.app_has_scope('projects:reports:read'));
--> statement-breakpoint
CREATE POLICY client_reports_insert ON app_projects.client_reports FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_projects.app_has_scope('projects:reports:write'));
--> statement-breakpoint
CREATE POLICY client_reports_update ON app_projects.client_reports FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_projects.app_has_scope('projects:reports:write'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_projects.app_has_scope('projects:reports:write'));
--> statement-breakpoint
CREATE VIEW portal.client_reports WITH (security_barrier = true) AS
  SELECT r.id, r.project_id, r.period_end, r.sent_at, r.sections_sent,
         u.name AS sent_by_name
    FROM app_projects.client_reports r
    LEFT JOIN kernel.users u ON u.id = r.approved_by_user_id AND u.org_id = r.org_id
   WHERE r.org_id = (SELECT rls_ctx.org_id())::uuid
     AND r.company_id = (SELECT portal.company_id())
     AND r.status = 'sent'
     AND r.sections_sent IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM portal.shares s
        WHERE s.kind = 'project_reports'
          AND s.object_id = r.project_id
     );
--> statement-breakpoint
ALTER VIEW portal.client_reports OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.client_reports TO liaison_portal;
--> statement-breakpoint
-- The kinds a person has open on the portal for one project of this org, to its client
-- company: what a report may say. A report writer reads them without holding the portal
-- share scopes; kinds only, never who shared or with whom.
CREATE FUNCTION app_projects.client_report_open_kinds(p_project uuid)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT DISTINCT s.kind
    FROM app_projects.projects p
    JOIN kernel.portal_shares s ON s.org_id = p.org_id AND s.company_id = p.company_id
                               AND s.object_id = p.id AND s.closed_at IS NULL
    JOIN kernel.companies c ON c.id = p.company_id AND c.org_id = p.org_id
   WHERE p.id = p_project
     AND p.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
     AND c.closed_at IS NULL AND c.portal_ended_at IS NULL
     AND s.kind IN ('project_progress', 'project_reports', 'project_hours')
     AND app_projects.app_has_scope('projects:reports:read')
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_projects.client_report_open_kinds(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.client_report_open_kinds(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION app_projects.client_report_open_kinds(uuid) TO liaison_rls, liaison_app;
--> statement-breakpoint
-- The hours a report may state: exactly what the client's portal shows for the project
-- (billed totals, or the retainer's so-far total), only behind an open hours share on a
-- project using time and budgets. Totals only: no row, no person, no task.
CREATE FUNCTION app_projects.client_report_hours(p_project uuid)
RETURNS TABLE (kind text, used_minutes bigint, of_minutes bigint, period text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_basis text;
  v_from date;
  v_to date;
  v_of bigint;
BEGIN
  IF v_org IS NULL OR NOT app_projects.app_has_scope('projects:reports:read') THEN RETURN; END IF;
  SELECT tp.basis INTO v_basis
    FROM app_projects.projects p
    JOIN app_projects.project_time_plan tp ON tp.project_id = p.id AND tp.org_id = p.org_id
   WHERE p.id = p_project
     AND p.org_id = v_org
     AND p.kind = 'work'
     AND p.time_budgets_on
     AND EXISTS (SELECT 1 FROM app_projects.client_report_open_kinds(p.id) k WHERE k = 'project_hours');
  IF v_basis IS NULL THEN RETURN; END IF;
  SELECT b.period_start, b.period_end, b.minutes INTO v_from, v_to, v_of
    FROM app_projects.project_timeboxes b
   WHERE b.project_id = p_project AND b.org_id = v_org
     AND b.period_start <= current_date AND b.period_end >= current_date
   ORDER BY b.period_start DESC
   LIMIT 1;
  IF v_basis IN ('hourly', 'daily') THEN
    RETURN QUERY
      SELECT 'billed'::text,
             COALESCE(sum(COALESCE(l.billed_after_credit_minutes, l.bill_minutes)), 0)::bigint,
             v_of,
             CASE WHEN v_from IS NULL THEN NULL ELSE v_from::text || '/' || v_to::text END
        FROM app_projects.reconciliation_lines l
        JOIN app_projects.reconciliations r ON r.id = l.reconciliation_id AND r.org_id = l.org_id
       WHERE r.project_id = p_project
         AND r.org_id = v_org
         AND EXISTS (
           SELECT 1 FROM app_projects.billing_claims bc
            WHERE bc.line_id = l.id AND bc.org_id = v_org AND bc.state = 'billed'
         );
  ELSIF v_basis = 'retainer' AND v_from IS NOT NULL THEN
    RETURN QUERY
      SELECT 'so_far'::text,
             COALESCE(sum(tt.minutes), 0)::bigint,
             v_of,
             v_from::text || '/' || v_to::text
        FROM app_projects.task_time tt
       WHERE tt.project_id = p_project
         AND tt.org_id = v_org
         AND tt.work_date >= v_from
         AND tt.work_date <= v_to;
  END IF;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_projects.client_report_hours(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.client_report_hours(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION app_projects.client_report_hours(uuid) TO liaison_rls, liaison_app;
