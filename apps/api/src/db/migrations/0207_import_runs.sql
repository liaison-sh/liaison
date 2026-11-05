-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.import_runs and kernel.import_ledger: the import framework
-- (modules/imports).
--
-- import_runs: one row per import run (a CLI run, a person's run from
-- Settings, an agent run). Org data: FORCE RLS, readable by the run's org for
-- holders of `kernel:imports:read`. Writes go through the privileged
-- connection only (the runner and the job), so liaison_rls gets no write
-- policy.
--
-- import_ledger: every row a run created, in creation order (`seq`). Undo
-- deletes only rows recorded here and refuses rows changed after they were
-- recorded. `record_key` groups the rows of one record (its dedup key): undo
-- keeps or deletes a record's rows together. Reached only through the privileged connection: FORCE RLS plus a
-- deny-all SELECT policy for liaison_rls (the 0058 ledger template).
-- `row_id` carries no foreign key: undo deletes the rows it names.
--
-- Every statement is re-runnable.

CREATE TABLE IF NOT EXISTS kernel.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  kind_set text[] NOT NULL DEFAULT '{}',
  source_label text NOT NULL DEFAULT '',
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode text NOT NULL DEFAULT 'api',
  status text NOT NULL DEFAULT 'queued',
  dry_run boolean NOT NULL DEFAULT false,
  placeholders boolean NOT NULL DEFAULT false,
  cancel_requested boolean NOT NULL DEFAULT false,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by uuid,
  approval_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT import_runs_status_chk CHECK (
    status IN ('queued','running','done','failed','cancelled','undoing','undone')
  ),
  CONSTRAINT import_runs_mode_chk CHECK (mode IN ('api','cli'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_runs_org_created_idx
  ON kernel.import_runs (org_id, created_at DESC);
--> statement-breakpoint
-- The stale-run sweep: runs still running (or undoing) whose heartbeat stopped.
CREATE INDEX IF NOT EXISTS import_runs_active_heartbeat_idx
  ON kernel.import_runs (heartbeat_at) WHERE status IN ('running', 'undoing');
--> statement-breakpoint
ALTER TABLE kernel.import_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.import_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.import_runs TO liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.import_runs TO liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS import_runs_select ON kernel.import_runs;
--> statement-breakpoint
CREATE POLICY import_runs_select ON kernel.import_runs FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND kernel.has_scope('kernel:imports:read')
  );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.import_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES kernel.import_runs(id) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL,
  record_key text NOT NULL DEFAULT '',
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS import_ledger_table_row_run_idx
  ON kernel.import_ledger (table_name, row_id, run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_ledger_org_run_seq_idx
  ON kernel.import_ledger (org_id, run_id, seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_ledger_row_idx
  ON kernel.import_ledger (row_id);
--> statement-breakpoint
ALTER TABLE kernel.import_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.import_ledger FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.import_ledger TO liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.import_ledger TO liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS import_ledger_select ON kernel.import_ledger;
--> statement-breakpoint
CREATE POLICY import_ledger_select ON kernel.import_ledger FOR SELECT TO liaison_rls
  USING (false);
