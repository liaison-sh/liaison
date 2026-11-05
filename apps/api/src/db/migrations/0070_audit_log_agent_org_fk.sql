-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.audit_log.agent_id must name an agent OF THE ROW'S OWN ORG. 0061's
-- single-column FK checks existence only, so org A's audit row could name org
-- B's agent and "what did this agent do" (A11) would answer with another org's
-- history.
--
-- The guard is a COMPOSITE foreign key (agent_id, org_id) -> agents (id, org_id)
-- rather than a check inside writeAuditLog, because two writers insert into
-- audit_log directly and deliberately (the Share anyway disclosure row and the
-- withheld-capability card row, both of which must fail loudly rather than be
-- swallowed by the best-effort path); a code-side guard would leave exactly
-- those two unguarded.
--
-- ON DELETE SET NULL (agent_id) names the column list (Postgres 15+), so
-- deleting an agent still nulls agent_id and keeps the audit row, exactly as
-- 0061 behaved, and never touches the NOT NULL org_id.
--
-- Added NOT VALID and validated in a second step: NOT VALID takes a brief lock
-- and already enforces every new row, and VALIDATE then scans under
-- SHARE UPDATE EXCLUSIVE, which does not block writers. Every pre-existing row
-- has a null agent_id (nothing wrote it before 0061), so validation finds
-- nothing to reject.
--
-- Re-runnable: each step is guarded by a catalog lookup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_id_org_uk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agents ADD CONSTRAINT agents_id_org_uk UNIQUE (id, org_id);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'audit_log_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.audit_log
      ADD CONSTRAINT audit_log_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE SET NULL (agent_id)
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.audit_log VALIDATE CONSTRAINT audit_log_agent_org_fk;
--> statement-breakpoint
-- The single-column FK is now redundant: the composite one is strictly
-- stronger and carries the same ON DELETE behaviour for agent_id.
ALTER TABLE kernel.audit_log DROP CONSTRAINT IF EXISTS audit_log_agent_id_fkey;
