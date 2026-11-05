-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Takes back what the first 0133 granted beyond member roles (fix8 M3).
--
-- 0133 first picked "member roles" as any role with one grant not ending in
-- `:read`: a guest-like role that may only reply to tickets, say, received
-- mcp_manager:personal_connection:write (and, through 0134, connection:read).
-- 0133 now names member roles by the kernel `member` preset's baseline
-- (kernel:threads:write and kernel:contacts:write, or grants covering them).
-- A database that ran the first version (demo) is corrected here; on one that
-- ran only the fixed 0133 (every production box), nothing matches.
--
-- Revoked, from a role that is not admin (`*`), not manifest-managed
-- (`<app>.<role>`) and not a member role by that rule:
--   - mcp_manager:personal_connection:write, unless an admin granted it by
--     hand. Every grant made through the API, the role editor or an agent
--     tool goes through grantScope, which leaves a `role_scope.grant` audit
--     row naming the role and the scope; a migration leaves none. A role with
--     such a row keeps the scope. (A hand grant whose audit row was purged by
--     retention cannot be told apart from 0133's and is revoked: the admin
--     grants it again.)
--   - mcp_manager:connection:read, from the same roles, under the same
--     hand-grant rule (0134 granted it to roles holding the personal scope).
-- Holders' permission_version moves so live sessions drop the scopes.
-- Re-runnable: once revoked there is nothing left to match.

WITH member_role AS (
  SELECT r.id
  FROM kernel.roles r
  WHERE EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id
        AND g.scope IN ('kernel:threads:write', 'kernel:threads:*', 'kernel:threads', 'kernel:*', 'kernel')
    )
    AND EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id
        AND g.scope IN ('kernel:contacts:write', 'kernel:contacts:*', 'kernel:contacts', 'kernel:*', 'kernel')
    )
),
outside AS (
  SELECT r.id, r.org_id
  FROM kernel.roles r
  WHERE r.id NOT IN (SELECT id FROM member_role)
    AND NOT EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g WHERE g.role_id = r.id AND g.scope = '*'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.apps a
      WHERE a.org_id = r.org_id AND left(r.name, length(a.name) + 1) = a.name || '.'
    )
),
revoked_write AS (
  DELETE FROM kernel.role_scope_grants g
  USING outside o
  WHERE g.role_id = o.id
    AND g.scope = 'mcp_manager:personal_connection:write'
    AND NOT EXISTS (
      SELECT 1 FROM kernel.audit_log l
      WHERE l.org_id = o.org_id
        AND l.entity_type = 'role_scope'
        AND l.action = 'role_scope.grant'
        AND l.entity_id = o.id::text
        AND l.changes ->> 'scope' = 'mcp_manager:personal_connection:write'
    )
  RETURNING g.role_id
),
revoked_read AS (
  DELETE FROM kernel.role_scope_grants g
  USING outside o
  WHERE g.role_id = o.id
    AND g.role_id IN (SELECT role_id FROM revoked_write)
    AND g.scope = 'mcp_manager:connection:read'
    AND NOT EXISTS (
      SELECT 1 FROM kernel.audit_log l
      WHERE l.org_id = o.org_id
        AND l.entity_type = 'role_scope'
        AND l.action = 'role_scope.grant'
        AND l.entity_id = o.id::text
        AND l.changes ->> 'scope' = 'mcp_manager:connection:read'
    )
  RETURNING g.role_id
)
UPDATE kernel.users u
SET permission_version = u.permission_version + 1
WHERE u.id IN (
  SELECT ur.user_id FROM kernel.user_roles ur
  WHERE ur.role_id IN (SELECT role_id FROM revoked_write UNION SELECT role_id FROM revoked_read)
);
