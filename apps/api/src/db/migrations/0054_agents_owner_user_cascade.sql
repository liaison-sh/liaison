-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agents.owner_user_id: 0045 declared this FK ON DELETE SET NULL, but
-- agents_owner_user_id_personal_chk (same migration) requires
-- `(kind = 'personal') = (owner_user_id IS NOT NULL)`. Once T17
-- (personal-agent.ts) started auto-creating a personal agent for every user
-- at bootstrap, that combination became self-contradictory: hard-deleting a
-- user (the only real path — deleting an org deletes its users FIRST,
-- because `users_org_fk` is RESTRICT, no ON DELETE clause) cascades the
-- user's personal agent's owner_user_id to NULL while kind stays 'personal',
-- which the check constraint immediately rejects. Every org deletion that
-- had ever registered a single user (which is now every org, since
-- bootstrapRegister always creates one) failed.
--
-- Fix: CASCADE instead of SET NULL. Deleting a user deletes their personal
-- agent outright (role/system agents have owner_user_id always NULL and are
-- never affected by this FK). If that personal agent still owns a shared
-- routine or a cross-referenced skill, the existing RESTRICT on
-- routines.owner_agent_id / skills.owner_agent_id blocks the delete instead —
-- a louder, more correct failure than the silent check-constraint violation
-- this replaces.
--
-- RE-RUNNABLE: DROP CONSTRAINT IF EXISTS before the ADD, following the
-- convention 0033/0045 established for a journal `when` raised above an
-- already-deployed highwater re-running this file.

ALTER TABLE kernel.agents DROP CONSTRAINT IF EXISTS agents_owner_user_id_fkey;
--> statement-breakpoint

ALTER TABLE kernel.agents
  ADD CONSTRAINT agents_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
