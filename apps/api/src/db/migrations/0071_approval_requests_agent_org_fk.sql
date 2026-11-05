-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.approval_requests.agent_id must name an agent OF THE ROW'S OWN ORG,
-- exactly as kernel.audit_log.agent_id does since 0070. 0063 gave this column a
-- SINGLE-column foreign key, which checks existence only, so org A's approval
-- row accepted org B's agent while the SAME id was rejected in audit_log.
--
-- That asymmetry is not cosmetic. The persisted agent seeds the re-entry frame
-- when the approval is decided (the approved handler reads the column and never
-- re-resolves it), so a cross-org id lands on the frame and then FK-fails EVERY
-- audit insert the re-entry produces: the approved action runs with its audit
-- trail refusing to record it.
--
-- The guard is the same COMPOSITE foreign key 0070 uses,
-- (agent_id, org_id) -> agents (id, org_id), rather than a check in the writer:
-- three separate sites insert approval rows (the synthetic policy row, the
-- staged request and the sequenced step), and the column is also written by
-- hand in fixtures and backfills, so a code-side guard would leave those
-- unguarded.
--
-- ON DELETE SET NULL (agent_id) names the column list (Postgres 15+), so
-- deleting an agent still nulls agent_id and keeps the approval row, exactly as
-- 0063 behaved, and never touches the NOT NULL org_id. Agents are archived
-- rather than deleted, so in normal operation the action never fires; the hard
-- deletes are org deletion (approval rows cascade with the org anyway) and the
-- personal-agent delete during user erasure, which must not be blocked by the
-- agent's approval history and must not remove that history.
--
-- Added NOT VALID and validated in a second step, for 0070's reasons: NOT VALID
-- takes a brief lock and already enforces every new row, and VALIDATE then scans
-- under SHARE UPDATE EXCLUSIVE, which does not block writers.
--
-- The UNIQUE (id, org_id) on kernel.agents that this key references already
-- exists from 0070 (`agents_id_org_uk`), so it is NOT added again; the guarded
-- lookup below only fails loudly if it is somehow absent.
--
-- Re-runnable: each step is guarded by a catalog lookup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_id_org_uk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    RAISE EXCEPTION 'kernel.agents is missing agents_id_org_uk (migration 0070); apply 0070 first';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'approval_requests_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.approval_requests
      ADD CONSTRAINT approval_requests_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE SET NULL (agent_id)
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.approval_requests VALIDATE CONSTRAINT approval_requests_agent_org_fk;
--> statement-breakpoint
-- The single-column FK from 0063 is now redundant: the composite one is strictly
-- stronger and carries the same ON DELETE behaviour for agent_id.
ALTER TABLE kernel.approval_requests DROP CONSTRAINT IF EXISTS approval_requests_agent_id_fkey;
