-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_skill_index: the kernel-maintained cross-agent skill index
-- table (D9). One row per (agent_id, skill_name) pointing at the skill the
-- agent can reach.
--
-- RLS: SELECT-only org match for liaison_rls (agent_skill_index_select, A13).
-- No INSERT/UPDATE/DELETE policy is created for liaison_rls at all -- per
-- A13 this table is "writable only by the skill and knowledge mutation
-- paths, no direct grant", so writes happen exclusively through
-- withPrivilegedDb/the skill mutation service code (T13), which bypasses
-- RLS via the liaison_admin (BYPASSRLS) connection. The table-level GRANT
-- below follows 0045's convention (SELECT/INSERT/UPDATE/DELETE to
-- liaison_rls, liaison_app) but with no write policy created, FORCE RLS
-- default-denies every INSERT/UPDATE/DELETE attempted as liaison_rls
-- regardless of the grant, so there is no direct write path for that role.
--
-- Every statement here is RE-RUNNABLE, following the convention 0033/0045
-- established: a journal `when` raised above an already-deployed highwater
-- can cause this file to run a second time on a database that applied it
-- under an earlier draft.

CREATE TABLE IF NOT EXISTS kernel.agent_skill_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES kernel.agents(id) ON DELETE CASCADE,
  skill_name text NOT NULL,
  skill_id uuid NOT NULL REFERENCES kernel.skills(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_skill_index_agent_skill_name_idx
  ON kernel.agent_skill_index (agent_id, skill_name);
--> statement-breakpoint
ALTER TABLE kernel.agent_skill_index ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agent_skill_index FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.agent_skill_index TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS agent_skill_index_select ON kernel.agent_skill_index;
CREATE POLICY agent_skill_index_select ON kernel.agent_skill_index FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );
