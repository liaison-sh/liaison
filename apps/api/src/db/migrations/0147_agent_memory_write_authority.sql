-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who may WRITE a shared agent's memory, stated once and hierarchically.
--
-- A role or system agent's memory tree is loaded into every turn of that agent,
-- for every user it serves, so writing it is reserved to agent administrators
-- (0057 already required '*' or 'kernel:agents:admin' for role/system writes).
-- 0057 matched those two strings EXACTLY, while the application checks scopes
-- hierarchically: a holder of `kernel` or `kernel:agents` passed the route's
-- check and was then refused by the policy. The write predicate now lives in
-- one function, accepts kernel:agents:admin or any scope above it, and keeps
-- the two other branches exactly as 0057 had them:
--   * a personal agent's memory is its owner's;
--   * the transitional legacy bridge (owner_agent_id IS NULL rows of the
--     current user, see 0057's header).
-- SELECT is unchanged.
--
-- Re-runnable: DROP POLICY IF EXISTS before each CREATE.

DROP POLICY IF EXISTS agent_memory_insert ON kernel.agent_memory;
DROP POLICY IF EXISTS agent_memory_update ON kernel.agent_memory;
DROP POLICY IF EXISTS agent_memory_delete ON kernel.agent_memory;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kernel.agent_memory_writable(
  row_org uuid,
  row_owner_agent uuid,
  row_user uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT row_org = current_setting('app.current_org_id', true)::uuid
    AND (
      (
        row_owner_agent IS NULL
        AND row_user = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
      OR EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = row_owner_agent
          AND (
            (
              a.kind = 'personal'
              AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
            )
            OR (
              a.kind IN ('role', 'system')
              AND string_to_array(current_setting('app.current_scopes', true), ',')
                && ARRAY['*', 'kernel', 'kernel:*', 'kernel:agents', 'kernel:agents:*', 'kernel:agents:admin']
            )
          )
      )
    )
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION kernel.agent_memory_writable(uuid, uuid, uuid) TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint

CREATE POLICY agent_memory_insert ON kernel.agent_memory FOR INSERT TO liaison_rls
  WITH CHECK (kernel.agent_memory_writable(org_id, owner_agent_id, user_id));
--> statement-breakpoint

CREATE POLICY agent_memory_update ON kernel.agent_memory FOR UPDATE TO liaison_rls
  USING (kernel.agent_memory_writable(org_id, owner_agent_id, user_id))
  WITH CHECK (kernel.agent_memory_writable(org_id, owner_agent_id, user_id));
--> statement-breakpoint

CREATE POLICY agent_memory_delete ON kernel.agent_memory FOR DELETE TO liaison_rls
  USING (kernel.agent_memory_writable(org_id, owner_agent_id, user_id));
