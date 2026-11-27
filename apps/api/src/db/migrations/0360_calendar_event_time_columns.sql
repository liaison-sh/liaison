-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Calendar window reads on indexed instants.
--
-- `start`, `end` and `original_start_time` of app_calendar.events are Google's jsonb points
-- (`{dateTime}` or `{date}`). The window read cast them to timestamptz through a CASE in its
-- WHERE clause, which no index can serve, so every week view scanned the org's whole event
-- history. Three timestamptz columns now hold those points as instants (an all-day date at UTC
-- midnight, the read's existing rule), kept by the calendar app's `point_time_columns` trigger
-- on every insert and update, and indexed with org_id first like every app index.
--
-- The calendar app's registration creates the table, these columns, the trigger and the
-- indexes on a new instance. On an instance where the table already exists this file adds the
-- columns, fills them for the rows already stored and builds the indexes; registration then
-- adds the trigger. The index names are the ones registration generates, so it finds them.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- reviewed-dynamic: three nullable columns, their backfill and their indexes on a table the calendar app's registration owns, only where it exists. Registration declares the same columns and indexes for a new instance.
-- index-build: app_calendar.events 50000 900
DO $$
BEGIN
  IF to_regclass('app_calendar.events') IS NOT NULL THEN
    ALTER TABLE app_calendar.events
      ADD COLUMN IF NOT EXISTS start_at timestamptz,
      ADD COLUMN IF NOT EXISTS end_at timestamptz,
      ADD COLUMN IF NOT EXISTS original_start_at timestamptz;
    UPDATE app_calendar.events SET
      start_at = CASE
        WHEN start->>'dateTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' THEN (start->>'dateTime')::timestamptz
        WHEN start->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ((start->>'date')::date)::timestamp AT TIME ZONE 'UTC'
      END,
      end_at = CASE
        WHEN "end"->>'dateTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' THEN ("end"->>'dateTime')::timestamptz
        WHEN "end"->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (("end"->>'date')::date)::timestamp AT TIME ZONE 'UTC'
      END,
      original_start_at = CASE
        WHEN original_start_time->>'dateTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' THEN (original_start_time->>'dateTime')::timestamptz
        WHEN original_start_time->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ((original_start_time->>'date')::date)::timestamp AT TIME ZONE 'UTC'
      END
    WHERE start IS NOT NULL OR "end" IS NOT NULL OR original_start_time IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_app_calendar_events_start_at
      ON app_calendar.events (org_id, start_at);
    CREATE INDEX IF NOT EXISTS idx_app_calendar_events_end_at
      ON app_calendar.events (org_id, end_at);
    CREATE INDEX IF NOT EXISTS idx_app_calendar_events_original_start_at
      ON app_calendar.events (org_id, original_start_at) WHERE recurring_event_id IS NOT NULL;
  END IF;
END $$;
