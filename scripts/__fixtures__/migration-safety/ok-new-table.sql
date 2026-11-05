-- SPDX-License-Identifier: FSL-1.1-ALv2
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A new table with its indexes, RLS and grants: nothing existing changes.
CREATE TABLE IF NOT EXISTS kernel.widget_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done')),
  note text DEFAULT 'it''s; fine -- not a comment'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS widget_runs_state_idx ON kernel.widget_runs (state);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS widget_runs_org_idx ON kernel.widget_runs (org_id, id);
--> statement-breakpoint
ALTER TABLE kernel.widget_runs ADD CONSTRAINT widget_runs_note_len CHECK (char_length(note) < 200);
--> statement-breakpoint
ALTER TABLE kernel.widget_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.widget_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS widget_runs_select ON kernel.widget_runs;
--> statement-breakpoint
CREATE POLICY widget_runs_select ON kernel.widget_runs FOR SELECT TO liaison_rls USING (org_id = kernel.current_org_id());
--> statement-breakpoint
REVOKE ALL ON kernel.widget_runs FROM liaison_rls;
--> statement-breakpoint
ALTER TABLE kernel.threads ADD COLUMN IF NOT EXISTS widget_run_id uuid;
--> statement-breakpoint
ALTER TABLE kernel.threads ADD COLUMN IF NOT EXISTS widget_count integer NOT NULL DEFAULT 0;
