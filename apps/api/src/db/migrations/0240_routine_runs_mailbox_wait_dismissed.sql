-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A routine run waiting for its owner's private mailbox can be dismissed
-- (routine-mailbox-wait.ts `dismissWaitingMailboxRun`): the owner declines it
-- from their approvals list instead of running it, and the run history says
-- so. routine_runs.status gains 'mailbox_wait_dismissed'.
--
-- Every statement is re-runnable, following the 0222 convention.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: only widens the allowed statuses; the previous release writes none of the new ones
ALTER TABLE kernel.routine_runs DROP CONSTRAINT IF EXISTS routine_runs_status_chk;
--> statement-breakpoint
-- expand-safe: every status the previous release writes is still allowed
ALTER TABLE kernel.routine_runs
  ADD CONSTRAINT routine_runs_status_chk CHECK (status IN (
    'succeeded', 'failed', 'skipped_no_credits', 'skipped_overlap', 'skipped_scope_mismatch',
    'output_thread_recreated', 'dispatched', 'waiting_approval', 'waiting_mailbox',
    'mailbox_wait_expired', 'mailbox_wait_dismissed'
  ));
