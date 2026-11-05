-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A trailing `:*` grant decides the approvals it covers, and now SEES them.
--
-- `hasScope()` (modules/permissions/permissions.ts) is the one definition of what
-- a grant covers: `*`, the scope itself, a bare parent (`kpi` covers
-- `kpi:approve`), and a TRAILING `:*` wildcard (`kpi:*` and `kpi:comments:*`
-- cover everything under their prefix; a mid-segment `*` covers nothing but
-- itself). `scopeMatchesFragment` (permissions/eligible-approvers.ts) gained the
-- trailing-wildcard branch on 2026-09-23, so a `kpi:*` holder is notified as an
-- eligible approver of a kpi approval. The `approval_requests_select` policy
-- still inlined the old three-branch predicate, so that approver was notified
-- but could not SELECT the row they were asked to decide, and a `kernel:*`
-- holder was not treated as `kernel:approvals:admin`.
--
-- The policy is recreated from 0029 with the fourth branch added to each of its
-- four inline scope predicates (the admin branches and the notified-approver
-- branch, for direct and role grants), exactly as `scopeMatchesFragment` writes
-- it. Everything else, including the tickets/mail shared-surface branches
-- (app_has_scope already accepts `<prefix>:*`), is byte-identical to 0029.
-- Pinned by modules/approvals/authority-rls-parity.test.ts, whose TS mirror
-- is written over hasScope.
--
-- Widening only: every row visible before stays visible. Idempotent (DROP IF
-- EXISTS, then CREATE).

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
                AND (g.scope = '*' OR g.scope = required.scope OR left(required.scope, length(g.scope) + 1) = g.scope || ':'
                OR (right(g.scope, 2) = ':*' AND strpos(left(g.scope, length(g.scope) - 1), '*') = 0 AND left(required.scope, length(g.scope) - 1) = left(g.scope, length(g.scope) - 1)))
            )
            OR EXISTS (
              SELECT 1
              FROM kernel.user_roles ur
              JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
              WHERE ur.user_id = current_setting('app.current_user_id', true)::uuid
                AND ur.org_id = current_setting('app.current_org_id', true)::uuid
                AND (rsg.scope = '*' OR rsg.scope = required.scope OR left(required.scope, length(rsg.scope) + 1) = rsg.scope || ':'
                OR (right(rsg.scope, 2) = ':*' AND strpos(left(rsg.scope, length(rsg.scope) - 1), '*') = 0 AND left(required.scope, length(rsg.scope) - 1) = left(rsg.scope, length(rsg.scope) - 1)))
            )
          )
          OR (
            current_setting('app.current_user_id', true)::uuid = ANY(notify_user_ids)
            AND EXISTS (
              SELECT 1
              FROM (SELECT COALESCE(approve_scope, split_part(tool_name, ':', 1) || ':approve') AS scope) AS required
              WHERE EXISTS (
                SELECT 1 FROM kernel.user_scope_grants g
                WHERE g.user_id = current_setting('app.current_user_id', true)::uuid
                  AND g.org_id = current_setting('app.current_org_id', true)::uuid
                  AND (g.scope = '*' OR g.scope = required.scope OR left(required.scope, length(g.scope) + 1) = g.scope || ':'
                OR (right(g.scope, 2) = ':*' AND strpos(left(g.scope, length(g.scope) - 1), '*') = 0 AND left(required.scope, length(g.scope) - 1) = left(g.scope, length(g.scope) - 1)))
              )
              OR EXISTS (
                SELECT 1
                FROM kernel.user_roles ur
                JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
                WHERE ur.user_id = current_setting('app.current_user_id', true)::uuid
                  AND ur.org_id = current_setting('app.current_org_id', true)::uuid
                  AND (rsg.scope = '*' OR rsg.scope = required.scope OR left(required.scope, length(rsg.scope) + 1) = rsg.scope || ':'
                OR (right(rsg.scope, 2) = ':*' AND strpos(left(rsg.scope, length(rsg.scope) - 1), '*') = 0 AND left(required.scope, length(rsg.scope) - 1) = left(rsg.scope, length(rsg.scope) - 1)))
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
