-- SPDX-License-Identifier: FSL-1.1-ALv2
-- agent_runs_agent_org_fk (0074) is the composite key (agent_id, org_id) ->
-- kernel.agents (id, org_id) with a bare ON DELETE SET NULL. On a composite
-- key that nulls EVERY referencing column, org_id included, and org_id is NOT
-- NULL: deleting any agent that ever ran fails, so erasing a user whose
-- personal agent ran (account deletion) rolled back with a 500.
--
-- The column list form, ON DELETE SET NULL (agent_id), nulls the agent alone,
-- as audit_log, messages, approval_requests and scope_requests already do. No
-- other foreign key in the schema has the defect
-- (agent-org-fk.test.ts, "no SET NULL or SET DEFAULT foreign key ...").
--
-- The key's columns and target do not change, so every existing row already
-- satisfies it. The drop takes ACCESS EXCLUSIVE on agent_runs and kernel.agents
-- until the migration commits, so the swap is held for one index-backed
-- validation scan of agent_runs (NOT VALID then VALIDATE, as the safety check
-- expects for a new key); lock_timeout bounds the wait for the locks.
-- Re-runnable: dropped if present, then re-added.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: replaced in the same transaction by the same key with a narrower delete rule; the previous release relies only on the key itself
ALTER TABLE kernel.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_agent_org_fk;
--> statement-breakpoint
-- expand-safe: the same columns and target as the key it replaces, so every row the previous release writes is accepted
ALTER TABLE kernel.agent_runs
  ADD CONSTRAINT agent_runs_agent_org_fk
  FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
  ON DELETE SET NULL (agent_id) NOT VALID;
--> statement-breakpoint
-- expand-safe: validates the key added above; every existing row satisfied the identical key it replaced
ALTER TABLE kernel.agent_runs VALIDATE CONSTRAINT agent_runs_agent_org_fk;
