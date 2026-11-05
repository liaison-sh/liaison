-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Member roles that can add a personal MCP connection can also read them (S16, A31).
--
-- 0133 gave every member role mcp_manager:personal_connection:write, but not
-- mcp_manager:connection:read: the mcp-manager manifest's `member` tier holds
-- both (it extends `viewer`). The connection list route and the rows' SELECT
-- policy need the read scope, so a member holding only the kernel `member`
-- preset or a custom role saw Settings > My connections crash on a permission
-- error and could neither list nor add a personal connection there.
--
-- Grants mcp_manager:connection:read once to every role that holds the
-- personal-connection scope without it (admins hold `*`; manifest-managed
-- `<app>.<role>` roles are reseeded from their manifest and left alone).
-- Holders' permission_version moves so live sessions pick the grant up.
-- Re-runnable: a role that already holds the scope is skipped.

WITH eligible AS (
  SELECT r.id
  FROM kernel.roles r
  WHERE EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id AND g.scope = 'mcp_manager:personal_connection:write'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.apps a
      WHERE a.org_id = r.org_id AND left(r.name, length(a.name) + 1) = a.name || '.'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g WHERE g.role_id = r.id AND g.scope = '*'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id AND g.scope = 'mcp_manager:connection:read'
    )
),
granted AS (
  INSERT INTO kernel.role_scope_grants (id, role_id, scope)
  SELECT gen_random_uuid(), e.id, 'mcp_manager:connection:read'
  FROM eligible e
  ON CONFLICT (role_id, scope) DO NOTHING
  RETURNING role_id
)
UPDATE kernel.users u
SET permission_version = u.permission_version + 1
WHERE u.id IN (
  SELECT ur.user_id FROM kernel.user_roles ur WHERE ur.role_id IN (SELECT role_id FROM granted)
);
