-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Node sessions (P1 of the Sessions app).
--
--  - L1: the old kernel.node_sessions, the node's connection log (opened on
--    hello, closed on disconnect), becomes kernel.node_connections with its
--    indexes, constraints and policy.
--  - kernel.node_sessions: one Claude Code session run on a node, from a chat
--    dispatch, the Sessions app, a routine or an agent tag. Its steps are
--    kernel.node_session_events (append-only, numbered by the server), its
--    owner-to-node commands kernel.node_session_commands (used from P3).
--  - kernel.node_level_confirmations: an owner's in-app confirmation of a level
--    raise (D24), with its purpose and attachment (D38, D41).
--  - kernel.node_capabilities: what a node offers (shared folders with their
--    paths, models, level pins), owner-only (D37, D42).
--  - node_jobs: the `dispatch` and `app` sources (L29); an app job may have no
--    thread (D32).
--  - routines: the folder, repo and model a node run uses (L26); a Claude model
--    already chosen for a node routine is copied into `model` (GAP5).
--  - node_profiles: reduced to the level and Liaison tools (S20, D18). Each old
--    template maps to its guardrail level (Strict when it had none) and its
--    Liaison tools switch (on when unset, D21); a bug_fixer's first repo moves
--    into that agent's node routines that have no repo (GAP7), the full list is
--    raised as a NOTICE.
--
-- RLS: every new table is owner-only, with no admin read; the session tables
-- are written through the privileged connection only, and no app role may
-- UPDATE or DELETE an event.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

-- 1. L1: the connection log keeps its rows under its new name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'kernel' AND table_name = 'node_sessions' AND column_name = 'conn_id'
  ) AND to_regclass('kernel.node_connections') IS NULL THEN
    ALTER TABLE kernel.node_sessions RENAME TO node_connections;
    ALTER INDEX kernel.node_sessions_pkey RENAME TO node_connections_pkey;
    ALTER INDEX kernel.node_sessions_node_idx RENAME TO node_connections_node_idx;
    ALTER INDEX kernel.node_sessions_open_idx RENAME TO node_connections_open_idx;
    ALTER TABLE kernel.node_connections
      RENAME CONSTRAINT node_sessions_node_fk TO node_connections_node_fk;
    ALTER TABLE kernel.node_connections
      RENAME CONSTRAINT node_sessions_org_id_fkey TO node_connections_org_id_fkey;
    ALTER TABLE kernel.node_connections
      RENAME CONSTRAINT node_sessions_close_reason_check TO node_connections_close_reason_check;
    ALTER POLICY node_sessions_read ON kernel.node_connections RENAME TO node_connections_read;
  END IF;
END $$;
--> statement-breakpoint

