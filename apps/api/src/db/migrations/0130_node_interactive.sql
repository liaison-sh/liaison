-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A chat that runs on a node (S24, A24, A50/F9).
--
--  - kernel.thread_node_settings: a conversation's runtime for one agent, kept
--    server side so web, phone and desktop agree: runs_on (node |
--    node_else_cloud; no row = the cloud), the permission mode of the
--    interactive session (auto | manual | edit | plan: never bypass, which is
--    unavailable when a chat is driven remotely), the SDK session id the node
--    resumes, and the node owner: only that person's own messages go to the
--    node, everyone else's run in the cloud.
--  - kernel.node_jobs gains kind (unattended | interactive), permission_mode
--    (interactive only, never bypass) and sdk_session_id.
--  - kernel.node_permission_prompts: a permission prompt of a remotely driven
--    node chat, relayed to the owner as an approval card; pending until the
--    owner answers or 10 minutes pass (then denied).
--
-- RLS: the owner reads (and, for settings and prompts, answers) its own rows;
-- '*' / 'kernel:*' holders read the org's. Prompts are created only through
-- the privileged connection (the node's route).
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.node_jobs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'unattended';
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ADD COLUMN IF NOT EXISTS permission_mode text;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs ADD COLUMN IF NOT EXISTS sdk_session_id text;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_kind_check;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs
  ADD CONSTRAINT node_jobs_kind_check CHECK (kind IN ('unattended', 'interactive'));
--> statement-breakpoint
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_permission_mode_check;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs
  ADD CONSTRAINT node_jobs_permission_mode_check CHECK (
    (kind = 'unattended' AND permission_mode IS NULL)
    OR (kind = 'interactive' AND permission_mode IN ('auto', 'manual', 'edit', 'plan'))
  );
--> statement-breakpoint
ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_sdk_session_len;
--> statement-breakpoint
ALTER TABLE kernel.node_jobs
  ADD CONSTRAINT node_jobs_sdk_session_len CHECK (sdk_session_id IS NULL OR char_length(sdk_session_id) <= 200);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.thread_node_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES kernel.threads(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  runs_on text NOT NULL,
  permission_mode text NOT NULL DEFAULT 'manual',
  target_node_id uuid,
  sdk_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thread_node_settings_agent_fk FOREIGN KEY (agent_id, org_id)
    REFERENCES kernel.agents (id, org_id) ON DELETE CASCADE,
  CONSTRAINT thread_node_settings_node_fk FOREIGN KEY (target_node_id, org_id)
    REFERENCES kernel.nodes (id, org_id) ON DELETE SET NULL (target_node_id),
  CONSTRAINT thread_node_settings_runs_on_check CHECK (runs_on IN ('node', 'node_else_cloud')),
  CONSTRAINT thread_node_settings_permission_mode_check
    CHECK (permission_mode IN ('auto', 'manual', 'edit', 'plan')),
  CONSTRAINT thread_node_settings_sdk_session_len
    CHECK (sdk_session_id IS NULL OR char_length(sdk_session_id) <= 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS thread_node_settings_thread_agent_idx
  ON kernel.thread_node_settings (thread_id, agent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS thread_node_settings_owner_idx
  ON kernel.thread_node_settings (org_id, owner_user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.node_permission_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES kernel.node_jobs(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT node_permission_prompts_status_check
    CHECK (status IN ('pending', 'allowed', 'denied')),
  CONSTRAINT node_permission_prompts_tool_len CHECK (char_length(tool_name) BETWEEN 1 AND 200),
  CONSTRAINT node_permission_prompts_summary_len CHECK (char_length(summary) <= 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS node_permission_prompts_job_idx
  ON kernel.node_permission_prompts (job_id, created_at);
--> statement-breakpoint

ALTER TABLE kernel.thread_node_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.thread_node_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_permission_prompts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.node_permission_prompts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.thread_node_settings TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON kernel.node_permission_prompts TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS thread_node_settings_owner ON kernel.thread_node_settings;
--> statement-breakpoint
CREATE POLICY thread_node_settings_owner ON kernel.thread_node_settings FOR ALL TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS thread_node_settings_admin_read ON kernel.thread_node_settings;
--> statement-breakpoint
CREATE POLICY thread_node_settings_admin_read ON kernel.thread_node_settings FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS node_permission_prompts_read ON kernel.node_permission_prompts;
--> statement-breakpoint
CREATE POLICY node_permission_prompts_read ON kernel.node_permission_prompts FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS node_permission_prompts_owner_answer ON kernel.node_permission_prompts;
--> statement-breakpoint
CREATE POLICY node_permission_prompts_owner_answer ON kernel.node_permission_prompts FOR UPDATE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
