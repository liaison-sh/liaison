-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A routine run that waits for an approval (routine-run-resume.ts).
--
--  - routine_runs.status gains 'waiting_approval': the run's turn proposed a
--    gated call and stopped there. The row turns 'succeeded' or 'failed' when
--    the run resumes after the decision and ends.
--  - routine_runs.pause_state: what the resume needs while the run waits (the
--    approvals it waits on, its output thread, its run line, how many times it
--    has resumed). NULL for every run that never paused.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS pause_state jsonb;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs DROP CONSTRAINT IF EXISTS routine_runs_status_chk;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs
  ADD CONSTRAINT routine_runs_status_chk CHECK (status IN (
    'succeeded', 'failed', 'skipped_no_credits', 'skipped_overlap', 'skipped_scope_mismatch',
    'output_thread_recreated', 'dispatched', 'waiting_approval'
  ));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS routine_runs_waiting_idx
  ON kernel.routine_runs (routine_id) WHERE status = 'waiting_approval';
