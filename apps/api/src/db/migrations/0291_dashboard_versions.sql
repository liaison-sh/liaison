-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.dashboard_versions: the title and spec of each saved version of a dashboard, so a
-- person (or an agent, through an approval for an org dashboard) can list them and revert to
-- one (a revert is a NEW version; history is never rewritten). The service keeps the last 20
-- per dashboard and deletes older ones in the same transaction as the save.
--
-- Rows follow their dashboard: FORCE RLS lets a session read, add or prune the versions of a
-- dashboard it can see (the EXISTS reads kernel.dashboards under its own row policies), in its
-- org. Rows are never updated.
--
-- New table, every statement re-runnable. The previous release never reads or writes it.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS kernel.dashboard_versions (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  dashboard_id uuid NOT NULL REFERENCES kernel.dashboards(id) ON DELETE CASCADE,
  version integer NOT NULL CONSTRAINT dashboard_versions_version_check CHECK (version >= 1),
  title text NOT NULL CONSTRAINT dashboard_versions_title_check CHECK (length(title) <= 200),
  spec jsonb NOT NULL
    CONSTRAINT dashboard_versions_spec_check
    CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 262144),
  saved_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dashboard_id, version)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_versions_org_idx ON kernel.dashboard_versions (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_versions_saved_by_fk_idx
  ON kernel.dashboard_versions (saved_by) WHERE saved_by IS NOT NULL;
--> statement-breakpoint
ALTER TABLE kernel.dashboard_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.dashboard_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- No UPDATE policy: a session never rewrites a version (erasure clears saved_by privileged).
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.dashboard_versions TO liaison_rls, liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_versions_select ON kernel.dashboard_versions;
--> statement-breakpoint
CREATE POLICY dashboard_versions_select ON kernel.dashboard_versions FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (SELECT 1 FROM kernel.dashboards d WHERE d.id = dashboard_id)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_versions_insert ON kernel.dashboard_versions;
--> statement-breakpoint
CREATE POLICY dashboard_versions_insert ON kernel.dashboard_versions FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (SELECT 1 FROM kernel.dashboards d WHERE d.id = dashboard_id)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_versions_delete ON kernel.dashboard_versions;
--> statement-breakpoint
CREATE POLICY dashboard_versions_delete ON kernel.dashboard_versions FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (SELECT 1 FROM kernel.dashboards d WHERE d.id = dashboard_id)
  );
