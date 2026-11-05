-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_memory gains the plaintext memory tree's columns (P4m-T04).
--
-- The tree is Claude Code's shape: one Markdown file per memory row, an index
-- file, and a YAML frontmatter block rendered FROM these columns on read and
-- parsed back INTO them on write. The columns stay the source of truth for RLS
-- and scopes; the model only ever sees Markdown, so nothing a body claims about
-- itself can widen a row's reach.
--
-- `path` is NULLABLE and column only here. The partial unique index on
-- (org_id, owner_agent_id, path) belongs to the backfill migration
-- (0083_agent_memory_path_backfill) and to nothing else: a unique index over a
-- column that is null on every row is dead weight, and two migrations creating
-- the same index is a hard failure on the second run.
--
-- supersedes_id is ON DELETE SET NULL, deliberately, and neither RESTRICT nor
-- CASCADE: account erasure deletes a user's memory rows in one pass, so a
-- RESTRICT would block it on the supersession chain, while a CASCADE would take
-- the SURVIVING current row down with the superseded one it points at.
--
-- source_thread_id carries a real foreign key (SET NULL: a deleted thread costs
-- the provenance, never the memory). source_message_id and the two episode
-- range columns are plain uuids: a message row can be deleted by a human and
-- the artefact built from it is then marked stale and rebuilt, which is a
-- product decision (P4m-T23), not a referential one.
--
-- Every statement is re-runnable, following the 0033/0045/0049/0072 convention.

ALTER TABLE kernel.agent_memory
  ADD COLUMN IF NOT EXISTS path text,
  ADD COLUMN IF NOT EXISTS last_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_recalled_at timestamptz,
  ADD COLUMN IF NOT EXISTS recall_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_thread_id uuid,
  ADD COLUMN IF NOT EXISTS source_message_id uuid,
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'agent',
  ADD COLUMN IF NOT EXISTS episode_from_message_id uuid,
  ADD COLUMN IF NOT EXISTS episode_to_message_id uuid;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_memory_supersedes_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agent_memory
      ADD CONSTRAINT agent_memory_supersedes_fk
      FOREIGN KEY (supersedes_id) REFERENCES kernel.agent_memory (id) ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_memory_source_thread_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agent_memory
      ADD CONSTRAINT agent_memory_source_thread_fk
      FOREIGN KEY (source_thread_id) REFERENCES kernel.threads (id) ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

-- The type vocabulary gains exactly one member, `episode`. A CHECK cannot be
-- altered in place, so it is dropped and recreated with the same name.
ALTER TABLE kernel.agent_memory DROP CONSTRAINT IF EXISTS agent_memory_type_check;
--> statement-breakpoint
ALTER TABLE kernel.agent_memory
  ADD CONSTRAINT agent_memory_type_check
  CHECK (type IN ('user','feedback','project','reference','episode','_index'));
--> statement-breakpoint

ALTER TABLE kernel.agent_memory DROP CONSTRAINT IF EXISTS agent_memory_source_kind_check;
--> statement-breakpoint
ALTER TABLE kernel.agent_memory
  ADD CONSTRAINT agent_memory_source_kind_check
  CHECK (source_kind IN ('agent','human','consolidation','migration'));
