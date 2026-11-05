-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_turns and kernel.agent_turn_events: the turn record that lets an
-- agent turn survive a restart or a crash.
--
-- agent_turns: one row per agent turn (a chat turn, a thread turn, a routine
-- tick, a re-invocation, a sub-run, a job-driven turn). The process running it
-- (`runner_instance_id`, the instance registry's id) owns it while `state` is
-- 'running'; every write it makes is fenced on that ownership, so a runner that
-- lost the turn to a resume writes nothing more. `origin_ref` names the job a
-- job-driven turn came from, unique per org, so a re-run of the same job finds
-- the turn instead of starting a second one. `resume_input` holds what rebuilds
-- the call on another process.
--
-- agent_turn_events: the turn's journal, one row per complete step, in order
-- (`seq`). Deleted with the turn and when the turn finishes (the reply is then
-- stored in kernel.messages).
--
-- Both hold tool results, as messages.metadata does, and no person reads them
-- through a route: written and read only through the privileged connection.
-- RLS is forced with no policy and the request roles get nothing (the
-- deny-all ledger template, 0182). New tables, so the indexes take no lock on
-- existing data. Re-runnable.
--
-- The foreign keys take SHARE ROW EXCLUSIVE on the referenced tables, which
-- would queue behind a long transaction and block their writes for as long as
-- it waits; behind one, this fails fast and the deploy retries instead.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES kernel.threads(id) ON DELETE CASCADE,
  agent_id uuid,
  origin text NOT NULL,
  origin_ref text,
  user_message_id uuid,
  run_id uuid,
  state text NOT NULL DEFAULT 'running',
  runner_instance_id text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  step_count integer NOT NULL DEFAULT 0,
  resume_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_message_id uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT agent_turns_origin_chk CHECK (
    origin IN ('chat', 'thread', 'routine', 'reinvoke', 'subrun', 'job')
  ),
  CONSTRAINT agent_turns_state_chk CHECK (
    state IN ('running', 'handoff', 'done', 'failed', 'interrupted')
  ),
  CONSTRAINT agent_turns_origin_ref_len_chk CHECK (
    origin_ref IS NULL OR char_length(origin_ref) BETWEEN 1 AND 512
  )
);
--> statement-breakpoint
-- The resume sweep: running turns whose heartbeat stopped, and handed-off turns.
CREATE INDEX IF NOT EXISTS agent_turns_state_heartbeat_idx
  ON kernel.agent_turns (state, heartbeat_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_org_origin_ref_idx
  ON kernel.agent_turns (org_id, origin_ref) WHERE origin_ref IS NOT NULL;
--> statement-breakpoint
-- A thread's unfinished turns (supersede, the stream-state route).
CREATE INDEX IF NOT EXISTS agent_turns_thread_open_idx
  ON kernel.agent_turns (thread_id) WHERE state IN ('running', 'handoff');
--> statement-breakpoint
ALTER TABLE kernel.agent_turns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agent_turns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.agent_turns FROM liaison_rls;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.agent_turn_events (
  turn_id uuid NOT NULL REFERENCES kernel.agent_turns(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 1),
  kind text NOT NULL CHECK (kind IN ('step')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq)
);
--> statement-breakpoint
ALTER TABLE kernel.agent_turn_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agent_turn_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.agent_turn_events FROM liaison_rls;
