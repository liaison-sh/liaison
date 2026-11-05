-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.skills lost ALL uniqueness for rows with no owner agent.
--
-- 0000_initial keyed skills UNIQUE on
-- (org_id, COALESCE(author_user_id, zero-uuid), name): one name per owner per
-- org, with the org-shared rows (author_user_id IS NULL) collapsed onto the
-- zero uuid so they could not duplicate either. 0046 DROPPED that index and
-- replaced it with UNIQUE (owner_agent_id, name), on a column it added
-- nullable, against a backfill its own comment says "a later task" would do.
-- No such migration ever landed: scripts/migrate-agents.ts backfills what it
-- can resolve and leaves every skill whose owner it cannot resolve at NULL.
--
-- A NULL never conflicts with another NULL in a unique index, so from 0046 on
-- an unowned skill had NO uniqueness at all: the same (org, author, name) can
-- be inserted without limit, and an ON CONFLICT DO NOTHING insert against it
-- (the shape every seeder and importer uses) silently duplicates instead of
-- being a no-op. The chaos org-shared skill seed, which is idempotent by
-- construction, grew three copies of each skill in one run.
--
-- This restores the ORIGINAL key for exactly the rows 0046 left uncovered, as
-- a PARTIAL unique index, so the two keys are disjoint: an owned row is unique
-- on (owner_agent_id, name), an unowned row on the pre-0046 triple. When the
-- owner backfill finally lands with its NOT NULL, this index covers nothing
-- and can be dropped with the column's nullability.
--
-- No duplicate can exist at this point in a production ledger: the pre-0046
-- index held until the same deploy that drops it, and this index is created in
-- that deploy. A long-lived dev database that has been writing unowned skills
-- since 0046 may already hold duplicates, and this index will refuse to build
-- there: that is the defect being reported, not a migration bug, and db-reset
-- is the answer.
CREATE UNIQUE INDEX IF NOT EXISTS skills_unique_unowned_author_name_idx
  ON kernel.skills
     (org_id, COALESCE(author_user_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE owner_agent_id IS NULL;
