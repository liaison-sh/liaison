-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An open hours share lists its project on the portal by itself.
--
-- `portal.projects` listed a project only behind an open progress or reports share, while the
-- hours of a project show on its page: a client whose project had only its hours open saw
-- nothing at all. An open hours share now lists the project too. What the page shows is
-- unchanged and still read behind each part's own share: the steps behind progress
-- (`portal.project_steps`), the hours behind hours (`portal.project_hours`, so far, from real
-- time, totals only), the reports behind reports (`portal.client_reports`). Same columns in the
-- same order; re-runnable.

-- expand-safe: same columns in the same order; the WHERE only admits one more share kind
CREATE OR REPLACE VIEW portal.projects WITH (security_barrier = true) AS
  SELECT p.id, p.name, o.name AS owner_name
    FROM app_projects.projects p
    LEFT JOIN kernel.users o ON o.id = p.owner_id AND o.org_id = p.org_id
   WHERE p.org_id = (SELECT rls_ctx.org_id())::uuid
     AND p.company_id = (SELECT portal.company_id())
     AND p.kind = 'work'
     AND p.archived_at IS NULL
     AND EXISTS (
       SELECT 1 FROM portal.shares s
        WHERE s.kind IN ('project_progress', 'project_reports', 'project_hours')
          AND s.object_id = p.id
     );
--> statement-breakpoint
ALTER VIEW portal.projects OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.projects TO liaison_portal;
