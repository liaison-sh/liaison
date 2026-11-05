-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A routine's run history on its agent page says, per run, what started it and
-- where its transcript sits in the routine's output thread. A run row knew only
-- when it ENDED (ran_at) and how long it took, and nothing about its trigger.
--
--   trigger       'schedule' (cron or one-shot), 'event' (an event routine
--                 matched an event) or 'manual' (run now). NULL on rows written
--                 before this column: the history shows no trigger for them.
--   trigger_label The event that fired an event run, as app.entity.action.
--   started_at    When the run began. The run's transcript is the output
--                 thread's messages between started_at and ran_at (a routine
--                 never runs twice at once: the tick lock). NULL on older rows,
--                 which fall back to ran_at minus duration_ms.
--
-- Additive and nullable: no backfill, no rewrite of existing rows.
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS "trigger" text;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS trigger_label text;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS started_at timestamptz;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE kernel.routine_runs ADD CONSTRAINT routine_runs_trigger_chk
    CHECK ("trigger" IS NULL OR "trigger" IN ('schedule', 'event', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
