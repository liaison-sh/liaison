-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A pending scope request is deduplicated per requesting AGENT, not per user.
--
-- Approving a request now widens the scope ceiling of the agent the row names
-- and announces the decision in the conversation it came from. Deduplicated on
-- (org, user, scopes) alone, a second agent of the same user asking for the
-- same scope got the first agent's pending row back: the admin's approval then
-- widened the wrong agent and told the wrong conversation, and the agent that
-- asked stayed locked. A user's own request (no agent) keeps its own slot.
-- Re-runnable.
DROP INDEX IF EXISTS kernel.scope_requests_pending_dedup_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS scope_requests_pending_dedup_idx
  ON kernel.scope_requests (
    org_id,
    requested_by,
    (COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    requested_scopes
  )
  WHERE status = 'pending';
