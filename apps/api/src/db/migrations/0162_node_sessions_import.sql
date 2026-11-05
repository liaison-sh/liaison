-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Node sessions, wave 3 (session import and the follow host).
--
--  - source 'import' on sessions and jobs: a Claude Code session the owner
--    started elsewhere (VS Code, the terminal) brought into Liaison.
--  - node_jobs.kind 'follow': a job that only reads a session's transcript and
--    streams it; it never resumes and never writes. It carries no permission
--    mode, and an import's follow may have no thread (like an app job).
--  - import_mode: `follow` (read only) or `take_over` (steerable).
--  - import_sdk_session_id: the imported CLI session id, immutable;
--    sdk_session_id starts equal and may move with later runs.
--  - import_from: which Claude Code started it (`vscode`, `cli`, `other`).
--  - cwd_subdir: the recorded cwd relative to the shared folder ('' for the
--    folder itself), display only.
--  - following: a follow job of this session holds its lease.
--  - import_replay_offset: the byte offset where a Take over's replay stopped,
--    consumed and cleared by the first resume's claim.
--  - node_sessions_import_shape: the four import columns are all set for an
--    import and, with the replay offset, all NULL otherwise.
--  - node_sessions_import_once: one Liaison session per imported CLI session
--    per owner.
-- Grants are untouched: writes go through the privileged connection (0140).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_source_check' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions DROP CONSTRAINT node_sessions_source_check;
  END IF;
  ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_source_check
    CHECK (source IN ('dispatch', 'app', 'routine', 'agent_tag', 'import'));
END $$;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_source_check;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ADD CONSTRAINT node_jobs_source_check
  CHECK (source IN ('routine', 'chat', 'agent_tag', 'dispatch', 'app', 'import'));
--> statement-breakpoint
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_kind_check;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ADD CONSTRAINT node_jobs_kind_check
  CHECK (kind IN ('unattended', 'interactive', 'follow'));
--> statement-breakpoint
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_permission_mode_check;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ADD CONSTRAINT node_jobs_permission_mode_check CHECK (
  (kind IN ('unattended', 'follow') AND permission_mode IS NULL)
  OR (kind = 'interactive' AND permission_mode IN ('auto', 'manual', 'edit', 'plan'))
);
--> statement-breakpoint
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_thread_required;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ADD CONSTRAINT node_jobs_thread_required
  CHECK (thread_id IS NOT NULL OR source IN ('app', 'import'));
--> statement-breakpoint
ALTER TABLE kernel.node_sessions
  ADD COLUMN IF NOT EXISTS import_mode text NULL,
  ADD COLUMN IF NOT EXISTS import_sdk_session_id text NULL,
  ADD COLUMN IF NOT EXISTS import_from text NULL,
  ADD COLUMN IF NOT EXISTS cwd_subdir text NULL,
  ADD COLUMN IF NOT EXISTS following boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS import_replay_offset bigint NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_import_mode_check' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_import_mode_check
      CHECK (import_mode IS NULL OR import_mode IN ('follow', 'take_over'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_import_sdk_session_id_check'
       AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_import_sdk_session_id_check
      CHECK (import_sdk_session_id IS NULL OR import_sdk_session_id
        ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_import_from_check' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_import_from_check
      CHECK (import_from IS NULL OR import_from IN ('vscode', 'cli', 'other'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_cwd_subdir_len' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_cwd_subdir_len
      CHECK (cwd_subdir IS NULL OR char_length(cwd_subdir) <= 1024);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_import_replay_offset_check'
       AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_import_replay_offset_check
      CHECK (import_replay_offset IS NULL OR import_replay_offset >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_import_shape' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_import_shape CHECK (
      CASE WHEN source = 'import'
        THEN import_mode IS NOT NULL AND import_sdk_session_id IS NOT NULL
         AND import_from IS NOT NULL AND cwd_subdir IS NOT NULL
        ELSE import_mode IS NULL AND import_sdk_session_id IS NULL AND import_from IS NULL
         AND cwd_subdir IS NULL AND import_replay_offset IS NULL
      END
    );
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS node_sessions_import_once
  ON kernel.node_sessions (org_id, owner_user_id, import_sdk_session_id)
  WHERE import_sdk_session_id IS NOT NULL;
--> statement-breakpoint
-- The session import protocol a node published with its capabilities (S40):
-- NULL (an older desktop) means the node cannot list or follow sessions.
ALTER TABLE kernel.node_capabilities ADD COLUMN IF NOT EXISTS import_protocol integer NULL;
