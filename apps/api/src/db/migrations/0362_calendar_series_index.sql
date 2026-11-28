-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Calendar week reads find the recurring series without walking the history.
--
-- The window read fetches the series masters begun before the window ends. Only
-- `(org_id, start_at)` served that bound, so every read walked each event of the org that
-- started before the window (years of plain events) to keep the few rows carrying a recurrence.
-- A partial index over live masters only (`recurring_event_id IS NULL`, not deleted, a
-- recurrence that is neither JSON null nor an empty list) holds just the series; the read
-- repeats the same predicate so the planner uses it.
--
-- The calendar app's registration declares the same index for a new instance. On an instance
-- where the table already exists this file builds it; the name is the one registration
-- generates, so registration finds it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- reviewed-dynamic: one partial index on a table the calendar app's registration owns, only where it exists. Registration declares the same index for a new instance.
-- index-build: app_calendar.events 50000 25
DO $$
BEGIN
  IF to_regclass('app_calendar.events') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_app_calendar_events_start_at_end_at
      ON app_calendar.events (org_id, start_at, end_at)
      WHERE recurring_event_id IS NULL AND deleted_at IS NULL
        AND recurrence <> 'null' AND recurrence <> '[]';
  END IF;
END $$;
