-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who may use an organization MCP server.
--
-- `app_mcp_manager.mcp_connections.access_mode`: 'everyone' (the default, and
-- what every existing connection becomes) or 'restricted'. For a restricted org
-- server, `app_mcp_manager.mcp_connection_access` lists the roles and people
-- who may use it. The permission loader (modules/permissions/permissions.ts,
-- `mcpServerAccessGrants`) gives the server's tool namespace `mcp:<slug>` to
-- every active member of an everyone server, and to the listed roles and people
-- of a restricted one; org admins keep it through `*`. Nothing is written to
-- the role grant tables, so a role created later is covered. Personal
-- connections are untouched: their owner-only grant stays where it is.
--
-- FORCE RLS like its siblings: a session reads the list of an org connection it
-- may read, and only the MCP manager admin writes it; the permission loader
-- reads it on the privileged login. Re-runnable.
ALTER TABLE app_mcp_manager.mcp_connections
  ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'everyone';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_connections_access_mode_check'
                  AND conrelid = 'app_mcp_manager.mcp_connections'::regclass) THEN
    ALTER TABLE app_mcp_manager.mcp_connections ADD CONSTRAINT mcp_connections_access_mode_check
      CHECK (access_mode IN ('everyone', 'restricted'));
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app_mcp_manager.mcp_connection_access (
  connection_id uuid NOT NULL
    REFERENCES app_mcp_manager.mcp_connections(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('role', 'user')),
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, principal_type, principal_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_connection_access_org_principal_idx
  ON app_mcp_manager.mcp_connection_access (org_id, principal_type, principal_id);
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connection_access ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connection_access FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS mcp_connection_access_deny_default ON app_mcp_manager.mcp_connection_access;
--> statement-breakpoint
CREATE POLICY mcp_connection_access_deny_default ON app_mcp_manager.mcp_connection_access
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
--> statement-breakpoint
-- Read: anyone who may read the org's connections; the parent must be an ORG
-- connection of the request's org (like mcp_tool_policy, through the parent).
DROP POLICY IF EXISTS mcp_connection_access_select ON app_mcp_manager.mcp_connection_access;
--> statement-breakpoint
CREATE POLICY mcp_connection_access_select ON app_mcp_manager.mcp_connection_access
  FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_mcp_manager.app_has_scope('mcp_manager:connection:read')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_connection_access.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
        AND c.ownership_scope = 'org'
    )
  );
--> statement-breakpoint
-- Write: the MCP manager admin only (org admins hold `*`).
DROP POLICY IF EXISTS mcp_connection_access_modify ON app_mcp_manager.mcp_connection_access;
--> statement-breakpoint
CREATE POLICY mcp_connection_access_modify ON app_mcp_manager.mcp_connection_access
  FOR ALL TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_mcp_manager.app_has_scope('mcp_manager:connection:admin')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_connection_access.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
        AND c.ownership_scope = 'org'
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_mcp_manager.app_has_scope('mcp_manager:connection:admin')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_connection_access.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
        AND c.ownership_scope = 'org'
    )
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_mcp_manager.mcp_connection_access TO liaison_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_mcp_manager.mcp_connection_access TO liaison_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_mcp_manager.mcp_connection_access TO liaison_app;
  END IF;
END
$$;
