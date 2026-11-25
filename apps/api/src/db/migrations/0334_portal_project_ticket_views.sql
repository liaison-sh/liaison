-- SPDX-License-Identifier: FSL-1.1-ALv2
-- What a client reads of projects and requests, and the files that come with them.
--
--   app_tickets.tickets.company_id  the client company of the ticket, stamped when it
--                                   is created (from its contact's company, or the
--                                   portal person's), never followed afterwards. Open
--                                   tickets are stamped once here from their contact's
--                                   company as it is now; a ticket with no company
--                                   stays NULL, and a NULL company is nobody's.
--   portal.me                       gains contact_name: the first and last name of the
--                                   company's account manager while that person is an
--                                   active member, and nothing else about them.
--   portal.projects                 the caller's company's work projects behind an open
--                                   progress or reports share.
--   portal.project_steps            their milestones behind an open progress share, with
--                                   the share of child tasks done (rounded to 10). Time
--                                   recorded is never an input.
--   portal.tickets                  the caller's own portal requests, or a ticket a person
--                                   shared, of the caller's company, internal only,
--                                   behind an open requests share.
--   (portal.ticket_messages reads columns the tickets manifest owns, so the tickets
--   app's registration makes it: modules/portal/views.ts.)
--   portal.project_hours(project)   billed hours (hourly, daily) or hours used so far in
--                                   the retainer's period, as totals only, behind an open
--                                   hours share on a project using time and budgets.
--   portal.file_allowed(file)       whether a file is one the caller may download.
--   portal.file_meta(file)          its name, type and size, only when allowed.
--
-- Every predicate reads a company stamped on the object (the ticket's company_id, the
-- project's company_id), never a contact's current company, so moving a contact moves
-- nothing on anyone's portal. Views are owned by liaison_admin, which bypasses row
-- level security: the WHERE of each one is the whole boundary. The functions are
-- definers owned by liaison_admin for the same reason, and read only the views above
-- plus the one file row asked about.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never writes or reads this column; every existing ticket keeps its rows
ALTER TABLE app_tickets.tickets ADD COLUMN IF NOT EXISTS company_id uuid;
--> statement-breakpoint
-- The forward stamp: tickets still open take their contact's company as it is now.
-- reviewed-dynamic: a one-time stamp of a column no previous release reads
UPDATE app_tickets.tickets t
   SET company_id = c.company_id
  FROM kernel.contacts c
 WHERE c.id = t.contact_id
   AND c.org_id = t.org_id
   AND c.company_id IS NOT NULL
   AND t.company_id IS NULL
   AND t.status <> 'closed';
--> statement-breakpoint
-- index-build: app_tickets.tickets 50000 2
CREATE INDEX IF NOT EXISTS tickets_company_idx ON app_tickets.tickets (org_id, company_id)
  WHERE company_id IS NOT NULL;
--> statement-breakpoint
-- The definer functions below run as liaison_admin and read the views, which call the
-- caller's company and contact: their owner may call them too.
GRANT USAGE ON SCHEMA portal TO liaison_admin;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.company_id(), portal.contact_id() TO liaison_admin;
--> statement-breakpoint
-- expand-safe: same columns in the same order, one appended; no previous-release code selects *
CREATE OR REPLACE VIEW portal.me WITH (security_barrier = true) AS
  SELECT u.id, u.name, u.email, u.locale, u.timezone, u.company_id,
         (SELECT o.name
            FROM kernel.companies c
            JOIN kernel.users o ON o.id = c.owner_user_id AND o.org_id = c.org_id
           WHERE c.id = u.company_id
             AND c.org_id = u.org_id
             AND o.user_type <> 'external'
             AND o.status = 'active') AS contact_name
    FROM kernel.users u
   WHERE u.id = (SELECT rls_ctx.user_id())::uuid
     AND u.org_id = (SELECT rls_ctx.org_id())::uuid
     AND u.user_type = 'external' AND u.status = 'active'
     AND u.company_id = (SELECT portal.company_id());
--> statement-breakpoint
CREATE VIEW portal.projects WITH (security_barrier = true) AS
  SELECT p.id, p.name, o.name AS owner_name
    FROM app_projects.projects p
    LEFT JOIN kernel.users o ON o.id = p.owner_id AND o.org_id = p.org_id
   WHERE p.org_id = (SELECT rls_ctx.org_id())::uuid
     AND p.company_id = (SELECT portal.company_id())
     AND p.kind = 'work'
     AND p.archived_at IS NULL
     AND EXISTS (
       SELECT 1 FROM portal.shares s
        WHERE s.kind IN ('project_progress', 'project_reports')
          AND s.object_id = p.id
     );
--> statement-breakpoint
ALTER VIEW portal.projects OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.projects TO liaison_portal;
--> statement-breakpoint
-- A milestone's progress is the share of its child tasks in a done column, rounded to
-- the nearest 10; a milestone with no child task reads 100 when it is done, else 0.
CREATE VIEW portal.project_steps WITH (security_barrier = true) AS
  SELECT t.id, t.project_id, t.title,
         CASE WHEN st.terminal THEN 'done' ELSE 'open' END AS state,
         CASE
           WHEN k.total > 0 THEN (round(k.done::numeric * 10 / k.total) * 10)::int
           WHEN st.terminal THEN 100
           ELSE 0
         END AS done_share,
         t.due_date AS due_on
    FROM app_projects.tasks t
    JOIN app_projects.projects p ON p.id = t.project_id AND p.org_id = t.org_id
    JOIN app_projects.project_statuses st ON st.id = t.status_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE cs.terminal) AS done
        FROM app_projects.tasks c
        JOIN app_projects.project_statuses cs ON cs.id = c.status_id
       WHERE c.parent_task_id = t.id
         AND c.org_id = t.org_id
         AND c.archived_at IS NULL
    ) k
   WHERE t.org_id = (SELECT rls_ctx.org_id())::uuid
     AND t.is_milestone
     AND t.archived_at IS NULL
     AND p.company_id = (SELECT portal.company_id())
     AND p.kind = 'work'
     AND p.archived_at IS NULL
     AND EXISTS (
       SELECT 1 FROM portal.shares s
        WHERE s.kind = 'project_progress' AND s.object_id = p.id
     );
--> statement-breakpoint
ALTER VIEW portal.project_steps OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.project_steps TO liaison_portal;
--> statement-breakpoint
-- A ticket is the caller's when it is their own portal request, or a person opened a
-- ticket share on it; in both cases internal, of the caller's company, not merged, and
-- the company's requests are open.
CREATE VIEW portal.tickets WITH (security_barrier = true) AS
  SELECT t.id, t.subject, t.status, t.channel, t.created_at, t.last_message_at
    FROM app_tickets.tickets t
   WHERE t.org_id = (SELECT rls_ctx.org_id())::uuid
     AND t.company_id = (SELECT portal.company_id())
     AND t.sensitivity = 'internal'
     AND t.merged_into_ticket_id IS NULL
     AND EXISTS (SELECT 1 FROM portal.shares s WHERE s.kind = 'requests' AND s.object_id IS NULL)
     AND (
       (t.channel = 'portal' AND t.contact_id = (SELECT portal.contact_id()))
       OR EXISTS (SELECT 1 FROM portal.shares s WHERE s.kind = 'ticket' AND s.object_id = t.id)
     );
--> statement-breakpoint
ALTER VIEW portal.tickets OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.tickets TO liaison_portal;
--> statement-breakpoint
-- Hours behind an open hours share, as totals only. Hourly and daily projects: the
-- minutes billed on invoices. A retainer: the minutes recorded so far in the current
-- retainer period, against what the period includes. Fixed price, no basis, or a
-- project not using time and budgets: no row.
CREATE FUNCTION portal.project_hours(p_project uuid)
RETURNS TABLE (kind text, used_minutes bigint, of_minutes bigint, period text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_basis text;
  v_from date;
  v_to date;
  v_of bigint;
BEGIN
  IF v_org IS NULL THEN RETURN; END IF;
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
ALTER FUNCTION portal.project_hours(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION portal.project_hours(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.project_hours(uuid) TO liaison_portal;
--> statement-breakpoint
-- A file the caller may download: an attachment of a message they read; a file a
-- person shared with their company, whose parent is re-read now and is theirs and not
-- restricted; the PDF of an invoice they read (when invoicing's portal view exists).
-- Anything else, or an unknown id, is false.
-- reviewed-dynamic: fixed SELECTs on portal.invoices and portal.ticket_messages through EXECUTE, so the function exists before the app registrations make those views; no DDL
CREATE FUNCTION portal.file_allowed(p_file uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_company uuid := (SELECT portal.company_id());
  f record;
  v_ok boolean := false;
BEGIN
  IF v_org IS NULL OR v_company IS NULL OR p_file IS NULL THEN RETURN false; END IF;
  SELECT id, app, entity_type, entity_id INTO f
    FROM kernel.files WHERE id = p_file AND org_id = v_org;
  IF NOT FOUND THEN RETURN false; END IF;

  -- An attachment of a message the caller reads.
  IF f.app = 'tickets' AND f.entity_type = 'message'
     AND to_regclass('portal.ticket_messages') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM portal.ticket_messages m WHERE m.id::text = $1)'
      INTO v_ok USING f.entity_id;
    IF v_ok THEN RETURN true; END IF;
  END IF;

  -- A file a person shared, whose parent is still the caller's company's and open.
  IF EXISTS (SELECT 1 FROM portal.shares s WHERE s.kind = 'file' AND s.object_id = f.id) THEN
    IF f.app = 'kernel' AND f.entity_type = 'company' THEN
      v_ok := f.entity_id = v_company::text;
    ELSIF f.app = 'tickets' AND f.entity_type = 'message' THEN
      v_ok := EXISTS (
        SELECT 1 FROM app_tickets.messages m
          JOIN app_tickets.tickets t ON t.id = m.ticket_id AND t.org_id = m.org_id
         WHERE m.id::text = f.entity_id AND m.org_id = v_org
           AND t.company_id = v_company AND t.sensitivity <> 'restricted');
    ELSIF f.app = 'tickets' AND f.entity_type = 'ticket' THEN
      v_ok := EXISTS (
        SELECT 1 FROM app_tickets.tickets t
         WHERE t.id::text = f.entity_id AND t.org_id = v_org
           AND t.company_id = v_company AND t.sensitivity <> 'restricted');
    ELSIF f.app = 'projects' AND f.entity_type = 'project' THEN
      v_ok := EXISTS (
        SELECT 1 FROM app_projects.projects p
         WHERE p.id::text = f.entity_id AND p.org_id = v_org AND p.company_id = v_company);
    ELSIF f.app = 'projects' AND f.entity_type = 'task' THEN
      v_ok := EXISTS (
        SELECT 1 FROM app_projects.tasks t
          JOIN app_projects.projects p ON p.id = t.project_id AND p.org_id = t.org_id
         WHERE t.id::text = f.entity_id AND t.org_id = v_org AND p.company_id = v_company);
    END IF;
    IF v_ok THEN RETURN true; END IF;
  END IF;

  -- The PDF of an invoice the caller reads. The view comes with the invoicing app.
  IF f.app = 'invoicing' AND to_regclass('portal.invoices') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM portal.invoices i WHERE i.pdf_file_id = $1)'
      INTO v_ok USING p_file;
    IF v_ok THEN RETURN true; END IF;
  END IF;
  RETURN false;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION portal.file_allowed(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION portal.file_allowed(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.file_allowed(uuid) TO liaison_portal;
--> statement-breakpoint
CREATE FUNCTION portal.file_meta(p_file uuid)
RETURNS TABLE (filename text, content_type text, byte_size bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT f.filename, f.mime_type, f.size_bytes
    FROM kernel.files f
   WHERE f.id = p_file
     AND f.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
     AND (SELECT portal.file_allowed(p_file))
$fn$;
--> statement-breakpoint
ALTER FUNCTION portal.file_meta(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION portal.file_meta(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.file_meta(uuid) TO liaison_portal;
