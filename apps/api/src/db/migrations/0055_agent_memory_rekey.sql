-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_user_memory -> kernel.agent_memory: re-key memory ownership
-- from the human user_id to the named agent (owner_agent_id), the same move
-- 0046/0048 made for skills/routines. user_id stays as the slice-1b bridge
-- (nullable now: a role or system agent's memory row has no owning human).
--
-- Index choice (documented per the blueprint's requirement that the choice
-- be explicit and not contradict another unique index): we DROP the old
-- (org_id, user_id, type, name) unique index and CREATE a new one on
-- (org_id, owner_agent_id, type, name). We do NOT keep both, since the two
-- keys would allow the same logical memory to be duplicated under one key
-- while blocked under the other as ownership migrates.
--
-- RLS note (deliberate, do NOT touch here): Postgres carries a table's RLS
-- policies across RENAME TO, so the pre-existing agent_user_memory_select/
-- insert/update/delete policies (0000_initial.sql:2042-2065, all keyed on
-- user_id = current_user_id) stay attached to kernel.agent_memory unchanged
-- after this migration. Replacing those policies with owner_agent_id-aware
-- versions is the NEXT task (T10); doing it now would break the existing
-- memory suites in the same step as the rekey.
--
-- RE-RUNNABLE: IF EXISTS / IF NOT EXISTS throughout, following the
-- convention 0033/0045/0054 established for a journal `when` raised above an
-- already-deployed highwater re-running this file.

ALTER TABLE IF EXISTS kernel.agent_user_memory RENAME TO agent_memory;
--> statement-breakpoint

-- Postgres does not rename a table's CHECK constraint on RENAME TO, so the
-- old name would otherwise live on forever; rename it explicitly to keep the
-- live object consistent with the new table name (and with the Drizzle
-- declaration in agent-memory.ts). Guarded with a catalog check (rather than
-- a bare ALTER) because Postgres has no RENAME CONSTRAINT IF EXISTS, and a
-- re-run after this has already landed must stay a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_user_memory_type_check'
  ) THEN
    ALTER TABLE kernel.agent_memory
      RENAME CONSTRAINT agent_user_memory_type_check TO agent_memory_type_check;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE kernel.agent_memory
  ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE kernel.agent_memory
  ADD COLUMN IF NOT EXISTS owner_agent_id uuid REFERENCES kernel.agents(id);
--> statement-breakpoint

ALTER TABLE kernel.agent_memory
  ADD COLUMN IF NOT EXISTS required_scopes text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint

-- Backfill (spec-agents.md:111): every existing row's owner becomes its
-- user's personal agent, 1:1, no loss. Matches on org_id too since a user's
-- personal agent always belongs to the same org as the user.
UPDATE kernel.agent_memory m
SET owner_agent_id = a.id
FROM kernel.agents a
WHERE a.owner_user_id = m.user_id
  AND a.kind = 'personal'
  AND a.org_id = m.org_id
  AND m.owner_agent_id IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS kernel.agent_user_memory_org_user_type_name_idx;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_org_owner_type_name_idx
  ON kernel.agent_memory (org_id, owner_agent_id, type, name);
--> statement-breakpoint

-- The non-unique (org_id, user_id) lookup index survives the rekey unchanged
-- in shape, but its name still says agent_user_memory — rename it so the
-- live object matches the Drizzle declaration (same drift class the
-- skills_unique_owner_name_idx bug was).
ALTER INDEX IF EXISTS kernel.agent_user_memory_user_idx RENAME TO agent_memory_user_idx;
