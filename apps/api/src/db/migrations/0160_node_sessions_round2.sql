-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Node sessions, round 2 (Sessions app signals).
--
--  - A session whose turn ended without an explicit "done" signal ends
--    `needs_you`: the status check gains it.
--  - effort: the reasoning effort chosen for the session (null = the model's
--    default). The check is the shared EFFORT_LEVELS vocabulary.
--  - muted: the owner silenced this session's notifications.
--  - tokens_cache_read, tokens_cache_write_5m, tokens_cache_write_1h: the
--    session's cumulative cache split from the node's usage events (D23);
--    tokens_in / tokens_out keep their meaning for older clients.
--  - reason_code: the row's reason line as a code the client localises
--    (another Claude Code drives the session, its hard token limit), set by
--    the event fold; null when the session's own words are the reason.
--  - node_jobs.node_protocol: the protocol version the claiming node announced,
--    so the server knows which commands that node understands.
-- Grants are untouched: writes go through the privileged connection (0140).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_status_check' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions DROP CONSTRAINT node_sessions_status_check;
  END IF;
  ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_status_check CHECK (status IN (
    'queued', 'running', 'waiting', 'paused', 'done', 'needs_you', 'stopped', 'failed'
  ));
END $$;
--> statement-breakpoint
ALTER TABLE kernel.node_sessions
  ADD COLUMN IF NOT EXISTS effort text NULL,
  ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tokens_cache_read bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_cache_write_5m bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_cache_write_1h bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reason_code text NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'node_sessions_effort_check' AND conrelid = 'kernel.node_sessions'::regclass
  ) THEN
    ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_effort_check
      CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs
  ADD COLUMN IF NOT EXISTS node_protocol integer NULL;
