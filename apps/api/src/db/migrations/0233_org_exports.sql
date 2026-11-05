-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.org_exports: one row per whole-org export archive
-- (modules/export/org-archive). The `org-export` job writes the archive to
-- object storage at `orgs/<org>/exports/<id>.zip`; the row tracks it until a
-- daily job deletes the object and marks the row `expired`.
--
-- Org data: FORCE RLS, readable by the row's org for holders of
-- `kernel:org:admin`. Writes go through the privileged connection only (the
-- routes after their scope check, the job, the CLI), so liaison_rls gets no
-- write policy.
--
-- At most one export per org is queued or running (partial unique index): a
-- second request is refused with the running one's id.
--
-- run_id is the token of the run that holds a running row: each claim (a
-- first run or a takeover of a stalled one) sets a new one, and only its
-- holder may heartbeat, complete or fail the row. Each run writes its own
-- object, `orgs/<org>/exports/<id>-<run>.zip`.
--
-- Additive, every statement re-runnable.

CREATE TABLE IF NOT EXISTS kernel.org_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  run_id uuid,
  requested_by uuid,
  requested_via text NOT NULL DEFAULT 'settings',
  object_key text,
  bytes bigint,
  error text,
  manifest jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz,
  downloaded_at timestamptz,
  CONSTRAINT org_exports_status_chk CHECK (
    status IN ('queued','running','completed','failed','expired')
  ),
  CONSTRAINT org_exports_via_chk CHECK (requested_via IN ('settings','cli'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS org_exports_org_created_idx
  ON kernel.org_exports (org_id, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS org_exports_one_active_idx
  ON kernel.org_exports (org_id) WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS org_exports_completed_expiry_idx
  ON kernel.org_exports (expires_at) WHERE status = 'completed';
--> statement-breakpoint
ALTER TABLE kernel.org_exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.org_exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.org_exports TO liaison_rls;
--> statement-breakpoint
-- Default privileges hand liaison_rls write grants on a new table; it writes
-- nothing here.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON kernel.org_exports FROM liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.org_exports TO liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS org_exports_select ON kernel.org_exports;
--> statement-breakpoint
CREATE POLICY org_exports_select ON kernel.org_exports FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(rls_ctx.org_id(), '')::uuid
    AND kernel.has_scope('kernel:org:admin')
  );
