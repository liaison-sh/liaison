-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Demo world marks belong to one run of a scenario.
--
-- A world beat runs once per RUN of its scenario, not once per org: starting
-- the scenario again (kernel.tour_progress.started_at moves) gives a fresh
-- run whose world beats inject a new live event. `run_started_at` is the
-- started_at of the run the mark belongs to; a mark of an earlier run is
-- superseded on the next claim, and `generation` counts the runs, so each
-- run's injected entity gets its own idempotency key (a new ticket, email or
-- order) while a reload or a concurrent pass within one run still injects
-- nothing twice. A mark written before this migration has no run: it belongs
-- to the run that was current when it was claimed. Re-runnable.
ALTER TABLE kernel.demo_world_marks
  ADD COLUMN IF NOT EXISTS run_started_at timestamptz;
--> statement-breakpoint
ALTER TABLE kernel.demo_world_marks
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0);
