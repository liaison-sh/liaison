-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Routine flows: a routine's ordered steps after its trigger (actions run without an agent,
-- waits in working time, agent steps with required outcomes), and each run's per-step state.
--   routines.flow          the flow ({version: 1, steps: [...]}); NULL = a legacy routine whose
--                          one agent step is its prompt (unchanged behaviour)
--   routine_runs.steps     a flow run's per-step state, updated after each step
--   routine_runs.flow_context  what a flow run's resume needs: the flow's hash at the start (an
--                          edited flow ends a parked run), its chain hop and its trigger event
--   routine_runs.status    gains 'running' (a flow run in progress), 'waiting' (a flow run parked
--                          on a wait step until its deadline), 'flagged' (an agent step missed a
--                          required outcome after its bumps) and 'skipped_condition' (a wait's
--                          condition no longer held, or a newer run for the same record took over)
--   routines.event_filter  also allowed on projects task events (projectId, fromStatusId,
--                          toStatusId, fields)
-- Additive and re-runnable.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS flow jsonb;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS steps jsonb;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS flow_context jsonb;
--> statement-breakpoint

-- expand-safe: a new check on a new column the previous release never writes.
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_flow_chk;
--> statement-breakpoint
-- expand-safe: a new check on a new column the previous release never writes.
ALTER TABLE kernel.routines ADD CONSTRAINT routines_flow_chk CHECK (
  flow IS NULL OR (jsonb_typeof(flow) = 'object' AND COALESCE(jsonb_typeof(flow->'steps'), '') = 'array')
);
--> statement-breakpoint

-- expand-safe: replaced by the wider check below in the same transaction; every row the previous
-- release writes satisfies it.
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_event_filter_chk;
--> statement-breakpoint
-- expand-safe: a wider check than the one it replaces; the previous release only writes rows the
-- old check allowed, which this one allows too.
ALTER TABLE kernel.routines ADD CONSTRAINT routines_event_filter_chk CHECK (
  event_filter IS NULL OR (
    jsonb_typeof(event_filter) = 'object'
    AND event IN (
      'mail:message:create',
      'kernel:dashboard_table_row:created',
      'kernel:dashboard_table_row:updated',
      'kernel:dashboard_table_row:deleted',
      'projects:task:status_changed',
      'projects:task:updated',
      'projects:task:created'
    )
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE kernel.routines VALIDATE CONSTRAINT routines_event_filter_chk;
--> statement-breakpoint

-- expand-safe: only widens the allowed statuses; the previous release writes none of the new ones
ALTER TABLE kernel.routine_runs DROP CONSTRAINT IF EXISTS routine_runs_status_chk;
--> statement-breakpoint
-- expand-safe: every status the previous release writes is still allowed
ALTER TABLE kernel.routine_runs
  ADD CONSTRAINT routine_runs_status_chk CHECK (status IN (
    'succeeded', 'failed', 'skipped_no_credits', 'skipped_overlap', 'skipped_scope_mismatch',
    'output_thread_recreated', 'dispatched', 'waiting_approval', 'waiting_mailbox',
    'mailbox_wait_expired', 'mailbox_wait_dismissed', 'running', 'waiting', 'flagged',
    'skipped_condition'
  ));
