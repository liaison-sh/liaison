-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A routine run that waits for its owner's private mailbox
-- (routine-mailbox-wait.ts).
--
--  - routine_runs.status gains 'waiting_mailbox': the run needed to read the
--    owner's private (zero-access) mailbox, which only the owner's unlocked
--    browser can read, so it stopped and asks the owner to run it (Run now on
--    Home). The row turns 'succeeded' or 'failed' when the owner runs it, or
--    'mailbox_wait_expired' when nobody did within 24 hours.
--  - routine_runs.mailbox_wait: what the wait holds (whose mailbox, which
--    mailbox, until when, whether a Run now claimed it). Ids and times only,
--    never mail content. NULL for every run that never waited.
--
-- Every statement is re-runnable, following the 0222 convention.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS mailbox_wait jsonb;
--> statement-breakpoint
-- expand-safe: only widens the allowed statuses; the previous release writes none of the new ones
ALTER TABLE kernel.routine_runs DROP CONSTRAINT IF EXISTS routine_runs_status_chk;
--> statement-breakpoint
-- expand-safe: every status the previous release writes is still allowed
ALTER TABLE kernel.routine_runs
  ADD CONSTRAINT routine_runs_status_chk CHECK (status IN (
    'succeeded', 'failed', 'skipped_no_credits', 'skipped_overlap', 'skipped_scope_mismatch',
    'output_thread_recreated', 'dispatched', 'waiting_approval', 'waiting_mailbox',
    'mailbox_wait_expired'
  ));
