-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The local node (S19-S25, spec-node.md, A17-A27, A50).
--
--  - kernel.nodes: one desktop install a user turned into their node, bound
--    to the realtime deviceId the desktop app announces in its hello (the
--    `d.<installHash>` id, F11). Carries the node credential, stored hashed
--    (A25); DELETE revokes it (revoked_at set, hash cleared) and keeps the row
--    so the job history still names the node.
--  - kernel.node_sessions: the node's connected intervals (A23). Opened when
--    the node's desktop connection says hello, closed on disconnect; a stale
--    open interval (its connection gone from the presence registry) is closed
--    by the sweeper and at boot (F12).
--  - kernel.node_jobs: work for a node. Full status set (F7): queued, offered,
--    running, done, failed, refused, cancelled, fell_back, interrupted.
--    Fenced by lease_generation (A20); one running job per node, enforced by a
--    partial unique index on the lease holder (A25). No expiry (D11).
--  - kernel.node_profiles: one profile per (node owner, agent) (S22).
--  - kernel.node_attachments: an agent attached to a node owner's node (A17).
--
-- RLS: the owner reads (and, for nodes, profiles and attachments, writes) its
-- own rows; holders of '*' or 'kernel:*' read every row of the org. Job and
-- session writes go through the privileged connection only.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

