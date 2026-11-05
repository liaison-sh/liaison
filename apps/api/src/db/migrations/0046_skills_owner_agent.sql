-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.skills.owner_agent_id: the "Migration sequencing" design call moves
-- skill ownership from (orgId, authorUserId) to a named agent. This
-- migration only adds the column, nullable and unenforced, and moves the
-- uniqueness constraint to (owner_agent_id, name); it does not backfill or
-- drop authorUserId, which stays as provenance (per A15).
--
-- Nullable on purpose (sequencing note): a later task backfills every
-- existing skill's owner_agent_id from its authorUserId (or an org's default
-- role agent for authorUserId IS NULL rows) before any NOT NULL is added.
-- Until that backfill lands, rows with owner_agent_id IS NULL are exempt
-- from the new unique index (a NULL in a unique index never conflicts with
-- another NULL), which is intentionally permissive during the transition.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, DROP
-- INDEX IF EXISTS, following the convention 0030/0033 established.

ALTER TABLE kernel.skills
  ADD COLUMN IF NOT EXISTS owner_agent_id uuid REFERENCES kernel.agents(id);
--> statement-breakpoint

DROP INDEX IF EXISTS kernel.skills_unique_owner_name_idx;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS skills_unique_owner_agent_name_idx
  ON kernel.skills (owner_agent_id, name);
