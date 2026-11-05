-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Ownership-aware approval routing for personally-owned resources (privacy).
--
-- Bug: an agent-drafted gated mail:reply from a PERSONAL mailbox fanned its
-- approval (full draft body in current_payload) out to every mail:approve /
-- '*' holder, and the 0020 mail:* visibility branch made it readable by any
-- mail:conversations:read holder. Private correspondence must route to the
-- mailbox OWNER alone.
--
-- 1) New nullable column `resource_owner_id`: set at creation time when the
--    gated tool resolves to a personally-owned resource (manifest
--    `resourceOwner` declaration; see modules/approvals/resource-owner.ts).
--    Null keeps every existing behavior unchanged.
--
-- 2) SELECT policy: a row WITH a resource owner is visible ONLY to its
--    requester and that owner. DELIBERATE: the generic admin branches
--    (kernel:approvals:admin / kernel:users:admin) and the 0018/0020
--    tickets:*/mail:* shared-surface branches are EXCLUDED for these rows.
--    A break-glass admin read of someone's personal draft would recreate the
--    privacy leak this migration closes; operational recovery paths use the
--    BYPASSRLS privileged pool, which this policy never gates.
--
-- Every pre-existing branch is unchanged for rows where resource_owner_id IS
-- NULL (org/shared resources keep team behavior).

ALTER TABLE kernel.approval_requests
  ADD COLUMN IF NOT EXISTS resource_owner_id uuid REFERENCES kernel.users(id);

CREATE INDEX IF NOT EXISTS approval_requests_resource_owner_idx
  ON kernel.approval_requests (resource_owner_id) WHERE resource_owner_id IS NOT NULL;

DROP POLICY IF EXISTS approval_requests_select ON kernel.approval_requests;
CREATE POLICY approval_requests_select ON kernel.approval_requests FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      -- Personal-resource approvals: requester + resolved owner ONLY.
      (
        resource_owner_id IS NOT NULL
        AND (
          requested_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          OR resource_owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
      )
      OR (
        resource_owner_id IS NULL
        AND (
          requested_by = current_setting('app.current_user_id', true)::uuid
          OR EXISTS (
            SELECT 1
            FROM (VALUES ('kernel:approvals:admin'), ('kernel:users:admin')) AS required(scope)
            WHERE EXISTS (
              SELECT 1 FROM kernel.user_scope_grants g
              WHERE g.user_id = current_setting('app.current_user_id', true)::uuid
                AND g.org_id = current_setting('app.current_org_id', true)::uuid
                AND (g.scope = '*' OR g.scope = required.scope OR left(required.scope, length(g.scope) + 1) = g.scope || ':')
            )
            OR EXISTS (
              SELECT 1
              FROM kernel.user_roles ur
              JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
              WHERE ur.user_id = current_setting('app.current_user_id', true)::uuid
                AND ur.org_id = current_setting('app.current_org_id', true)::uuid
                AND (rsg.scope = '*' OR rsg.scope = required.scope OR left(required.scope, length(rsg.scope) + 1) = rsg.scope || ':')
            )
          )
          OR (
            current_setting('app.current_user_id', true)::uuid = ANY(notify_user_ids)
            AND EXISTS (
              SELECT 1
              FROM (SELECT split_part(tool_name, ':', 1) || ':approve' AS scope) AS required
              WHERE EXISTS (
                SELECT 1 FROM kernel.user_scope_grants g
                WHERE g.user_id = current_setting('app.current_user_id', true)::uuid
                  AND g.org_id = current_setting('app.current_org_id', true)::uuid
                  AND (g.scope = '*' OR g.scope = required.scope OR left(required.scope, length(g.scope) + 1) = g.scope || ':')
              )
              OR EXISTS (
                SELECT 1
                FROM kernel.user_roles ur
                JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
                WHERE ur.user_id = current_setting('app.current_user_id', true)::uuid
                  AND ur.org_id = current_setting('app.current_org_id', true)::uuid
                  AND (rsg.scope = '*' OR rsg.scope = required.scope OR left(required.scope, length(rsg.scope) + 1) = rsg.scope || ':')
              )
            )
          )
          OR (
            tool_name LIKE 'tickets:%'
            AND app_tickets.app_has_scope('tickets:tickets:read')
          )
          OR (
            tool_name LIKE 'mail:%'
            AND app_tickets.app_has_scope('mail:conversations:read')
          )
        )
      )
    )
  );
