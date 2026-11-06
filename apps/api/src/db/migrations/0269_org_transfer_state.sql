-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Moving one org from one instance to another (modules/org/transfer-state/).
--
-- kernel.organizations gains the org's transfer state, NULL on every org that
-- is not moving (as every row was before):
--   draining  the source stops starting agent turns and picking up the org's
--             jobs and events; writes are still accepted;
--   frozen    the source refuses every write of the org (503 `org_moving`),
--             reads are served;
--   incoming  the target holds a copy that serves nothing until the move commits;
--   moved     the source copy after the commit: every request refused.
-- `transfer_id` names the move (only that move may change the state), and
-- `transfer_at` is when the state was entered (the freeze deadline counts from it).
--
-- kernel.restore_drill_markers: one row written at the start of a restore
-- drill, in the same transaction that records the expected counts; the drill
-- restores to that row's transaction. Instance-wide (no org column),
-- privileged pool only.
--
-- Additive and nullable, every statement re-runnable: the previous release
-- never reads or writes the columns or the table.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.organizations ADD COLUMN IF NOT EXISTS transfer_state text;
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.organizations ADD COLUMN IF NOT EXISTS transfer_id uuid;
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.organizations ADD COLUMN IF NOT EXISTS transfer_at timestamptz;
--> statement-breakpoint
-- expand-safe: drops only this file's own constraint, which no release before this one has
ALTER TABLE kernel.organizations DROP CONSTRAINT IF EXISTS organizations_transfer_state_check;
--> statement-breakpoint
-- expand-safe: checks only the three columns added above, which the previous release never writes
ALTER TABLE kernel.organizations ADD CONSTRAINT organizations_transfer_state_check
  CHECK (
    (transfer_state IS NULL AND transfer_id IS NULL AND transfer_at IS NULL)
    OR (
      transfer_state IN ('draining', 'frozen', 'incoming', 'moved')
      AND transfer_id IS NOT NULL
      AND transfer_at IS NOT NULL
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE kernel.organizations VALIDATE CONSTRAINT organizations_transfer_state_check;
--> statement-breakpoint
-- Every process reads the few moving orgs once a second: a partial index keeps
-- that read off the whole table. Every row is NULL here, so the partial index
-- starts empty.
-- index-build: kernel.organizations 10000 20
CREATE INDEX IF NOT EXISTS organizations_transfer_state_idx
  ON kernel.organizations (id) WHERE transfer_state IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.restore_drill_markers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE kernel.restore_drill_markers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.restore_drill_markers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.restore_drill_markers FROM liaison_rls;
