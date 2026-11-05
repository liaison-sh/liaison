-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Personal MCP connections for every existing member role (S16, A31).
--
-- 0125 introduced mcp_manager:personal_connection:write and granted it through
-- the mcp-manager manifest's `member` role (and so the system-managed Full
-- Member). An org whose people hold the kernel `member` preset or a role an
-- admin built never received it: nobody but an admin could add a personal
-- connection. This grants it once to every MEMBER role of an org that has the
-- mcp-manager app installed:
--   - a member role is one holding the kernel `member` preset's baseline:
--     writing conversations AND contacts (kernel:threads:write and
--     kernel:contacts:write, or a grant covering each: `kernel:threads`,
--     `kernel:threads:*`, `kernel`, `kernel:*`). The preset itself, Full
--     Member and team roles built from it hold both; the `viewer` preset, a
--     guest-like reader, or a narrow role that only replies to tickets do not
--     (fix8 M3: the first version took any role with one non-`:read` grant,
--     which reached guest-like roles). Roles carry no external or guest
--     marker to exclude on: this rule is the line;
--   - not an admin role (a `*` grant already covers it);
--   - not a manifest-managed `<app>.<role>` role: the app reseeds those from
--     its manifest on every boot, which would drop the grant again.
-- 0135 takes the grant back from the roles the first version reached and this
-- rule does not (databases that ran the first version: demo).
-- One-shot by design: an admin who later removes the scope from a role is not
-- overruled by a reconciler. Holders' permission_version moves so live
-- sessions pick the grant up.
--
-- Re-runnable, following the 0033/0045/0082 convention: a role that already
-- holds the scope is skipped, and only users of newly granted roles are bumped.

WITH eligible AS (
  SELECT r.id, r.org_id
  FROM kernel.roles r
  WHERE EXISTS (
      SELECT 1 FROM kernel.apps a WHERE a.org_id = r.org_id AND a.name = 'mcp-manager'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.apps a
      WHERE a.org_id = r.org_id AND left(r.name, length(a.name) + 1) = a.name || '.'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g WHERE g.role_id = r.id AND g.scope = '*'
    )
    AND EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id
        AND g.scope IN ('kernel:threads:write', 'kernel:threads:*', 'kernel:threads', 'kernel:*', 'kernel')
    )
    AND EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id
        AND g.scope IN ('kernel:contacts:write', 'kernel:contacts:*', 'kernel:contacts', 'kernel:*', 'kernel')
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id AND g.scope = 'mcp_manager:personal_connection:write'
    )
),
granted AS (
  INSERT INTO kernel.role_scope_grants (id, role_id, scope)
  SELECT gen_random_uuid(), e.id, 'mcp_manager:personal_connection:write'
  FROM eligible e
  ON CONFLICT (role_id, scope) DO NOTHING
  RETURNING role_id
)
UPDATE kernel.users u
SET permission_version = u.permission_version + 1
WHERE u.id IN (
  SELECT ur.user_id FROM kernel.user_roles ur WHERE ur.role_id IN (SELECT role_id FROM granted)
);
