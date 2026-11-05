-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Demo world marks: one row per world beat of a demo scenario that has run (or
-- is running) in a demo org.
--
-- A world beat injects a live event into a demo org (a customer's ticket, a
-- teammate's comment, an order) while its owner watches the guided tour. It
-- runs at most once per (org, tour, beat): the injector claims the row first
-- (state 'claimed'), sets 'succeeded' when it finished, and deletes the claim
-- when it failed, so a retry can claim it again. A claim older than two
-- minutes is stale (its process died) and may be claimed again. A beat whose
-- mark is 'succeeded' completes on re-entry without injecting again.
--
-- Worker bookkeeping, never org data a person reads: written and read only
-- through the privileged connection. liaison_rls gets nothing; RLS is forced
-- with no policy as a second wall. Re-runnable.
CREATE TABLE IF NOT EXISTS kernel.demo_world_marks (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  tour_id text NOT NULL CHECK (char_length(tour_id) BETWEEN 3 AND 128),
  beat_id text NOT NULL CHECK (char_length(beat_id) BETWEEN 1 AND 64),
  state text NOT NULL CHECK (state IN ('claimed', 'succeeded')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, tour_id, beat_id)
);
--> statement-breakpoint
ALTER TABLE kernel.demo_world_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.demo_world_marks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.demo_world_marks FROM liaison_rls;
