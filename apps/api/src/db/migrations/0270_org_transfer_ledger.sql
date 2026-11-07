-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The moves of an org this instance took part in (modules/org/transfer/).
--
-- One row per transfer: `in` on the instance that imported the org, `out` on
-- the one that exported it. Each instance keeps its own rows; they never travel
-- with the org (classification.ts excludes the table). The reverse-move rule
-- reads them: an instance accepts an org whose `moved` copy it still holds only
-- from the instance that imported it through that same transfer.
--
-- A new table the previous release never reads; every statement re-runnable.
CREATE TABLE IF NOT EXISTS kernel.org_transfer_ledger (
  transfer_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  -- The transfer this org arrived through, when the export side recorded one.
  arrived_via uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS org_transfer_ledger_org_idx ON kernel.org_transfer_ledger (org_id, created_at);
--> statement-breakpoint
ALTER TABLE kernel.org_transfer_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.org_transfer_ledger FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.org_transfer_ledger FROM liaison_rls;
