-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The agent that asked.
--
-- A scope request filed from an agent turn recorded only `requested_by`, the
-- HUMAN whose turn it was, so the admin row credited the person and named no
-- agent at all. `approval_requests.agent_id` already carries exactly this fact
-- (spec-security.md, audit identity: "`approval_requests` gains the same
-- `agentId` column alongside its existing `requestedBy`/`actorId`"); this is
-- the same column on the same kind of row.
--
-- Additive and nullable: a request a human files by hand carries none, which is
-- the honest answer, not a default.
ALTER TABLE kernel.scope_requests
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES kernel.agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS scope_requests_agent_idx
  ON kernel.scope_requests (org_id, agent_id);
