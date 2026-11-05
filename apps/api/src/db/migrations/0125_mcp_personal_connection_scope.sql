-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Personal MCP connections for every member (P3-T1, S16/A31).
--
-- A new scope, mcp_manager:personal_connection:write, granted to every member
-- through the mcp-manager manifest's `member` role, lets a user create a
-- connection they OWN. Creating an org-shared connection still needs
-- mcp_manager:connection:write, which also keeps creating personal ones.
-- UPDATE and DELETE already let the owner act on a personal row with no scope
-- at all, and SELECT is unchanged (personal rows stay visible to their owner
-- alone), so only the INSERT policy changes.
--
-- Re-runnable, following the 0033/0045/0082 convention.

DROP POLICY IF EXISTS mcp_connections_insert ON app_mcp_manager.mcp_connections;
--> statement-breakpoint
CREATE POLICY mcp_connections_insert ON app_mcp_manager.mcp_connections
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
    AND (
      (ownership_scope = 'personal'
       AND owner_user_id = current_setting('app.current_user_id', true)::uuid
       AND (app_mcp_manager.app_has_scope('mcp_manager:personal_connection:write')
            OR app_mcp_manager.app_has_scope('mcp_manager:connection:write')))
      OR
      (ownership_scope = 'org'
       AND owner_user_id IS NULL
       AND app_mcp_manager.app_has_scope('mcp_manager:connection:write'))
    )
  );