-- 2. The session.
CREATE TABLE IF NOT EXISTS kernel.node_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  -- Set when a node claims it.
  node_id uuid,
  -- The current kernel.node_jobs row (each run is a new job); with its
  -- lease_generation, the run fence (D33).
  job_id uuid REFERENCES kernel.node_jobs(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL,
  source text NOT NULL,
  config_kind text NOT NULL,
  config_dir text,
  source_thread_id uuid REFERENCES kernel.threads(id) ON DELETE SET NULL,
  source_message_id uuid,
  title text NOT NULL,
  prompt text NOT NULL,
  folder_name text,
  folder_path text,
  -- D49: a dispatch's repo, a git URL or a shared repo folder's name.
  repo text,
  branch text,
  pushed boolean NOT NULL DEFAULT false,
  pr_url text,
  model text NOT NULL,
  level text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  pending_count integer NOT NULL DEFAULT 0,
  waiting_reason text,
  sdk_session_id text,
  claude_code text,
  last_seq integer NOT NULL DEFAULT 0,
  last_batch_no integer NOT NULL DEFAULT 0,
  last_batch_hash text,
  last_command_seq integer NOT NULL DEFAULT 0,
  latest_activity text,
  tokens_in bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  result_summary text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT node_sessions_agent_fk FOREIGN KEY (agent_id, org_id)
    REFERENCES kernel.agents (id, org_id) ON DELETE CASCADE,
  CONSTRAINT node_sessions_node_fk FOREIGN KEY (node_id, org_id)
    REFERENCES kernel.nodes (id, org_id) ON DELETE SET NULL (node_id),
  CONSTRAINT node_sessions_source_check
    CHECK (source IN ('dispatch', 'app', 'routine', 'agent_tag')),
  CONSTRAINT node_sessions_status_check CHECK (status IN (
    'queued', 'running', 'waiting', 'paused', 'done', 'stopped', 'failed'
  )),
  CONSTRAINT node_sessions_level_check CHECK (level IN ('strict', 'standard', 'open')),
  CONSTRAINT node_sessions_config_kind_check CHECK (config_kind IN ('owner', 'isolated')),
  CONSTRAINT node_sessions_title_len CHECK (char_length(title) <= 120),
  CONSTRAINT node_sessions_latest_activity_len
    CHECK (latest_activity IS NULL OR char_length(latest_activity) <= 200),
  CONSTRAINT node_sessions_result_summary_len
    CHECK (result_summary IS NULL OR char_length(result_summary) <= 300),
  CONSTRAINT node_sessions_folder_name_len
    CHECK (folder_name IS NULL OR char_length(folder_name) <= 200),
  CONSTRAINT node_sessions_folder_path_len
    CHECK (folder_path IS NULL OR char_length(folder_path) <= 4096),
  CONSTRAINT node_sessions_repo_len CHECK (repo IS NULL OR char_length(repo) <= 500),
  CONSTRAINT node_sessions_waiting_reason_len
    CHECK (waiting_reason IS NULL OR char_length(waiting_reason) <= 300),
  CONSTRAINT node_sessions_claude_code_len
    CHECK (claude_code IS NULL OR char_length(claude_code) <= 600),
  CONSTRAINT node_sessions_error_len CHECK (error IS NULL OR char_length(error) <= 2000),
  CONSTRAINT node_sessions_model_len CHECK (char_length(model) <= 200),
  CONSTRAINT node_sessions_pending_count_check CHECK (pending_count >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_sessions_owner_status_idx
  ON kernel.node_sessions (org_id, owner_user_id, status, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_sessions_owner_ended_idx
  ON kernel.node_sessions (org_id, owner_user_id, ended_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS node_sessions_job_idx
  ON kernel.node_sessions (job_id) WHERE job_id IS NOT NULL;
--> statement-breakpoint

-- 3. Its steps, numbered by the server (D33). truncated/full_bytes: a field was
-- cut to the event caps (R21).
CREATE TABLE IF NOT EXISTS kernel.node_session_events (
  session_id uuid NOT NULL REFERENCES kernel.node_sessions(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  parent_tool_use_id text,
  payload jsonb NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  full_bytes integer,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT node_session_events_type_check CHECK (type IN (
    'user_message', 'assistant_text', 'thinking', 'tool_call', 'tool_result', 'todo',
    'permission_request', 'question', 'plan_request', 'decision', 'command_applied',
    'status', 'usage', 'model_changed', 'level_changed', 'resumed', 'result', 'system'
  )),
  CONSTRAINT node_session_events_full_bytes_check CHECK (full_bytes IS NULL OR full_bytes >= 0)
);
--> statement-breakpoint

-- 4. Owner-to-node commands (P3), in per-session order.
CREATE TABLE IF NOT EXISTS kernel.node_session_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES kernel.node_sessions(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acked_at timestamptz,
  -- The run that applied it.
  job_id uuid,
  outcome text,
  result jsonb,
  CONSTRAINT node_session_commands_seq_key UNIQUE (session_id, seq),
  CONSTRAINT node_session_commands_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('applied', 'noop', 'cancelled', 'failed'))
);
--> statement-breakpoint

-- 5. Level confirmations (D24, D38, D41). expires_at (created_at + 5 min) is
-- set by the confirm route; an attached profile_raise or session_start does
-- not expire by age.
CREATE TABLE IF NOT EXISTS kernel.node_level_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  agent_id uuid,
  session_id uuid REFERENCES kernel.node_sessions(id) ON DELETE CASCADE,
  level text NOT NULL,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attached_at timestamptz,
  attached_session_id uuid REFERENCES kernel.node_sessions(id) ON DELETE CASCADE,
  CONSTRAINT node_level_confirmations_node_fk FOREIGN KEY (node_id, org_id)
    REFERENCES kernel.nodes (id, org_id) ON DELETE CASCADE,
  CONSTRAINT node_level_confirmations_agent_fk FOREIGN KEY (agent_id, org_id)
    REFERENCES kernel.agents (id, org_id) ON DELETE CASCADE,
  CONSTRAINT node_level_confirmations_level_check
    CHECK (level IN ('strict', 'standard', 'open')),
  CONSTRAINT node_level_confirmations_purpose_check
    CHECK (purpose IN ('profile_raise', 'session_start', 'session_raise')),
  CONSTRAINT node_level_confirmations_one_target
    CHECK ((agent_id IS NULL) <> (session_id IS NULL)),
  CONSTRAINT node_level_confirmations_purpose_target CHECK (
    (purpose = 'session_raise' AND session_id IS NOT NULL)
    OR (purpose IN ('profile_raise', 'session_start') AND agent_id IS NOT NULL)
  ),
  CONSTRAINT node_level_confirmations_attached_session
    CHECK (attached_session_id IS NULL OR purpose = 'session_start')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_level_confirmations_open_idx
  ON kernel.node_level_confirmations (node_id, agent_id, purpose) WHERE consumed_at IS NULL;
--> statement-breakpoint

-- 6. What a node offers (D37, D42): shared folders with their paths, models,
-- per-agent level pins. Owner-only: kernel.nodes is readable by admins.
CREATE TABLE IF NOT EXISTS kernel.node_capabilities (
  node_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  shared_folders jsonb NOT NULL DEFAULT '[]'::jsonb,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  level_pins jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT node_capabilities_node_fk FOREIGN KEY (node_id, org_id)
    REFERENCES kernel.nodes (id, org_id) ON DELETE CASCADE,
  CONSTRAINT node_capabilities_arrays_check CHECK (
    jsonb_typeof(shared_folders) = 'array' AND jsonb_typeof(models) = 'array'
    AND jsonb_typeof(level_pins) = 'array'
  )
);
--> statement-breakpoint

-- 7. Node jobs: the dispatch and app sources; only an app job may have no thread.
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_source_check;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ADD CONSTRAINT node_jobs_source_check
  CHECK (source IN ('routine', 'chat', 'agent_tag', 'dispatch', 'app'));
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ALTER COLUMN thread_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_thread_required;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ADD CONSTRAINT node_jobs_thread_required
  CHECK (thread_id IS NOT NULL OR source = 'app');
--> statement-breakpoint

-- 8. Routines: where and with which model a node run works (L26). Before step 9,
-- which writes routines.repo.
ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS folder text;
--> statement-breakpoint
ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS repo text;
--> statement-breakpoint
ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS model text;
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_folder_len_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines ADD CONSTRAINT routines_folder_len_chk
  CHECK (folder IS NULL OR char_length(folder) <= 200);
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_repo_len_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines ADD CONSTRAINT routines_repo_len_chk
  CHECK (repo IS NULL OR char_length(repo) <= 500);
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_model_len_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines ADD CONSTRAINT routines_model_len_chk
  CHECK (model IS NULL OR char_length(model) <= 200);
--> statement-breakpoint
-- GAP5: agent_model_id stays the cloud model; a Claude model a node routine
-- already named becomes its node model.
UPDATE kernel.routines
   SET model = agent_model_id
 WHERE agent_model_id LIKE 'claude-%'
   AND runs_on <> 'cloud'
   AND model IS NULL;
--> statement-breakpoint

-- 9. Node profiles: the level and Liaison tools only (S20).
ALTER TABLE kernel.node_profiles ADD COLUMN IF NOT EXISTS level text NOT NULL DEFAULT 'strict';
--> statement-breakpoint
ALTER TABLE kernel.node_profiles ADD COLUMN IF NOT EXISTS liaison_tools boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE kernel.node_profiles DROP CONSTRAINT IF EXISTS node_profiles_level_check;
--> statement-breakpoint
ALTER TABLE kernel.node_profiles ADD CONSTRAINT node_profiles_level_check
  CHECK (level IN ('strict', 'standard', 'open'));
--> statement-breakpoint
DO $$
DECLARE
  p record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'kernel' AND table_name = 'node_profiles' AND column_name = 'template'
  ) THEN
    RETURN;
  END IF;

  EXECUTE $sql$
    UPDATE kernel.node_profiles
       SET level = CASE
             WHEN config->>'guardrail' IN ('strict', 'standard', 'open') THEN config->>'guardrail'
             ELSE 'strict'
           END,
           liaison_tools = CASE
             WHEN jsonb_typeof(config->'liaisonTools') = 'boolean'
               THEN (config->>'liaisonTools')::boolean
             ELSE true
           END
  $sql$;

  -- GAP7: a bug_fixer's repo list becomes ONE repo per node routine.
  FOR p IN EXECUTE $sql$
    SELECT org_id, node_owner_user_id, agent_id, config->'repos' AS repos
      FROM kernel.node_profiles
     WHERE template = 'bug_fixer'
       AND jsonb_typeof(config->'repos') = 'array'
       AND jsonb_array_length(config->'repos') > 0
  $sql$
  LOOP
    UPDATE kernel.routines
       SET repo = p.repos->>0
     WHERE org_id = p.org_id
       AND owner_agent_id = p.agent_id
       AND owner_user_id = p.node_owner_user_id
       AND runs_on IN ('node', 'node_else_cloud')
       AND repo IS NULL;
    RAISE NOTICE '0140: bug_fixer profile of agent % (owner %) had repos %; its node routines with no repo now use %',
      p.agent_id, p.node_owner_user_id, p.repos::text, p.repos->>0;
  END LOOP;

  ALTER TABLE kernel.node_profiles DROP CONSTRAINT IF EXISTS node_profiles_template_check;
  ALTER TABLE kernel.node_profiles DROP COLUMN IF EXISTS template;
  ALTER TABLE kernel.node_profiles DROP COLUMN IF EXISTS config;
END $$;
--> statement-breakpoint

-- 10. RLS, owner only, no admin read.
ALTER TABLE kernel.node_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_session_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_session_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_session_commands ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_session_commands FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_level_confirmations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_level_confirmations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_capabilities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_capabilities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Grants. The kernel default privileges hand every role every privilege on a
-- new table; take them back first. Writes go through the privileged
-- (liaison_admin) connection; the events are append-only for every app role.
REVOKE ALL ON kernel.node_sessions, kernel.node_session_events, kernel.node_session_commands,
  kernel.node_level_confirmations, kernel.node_capabilities FROM liaison_rls, liaison_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON kernel.node_session_events FROM liaison_admin;
--> statement-breakpoint
GRANT SELECT ON kernel.node_sessions, kernel.node_session_events,
  kernel.node_level_confirmations, kernel.node_capabilities TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON kernel.node_session_commands TO liaison_rls, liaison_app;
--> statement-breakpoint
-- TRUNCATE stays with liaison_app as on every kernel table: a whole-database
-- reset (tests, demo) truncates kernel.users CASCADE, which reaches these.
GRANT TRUNCATE ON kernel.node_sessions, kernel.node_session_events, kernel.node_session_commands,
  kernel.node_level_confirmations, kernel.node_capabilities TO liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS node_sessions_owner_read ON kernel.node_sessions;
--> statement-breakpoint
CREATE POLICY node_sessions_owner_read ON kernel.node_sessions FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_session_events_owner_read ON kernel.node_session_events;
--> statement-breakpoint
CREATE POLICY node_session_events_owner_read ON kernel.node_session_events FOR SELECT TO liaison_rls
  USING (
    EXISTS (
      SELECT 1 FROM kernel.node_sessions s
       WHERE s.id = node_session_events.session_id
         AND s.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
         AND s.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_session_commands_owner_read ON kernel.node_session_commands;
--> statement-breakpoint
CREATE POLICY node_session_commands_owner_read ON kernel.node_session_commands FOR SELECT TO liaison_rls
  USING (
    EXISTS (
      SELECT 1 FROM kernel.node_sessions s
       WHERE s.id = node_session_commands.session_id
         AND s.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
         AND s.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS node_session_commands_owner_insert ON kernel.node_session_commands;
--> statement-breakpoint
CREATE POLICY node_session_commands_owner_insert ON kernel.node_session_commands FOR INSERT TO liaison_rls
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM kernel.node_sessions s
       WHERE s.id = node_session_commands.session_id
         AND s.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
         AND s.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_level_confirmations_owner_read ON kernel.node_level_confirmations;
--> statement-breakpoint
CREATE POLICY node_level_confirmations_owner_read ON kernel.node_level_confirmations
  FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_capabilities_owner_read ON kernel.node_capabilities;
--> statement-breakpoint
CREATE POLICY node_capabilities_owner_read ON kernel.node_capabilities FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
