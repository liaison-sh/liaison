-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Node sessions, D53: an import may come from one of a shared repository's
-- own git worktrees that lives outside the shared folder.
--
--  - worktree_path: that worktree's real path on the node, display and claim
--    only (the node accepts it only among the worktrees its own
--    `git worktree list` names for the shared folder); cwd_subdir is then
--    relative to it. NULL: relative to the shared folder, and for every
--    session that is not an import.
-- Grants are untouched: writes go through the privileged connection (0140).
ALTER TABLE kernel.node_sessions ADD COLUMN IF NOT EXISTS worktree_path text NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_worktree_path_check'
       AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_worktree_path_check
      CHECK (worktree_path IS NULL
        OR (source = 'import' AND char_length(worktree_path) BETWEEN 2 AND 4096));
  END IF;
END $$;
