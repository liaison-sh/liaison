-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_memory.path backfill (P4m-T08), plus the partial unique index
-- that 0081 deliberately left to this file.
--
-- Rows migrate 1:1 into the tree: the reserved `_index` row becomes MEMORY.md,
-- every other row becomes `<type>/<name>.md`. Nothing else moves, no row is
-- rewritten, no row is dropped.
--
-- The index is PARTIAL on `path IS NOT NULL` so a row written by an older
-- build, before the writer learned to set a path, is never refused; it is also
-- the only place this index is created (0081's header says so).

UPDATE kernel.agent_memory SET path = 'MEMORY.md'
 WHERE type = '_index' AND path IS NULL;
--> statement-breakpoint

UPDATE kernel.agent_memory SET path = type || '/' || name || '.md'
 WHERE type <> '_index' AND path IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_org_owner_path_idx
  ON kernel.agent_memory (org_id, owner_agent_id, path)
  WHERE path IS NOT NULL;
