-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Every event an event routine should handle gets a run that did its job. A run
-- row did not say WHICH event it ran for, so nothing could tell a delivered
-- event from a lost one, and a run that could not do its job (a tool it called
-- was unavailable) was recorded as succeeded. These columns let the reconciler
-- (routine-event-reconciler.ts) find an event with no successful run and fire
-- the routine again for that exact event.
--
--   event_id         The outbox id of the event the run was fired for, the id
--                    kernel.audit_log keeps as event_id. NULL for scheduled and
--                    manual runs, and on rows written before this column.
--   event_entity_id  That event's entity id (a ticket message id, ...).
--   attempt          0 for the run the event fired, n for the reconciler's nth
--                    retry of it.
--   trigger 'retry'  A run the reconciler fired again for an event.
--
-- Additive: nullable or defaulted columns, the trigger check widened.
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS event_id uuid;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS event_entity_id text;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS routine_runs_routine_event_idx
  ON kernel.routine_runs (routine_id, event_id) WHERE event_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS routine_runs_routine_event_entity_idx
  ON kernel.routine_runs (routine_id, event_entity_id) WHERE event_entity_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs DROP CONSTRAINT IF EXISTS routine_runs_trigger_chk;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ADD CONSTRAINT routine_runs_trigger_chk
  CHECK ("trigger" IS NULL OR "trigger" IN ('schedule', 'event', 'manual', 'retry'));
