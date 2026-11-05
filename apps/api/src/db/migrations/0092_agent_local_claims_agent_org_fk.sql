-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_local_claims.agent_id joins the composite-key class.
--
-- 0070 (audit_log), 0071 (approval_requests), 0072 (routines, skills,
-- agent_memory, agent_skill_index, agent_knowledge_pointers), 0074
-- (agent_runs), 0075 (thread_participants) and 0076 (messages) closed this
-- class table by table: an org-scoped row naming kernel.agents through a
-- SINGLE-column foreign key checks EXISTENCE only, so org A's row happily
-- names org B's agent. 0090 created agent_local_claims with exactly that
-- single-column key, which is a claim row in one org handing the local runtime
-- of another org's agent to a machine, and the whole point of the row is to
-- tell the server to stand down. The standing guard
-- (db/schema/kernel/agent-org-fk.test.ts, "every org-scoped table referencing
-- kernel.agents uses a composite key") has been red since 0090 landed.
--
-- ON DELETE CASCADE is PRESERVED, exactly as 0090 wrote it: a lease is about a
-- live agent, so deleting the agent takes its claims with it. agent_id is NOT
-- NULL, so SET NULL is not expressible here anyway.
--
-- The key reuses the UNIQUE (id, org_id) on kernel.agents added by 0070
-- (`agents_id_org_uk`); it is NOT re-added, and the guard below fails loudly
-- if it is absent rather than silently creating a second one.
--
-- NOT VALID then VALIDATE, for 0070's reasons: NOT VALID takes a brief lock
-- and already enforces every new row, and VALIDATE scans under SHARE UPDATE
-- EXCLUSIVE without blocking writers. A claim lives about a minute, so there
-- is in practice nothing to validate.
--
-- Every statement is re-runnable, following the 0072/0074 convention.

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
     WHERE conname = 'agent_local_claims_agent_org_fk'
       AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agent_local_claims
      ADD CONSTRAINT agent_local_claims_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.agent_local_claims VALIDATE CONSTRAINT agent_local_claims_agent_org_fk;
--> statement-breakpoint
ALTER TABLE kernel.agent_local_claims
  DROP CONSTRAINT IF EXISTS agent_local_claims_agent_id_fkey;
--> statement-breakpoint

-- The composite key's delete-time lookup is (agent_id, org_id), and neither
-- existing index leads with agent_id (the unique one is (thread_id, agent_id),
-- the other (thread_id, expires_at)), so without this every agent delete would
-- sequentially scan the claims table. Same reasoning as 0072's
-- routines_owner_agent_idx.
CREATE INDEX IF NOT EXISTS agent_local_claims_agent_org_idx
  ON kernel.agent_local_claims (agent_id, org_id);
