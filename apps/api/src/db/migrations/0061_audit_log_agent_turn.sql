-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P2b-T03: kernel.audit_log carries the agent-turn identity and security
-- context (A11). agent_id is the acting agent, independent of the human
-- actor_id; requester_user_id is the human who caused the turn;
-- room_member_snapshot, effective_scope and disclosure_list record the turn's
-- security context. All five are nullable with no default, so ADD COLUMN is a
-- metadata-only change, every existing row reads null, and every existing
-- writer (which names none of them) is unaffected.
-- agent_id REFERENCES kernel.agents ON DELETE SET NULL: agents are archived,
-- not deleted, so in normal operation the action never fires. The only hard
-- deletes are org deletion (audit rows cascade away with the org anyway) and
-- the personal-agent delete during user erasure, which must not be blocked by
-- the agent's audit history and must not remove that history.
-- Re-runnable: IF NOT EXISTS throughout.
ALTER TABLE kernel.audit_log
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES kernel.agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requester_user_id uuid,
  ADD COLUMN IF NOT EXISTS room_member_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS effective_scope text[],
  ADD COLUMN IF NOT EXISTS disclosure_list uuid[];
--> statement-breakpoint
-- Serves the SET NULL lookup on agent delete and the audit search by agent.
CREATE INDEX IF NOT EXISTS "audit_log_agent_idx"
  ON "kernel"."audit_log" USING btree ("agent_id")
  WHERE agent_id IS NOT NULL;
