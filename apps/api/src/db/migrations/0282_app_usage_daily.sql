-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.app_usage_daily: per-org app usage per UTC day, one row per
-- (org, app, day, executor) (modules/apps/usage/). Runs, bridge calls and wall
-- milliseconds are added by the cell as runs settle (batched); cpu_ms is the
-- Workers loader's measure, pulled every hour (null until then, and on
-- QuickJS). Reporting only: the per-day app caps are enforced from Redis day
-- counters.
--
-- Org data: FORCE RLS, readable by the row's org. Written only through the
-- privileged connection, so liaison_rls gets no write policy.
--
-- Additive, every statement re-runnable: the previous release never reads or
-- writes the table.

CREATE TABLE IF NOT EXISTS kernel.app_usage_daily (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app text NOT NULL,
  day date NOT NULL,
  executor text NOT NULL,
  runs bigint NOT NULL DEFAULT 0,
  bridge_calls bigint NOT NULL DEFAULT 0,
  wall_ms bigint NOT NULL DEFAULT 0,
  cpu_ms bigint NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app, day, executor)
);
--> statement-breakpoint
ALTER TABLE kernel.app_usage_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_usage_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.app_usage_daily TO liaison_rls;
--> statement-breakpoint
-- Default privileges hand liaison_rls write grants on a new table; it writes
-- nothing here.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON kernel.app_usage_daily FROM liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.app_usage_daily TO liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS app_usage_daily_select ON kernel.app_usage_daily;
--> statement-breakpoint
CREATE POLICY app_usage_daily_select ON kernel.app_usage_daily FOR SELECT TO liaison_rls
  USING (org_id = NULLIF(rls_ctx.org_id(), '')::uuid);
