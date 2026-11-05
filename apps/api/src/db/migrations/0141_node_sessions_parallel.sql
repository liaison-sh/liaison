-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Node sessions, parallel runs and steering (P3 of the Sessions app).
--
--  - L2: a node holds several running jobs at once; the one-running index goes.
--    The server caps them per node instead (D35): max_live_sessions (4) and
--    max_live_background (2, routine and agent_tag runs).
--  - A job may resume an existing session (D36): resume_after says why
--    (the node went offline, a message arrived after the end, the process
--    crashed, a level change), resume_command_id the message that woke it.
--  - The node pulls its unacked commands by session and seq.
DROP INDEX IF EXISTS kernel.node_jobs_one_running_per_node_idx;
--> statement-breakpoint
ALTER TABLE kernel.nodes
  ADD COLUMN IF NOT EXISTS max_live_sessions integer NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS max_live_background integer NOT NULL DEFAULT 2;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'nodes_live_caps_check' AND conrelid = 'kernel.nodes'::regclass
  ) THEN
    ALTER TABLE kernel.nodes ADD CONSTRAINT nodes_live_caps_check CHECK (
      max_live_sessions BETWEEN 1 AND 16
      AND max_live_background BETWEEN 0 AND max_live_sessions
    );
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs
  ADD COLUMN IF NOT EXISTS resume_after text NULL,
  ADD COLUMN IF NOT EXISTS resume_command_id uuid NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_jobs_resume_after_check' AND conrelid = 'kernel.node_jobs'::regclass
  ) THEN
    ALTER TABLE kernel.node_jobs ADD CONSTRAINT node_jobs_resume_after_check
      CHECK (resume_after IS NULL OR resume_after IN ('offline', 'message', 'crash', 'level'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_session_commands_unacked_idx
  ON kernel.node_session_commands (session_id, seq) WHERE acked_at IS NULL;
