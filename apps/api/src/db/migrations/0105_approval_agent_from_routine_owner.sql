-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An approval a routine raised names the routine's agent.
--
-- `approval_requests.agent_id` (0063) is the agent whose turn proposed the
-- gated call, and it is what the approval card names as the requester for a
-- role or system agent. Rows a routine staged before the column was written
-- (and before routines were owned by an agent) carry NULL there, so the card
-- fell back to the routine's human owner: a ticket draft the @support routine
-- wrote read "requested by <the owner's name>".
--
-- The routine is recorded on the row (`metadata.originRoutineId`) and the
-- routine records its owner agent (`owner_agent_id`, A15), so the proposing
-- agent is known for those rows. Only NULL agent ids are filled, and only
-- from an agent of the row's own org (the composite FK of 0071 would refuse
-- anything else). Idempotent: a second run matches nothing.

UPDATE kernel.approval_requests ar
   SET agent_id = r.owner_agent_id
  FROM kernel.routines r
 WHERE ar.agent_id IS NULL
   AND ar.metadata ? 'originRoutineId'
   AND ar.metadata->>'originRoutineId' ~ '^[0-9a-fA-F-]{36}$'
   AND r.id = (ar.metadata->>'originRoutineId')::uuid
   AND r.org_id = ar.org_id
   AND r.owner_agent_id IS NOT NULL;
