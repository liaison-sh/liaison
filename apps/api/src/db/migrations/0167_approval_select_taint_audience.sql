-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A tainted shared-surface draft is readable through the surface only by holders of its taint.
--
-- Rule 8 of the scope taint on writes (modules/agent/scopes/scope-taint.ts, 2026-10-20): a
-- gated ticket or mail draft written on a turn that read data some readers of the ticket or
-- conversation lack now PARKS for approval instead of being refused, because approving it is the
-- disclosure decision. Until then the draft body must not reach those readers, yet the two
-- shared-surface branches of `approval_requests_select` let every ticket (or conversation)
-- reader SELECT every tickets:* (or mail:*) approval, and every reading surface (the ticket's
-- pending drafts, the ticket-mode approval list, decide, edit) reads through this policy.
--
-- The dispatch records the scopes such a proposal's audience must hold on the row
-- (`metadata.taintAudienceMustHold`, a JSON array of scopes). Both shared-surface branches now
-- also require the session to hold every one of them (`app_has_scope`, the same session-scope
-- check the branch already uses). A row without the key, or with a non-array value treated as
-- empty, is unchanged; the requester, admin and notified-approver branches are unchanged (the
-- notified approvers were already narrowed to holders of those scopes at creation).
--
-- Narrowing only, and only for rows carrying the key, which no row did before this release.
-- Everything else is byte-identical to 0104. Idempotent (DROP IF EXISTS, then CREATE). Pinned by
-- modules/approvals/authority-rls-parity.test.ts.

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
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(metadata->'taintAudienceMustHold') = 'array'
                  THEN metadata->'taintAudienceMustHold' ELSE '[]'::jsonb END
              ) AS must(scope)
              WHERE NOT app_tickets.app_has_scope(must.scope)
            )
          )
          OR (
            tool_name LIKE 'mail:%'
            AND app_tickets.app_has_scope('mail:conversations:read')
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(metadata->'taintAudienceMustHold') = 'array'
                  THEN metadata->'taintAudienceMustHold' ELSE '[]'::jsonb END
              ) AS must(scope)
              WHERE NOT app_tickets.app_has_scope(must.scope)
            )
          )
        )
      )
    )
  );