CREATE TABLE IF NOT EXISTS kernel.nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  os text,
  app_version text,
  credential_hash text,
  credential_issued_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nodes_device_id_len CHECK (char_length(device_id) BETWEEN 1 AND 128),
  CONSTRAINT nodes_name_len CHECK (char_length(name) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS nodes_owner_device_idx
  ON kernel.nodes (owner_user_id, device_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS nodes_credential_hash_idx
  ON kernel.nodes (credential_hash) WHERE credential_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nodes_org_owner_idx ON kernel.nodes (org_id, owner_user_id);
--> statement-breakpoint
-- (id, org_id) is the target of the composite keys below.
CREATE UNIQUE INDEX IF NOT EXISTS nodes_id_org_idx ON kernel.nodes (id, org_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.node_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  conn_id text NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  close_reason text,
  CONSTRAINT node_sessions_node_fk FOREIGN KEY (node_id, org_id)
    REFERENCES kernel.nodes (id, org_id) ON DELETE CASCADE,
  CONSTRAINT node_sessions_close_reason_check
    CHECK (close_reason IS NULL OR close_reason IN ('disconnect', 'stale', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_sessions_node_idx
  ON kernel.node_sessions (node_id, connected_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_sessions_open_idx
  ON kernel.node_sessions (org_id) WHERE disconnected_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.node_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES kernel.threads(id) ON DELETE CASCADE,
  -- The node a routine named (A26: otherwise any live enabled node of the owner).
  target_node_id uuid,
  -- The node that claimed (holds, or last held) the job.
  node_id uuid,
  source text NOT NULL,
  source_ref text,
  routine_id uuid REFERENCES kernel.routines(id) ON DELETE SET NULL,
  runs_on text NOT NULL DEFAULT 'node',
  prompt text NOT NULL,
  -- Trigger / tagged content, carried to the node for its untrusted-data block (A22).
  trigger jsonb,
  source_required_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_budget integer,
  hard_token_limit integer,
  -- agent_tag: who asked, and where the link back goes (A17).
  requester_user_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  requester_agent_id uuid,
  reply_thread_id uuid REFERENCES kernel.threads(id) ON DELETE SET NULL,
  reply_message_id uuid,
  status text NOT NULL DEFAULT 'queued',
  -- Created while no enabled node of the owner was connected (A23).
  backlog boolean NOT NULL DEFAULT false,
  -- Older queued runs of the same routine this job replaced (A23).
  skipped_count integer NOT NULL DEFAULT 0,
  lease_holder uuid,
  lease_generation integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- The MCP connection the job's Liaison tools run on (A50, per-job taint).
  mcp_connection_id uuid,
  result_message_id uuid,
  result_generation integer,
  result_required_scopes jsonb,
  refusals jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb,
  error text,
  error_code text,
  offered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT node_jobs_agent_fk FOREIGN KEY (agent_id, org_id)
    REFERENCES kernel.agents (id, org_id) ON DELETE CASCADE,
  CONSTRAINT node_jobs_node_fk FOREIGN KEY (node_id, org_id)
    REFERENCES kernel.nodes (id, org_id) ON DELETE SET NULL (node_id),
  CONSTRAINT node_jobs_target_node_fk FOREIGN KEY (target_node_id, org_id)
    REFERENCES kernel.nodes (id, org_id) ON DELETE SET NULL (target_node_id),
  CONSTRAINT node_jobs_source_check CHECK (source IN ('routine', 'chat', 'agent_tag')),
  CONSTRAINT node_jobs_runs_on_check CHECK (runs_on IN ('node', 'node_else_cloud')),
  CONSTRAINT node_jobs_status_check CHECK (status IN (
    'queued', 'offered', 'running', 'done', 'failed', 'refused', 'cancelled',
    'fell_back', 'interrupted'
  )),
  CONSTRAINT node_jobs_token_budget_check CHECK (token_budget IS NULL OR token_budget > 0),
  CONSTRAINT node_jobs_hard_limit_check CHECK (hard_token_limit IS NULL OR hard_token_limit > 0),
  CONSTRAINT node_jobs_prompt_len CHECK (char_length(prompt) <= 200000)
);
--> statement-breakpoint
-- A25: one running job per node, server side.
CREATE UNIQUE INDEX IF NOT EXISTS node_jobs_one_running_per_node_idx
  ON kernel.node_jobs (lease_holder) WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_jobs_owner_status_idx
  ON kernel.node_jobs (org_id, owner_user_id, status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_jobs_routine_queued_idx
  ON kernel.node_jobs (routine_id) WHERE status IN ('queued', 'offered');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_jobs_lease_idx
  ON kernel.node_jobs (lease_expires_at) WHERE status = 'running';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.node_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  node_owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  template text NOT NULL DEFAULT 'default',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT node_profiles_agent_fk FOREIGN KEY (agent_id, org_id)
    REFERENCES kernel.agents (id, org_id) ON DELETE CASCADE,
  CONSTRAINT node_profiles_template_check
    CHECK (template IN ('default', 'researcher', 'bug_fixer', 'custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS node_profiles_owner_agent_idx
  ON kernel.node_profiles (node_owner_user_id, agent_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.node_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  node_owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  node_id uuid,
  allowed_requesters jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_jobs_per_day integer NOT NULL DEFAULT 10,
  max_tokens_per_day integer NOT NULL DEFAULT 2000000,
  agent_allowed_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  agent_allowed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT node_attachments_agent_fk FOREIGN KEY (agent_id, org_id)
    REFERENCES kernel.agents (id, org_id) ON DELETE CASCADE,
  CONSTRAINT node_attachments_node_fk FOREIGN KEY (node_id, org_id)
    REFERENCES kernel.nodes (id, org_id) ON DELETE SET NULL (node_id),
  CONSTRAINT node_attachments_caps_check
    CHECK (max_jobs_per_day > 0 AND max_tokens_per_day > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS node_attachments_owner_agent_idx
  ON kernel.node_attachments (node_owner_user_id, agent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_attachments_agent_idx
  ON kernel.node_attachments (org_id, agent_id, created_at);
--> statement-breakpoint

ALTER TABLE kernel.nodes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.nodes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.nodes TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT ON kernel.node_sessions TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT ON kernel.node_jobs TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.node_profiles TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.node_attachments TO liaison_rls, liaison_app;
--> statement-breakpoint

-- Owner: every operation on its own rows.
DROP POLICY IF EXISTS nodes_owner ON kernel.nodes;
--> statement-breakpoint
CREATE POLICY nodes_owner ON kernel.nodes FOR ALL TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint
-- Admins: read only.
DROP POLICY IF EXISTS nodes_admin_read ON kernel.nodes;
--> statement-breakpoint
CREATE POLICY nodes_admin_read ON kernel.nodes FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_sessions_read ON kernel.node_sessions;
--> statement-breakpoint
CREATE POLICY node_sessions_read ON kernel.node_sessions FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR EXISTS (
        SELECT 1 FROM kernel.nodes n
         WHERE n.id = node_sessions.node_id
           AND n.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_jobs_read ON kernel.node_jobs;
--> statement-breakpoint
CREATE POLICY node_jobs_read ON kernel.node_jobs FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_profiles_owner ON kernel.node_profiles;
--> statement-breakpoint
CREATE POLICY node_profiles_owner ON kernel.node_profiles FOR ALL TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND node_owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND node_owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS node_profiles_admin_read ON kernel.node_profiles;
--> statement-breakpoint
CREATE POLICY node_profiles_admin_read ON kernel.node_profiles FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_attachments_owner ON kernel.node_attachments;
--> statement-breakpoint
CREATE POLICY node_attachments_owner ON kernel.node_attachments FOR ALL TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND node_owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND node_owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS node_attachments_admin_read ON kernel.node_attachments;
--> statement-breakpoint
CREATE POLICY node_attachments_admin_read ON kernel.node_attachments FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
