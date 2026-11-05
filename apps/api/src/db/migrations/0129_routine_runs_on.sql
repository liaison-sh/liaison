-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Where a routine runs (S21, D9, spec-node.md "Routing", A50/F8).
--
--  - routines.runs_on: 'cloud' (default, every routine today), 'node' (the
--    owner's node; queued with a push when it is offline) or 'node_else_cloud'
--    (the node when one is live, else the cloud, the node job marked
--    fell_back).
--  - routine_runs.status gains 'dispatched': the tick handed the run to a node
--    job. The row turns 'succeeded' or 'failed' when that job ends.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS runs_on text NOT NULL DEFAULT 'cloud';
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_runs_on_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_runs_on_chk CHECK (runs_on IN ('cloud', 'node', 'node_else_cloud'));
--> statement-breakpoint
ALTER TABLE kernel.routine_runs DROP CONSTRAINT IF EXISTS routine_runs_status_chk;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs
  ADD CONSTRAINT routine_runs_status_chk CHECK (status IN (
    'succeeded', 'failed', 'skipped_no_credits', 'skipped_overlap', 'skipped_scope_mismatch',
    'output_thread_recreated', 'dispatched'
  ));
