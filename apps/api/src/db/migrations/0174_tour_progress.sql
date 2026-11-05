-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.tour_progress: one row per (org, user, guided tour), the person's
-- progress through a tour (packages/shared/src/tours). Server-side so a tour
-- survives a reload and a change of device.
--
--  - beat_id is the current beat; the index is re-derived from the tour's
--    effective beats on every read, so a beat appearing or disappearing (an app
--    installed mid-tour) never moves the person onto another beat. beat_index
--    is the index last written, kept for the CLI's progress lines. beat_id is
--    null once the tour is completed.
--  - beat_states: {"<beatId>": "done" | "skipped"}.
--  - source: where the tour was started (the CLI, the help menu, the demo).
--
-- The person's own: RLS lets a user read and write only their own rows in their
-- own org. The completion consumer (an outbox durable consumer) and the CLI
-- read and advance rows through the privileged connection. Re-runnable.
CREATE TABLE IF NOT EXISTS kernel.tour_progress (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  tour_id text NOT NULL CHECK (char_length(tour_id) BETWEEN 3 AND 120),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
  beat_id text NULL CHECK (beat_id IS NULL OR char_length(beat_id) BETWEEN 1 AND 120),
  beat_index integer NOT NULL DEFAULT 0 CHECK (beat_index >= 0),
  beat_states jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(beat_states) = 'object'),
  source text NOT NULL CHECK (source IN ('cli', 'help', 'demo')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, tour_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tour_progress_active_idx
  ON kernel.tour_progress (org_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tour_progress_user_idx ON kernel.tour_progress (user_id);
--> statement-breakpoint
ALTER TABLE kernel.tour_progress ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.tour_progress FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.tour_progress TO liaison_rls, liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS tour_progress_self ON kernel.tour_progress;
--> statement-breakpoint
CREATE POLICY tour_progress_self ON kernel.tour_progress FOR ALL TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );
