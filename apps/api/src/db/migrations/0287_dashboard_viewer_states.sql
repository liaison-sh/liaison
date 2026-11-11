-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.dashboard_viewer_states: the time range (and comparison) one person last chose
-- on one dashboard, so the dashboard opens on it for them next time. One row per
-- (dashboard, person); gone with either.
--
-- Rows are private to their person: FORCE RLS lets the session read and write only its
-- own user's rows in its org, and a row may be written only for a dashboard the person
-- can see (the EXISTS reads kernel.dashboards under the same row policies).
--
-- New table, every statement re-runnable.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS kernel.dashboard_viewer_states (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  dashboard_id uuid NOT NULL REFERENCES kernel.dashboards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  time_range jsonb NOT NULL
    CONSTRAINT dashboard_viewer_states_time_range_check
    CHECK (jsonb_typeof(time_range) = 'object' AND octet_length(time_range::text) <= 1024),
  compare text NOT NULL
    CONSTRAINT dashboard_viewer_states_compare_check
    CHECK (compare IN ('lastYear', 'previousPeriod', 'none')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dashboard_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_viewer_states_user_fk_idx
  ON kernel.dashboard_viewer_states (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_viewer_states_org_idx
  ON kernel.dashboard_viewer_states (org_id);
--> statement-breakpoint
ALTER TABLE kernel.dashboard_viewer_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.dashboard_viewer_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.dashboard_viewer_states TO liaison_rls, liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_viewer_states_select ON kernel.dashboard_viewer_states;
--> statement-breakpoint
CREATE POLICY dashboard_viewer_states_select ON kernel.dashboard_viewer_states FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_viewer_states_insert ON kernel.dashboard_viewer_states;
--> statement-breakpoint
CREATE POLICY dashboard_viewer_states_insert ON kernel.dashboard_viewer_states FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    AND EXISTS (SELECT 1 FROM kernel.dashboards d WHERE d.id = dashboard_id)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_viewer_states_update ON kernel.dashboard_viewer_states;
--> statement-breakpoint
CREATE POLICY dashboard_viewer_states_update ON kernel.dashboard_viewer_states FOR UPDATE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
  )
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    AND EXISTS (SELECT 1 FROM kernel.dashboards d WHERE d.id = dashboard_id)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_viewer_states_delete ON kernel.dashboard_viewer_states;
--> statement-breakpoint
CREATE POLICY dashboard_viewer_states_delete ON kernel.dashboard_viewer_states FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
  );
