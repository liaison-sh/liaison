-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The personal agent is not called "Liaison".
--
-- Liaison is the PRODUCT. There is no entity in it by that name, so a member
-- whose own agent was stamped with the old default read their sidebar, their
-- agent page header and every mention pill as the application talking to them
-- rather than an agent of theirs.
--
-- New rows carry "Personal agent" (personal-agent.ts, via the shared
-- PERSONAL_AGENT_DISPLAY_NAME). This renames the ones already out there, and
-- only those: an agent whose owner has renamed it keeps that name, and a role
-- or system agent is never touched (`kind = 'personal'` is what marks a
-- personal agent, alongside the owner_user_id the table's check constraint
-- ties to it).
UPDATE kernel.agents
  SET display_name = 'Personal agent', updated_at = now()
  WHERE kind = 'personal' AND display_name = 'Liaison';
