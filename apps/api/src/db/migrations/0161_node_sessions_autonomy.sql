-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Node sessions, wave 2 (autonomy and Atelier).
--
--  - autonomy: whether the session asks the person (`guided`, the default) or
--    decides with sensible defaults on its own (`autonomous`). The check is the
--    shared AUTONOMY_LEVELS vocabulary.
--  - finish_with: how the session's work ends (`pr`, `commit`, `none`); null
--    means a pull request when the folder is a repository, nothing otherwise
--    (the node decides). The check is the shared FINISH_WITH vocabulary.
--  - atelier: the last valid Atelier state the node reported, so the list, the
--    phone header and the agent tools need no event read.
--  - posted_back_ended_at: the `ended_at` whose result was posted back into
--    the dispatching thread, claimed atomically so each end posts once.
-- Grants are untouched: writes go through the privileged connection (0140).
ALTER TABLE kernel.node_sessions
  ADD COLUMN IF NOT EXISTS autonomy text NOT NULL DEFAULT 'guided',
  ADD COLUMN IF NOT EXISTS finish_with text NULL,
  ADD COLUMN IF NOT EXISTS atelier jsonb NULL,
  ADD COLUMN IF NOT EXISTS posted_back_ended_at timestamptz NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_autonomy_check' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_autonomy_check
      CHECK (autonomy IN ('guided', 'autonomous'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_finish_with_check' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_finish_with_check
      CHECK (finish_with IS NULL OR finish_with IN ('pr', 'commit', 'none'));
  END IF;
END $$;
