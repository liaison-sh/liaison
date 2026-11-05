-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P2b-T04: kernel.approval_requests carries the acting agent identity (A11),
-- mirroring audit_log.agent_id (0061): an agent-originated approval is
-- independently queryable by agent id. Nullable with no default, so ADD
-- COLUMN is a metadata-only change, every existing row reads null, and every
-- existing writer (which names none of it) is unaffected.
-- agent_id REFERENCES kernel.agents ON DELETE SET NULL, same rationale as
-- audit_log.agent_id: agents are archived, not deleted, so in normal
-- operation the action never fires; the only hard deletes are org deletion
-- (approval_requests cascade away with the org anyway) and the personal-agent
-- delete during user erasure, which must not be blocked by the agent's
-- approval history and must not remove that history.
-- Re-runnable: IF NOT EXISTS throughout.
ALTER TABLE kernel.approval_requests
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES kernel.agents(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Serves the SET NULL lookup on agent delete and lookups by agent.
CREATE INDEX IF NOT EXISTS "approval_requests_agent_idx"
  ON "kernel"."approval_requests" USING btree ("agent_id")
  WHERE agent_id IS NOT NULL;
