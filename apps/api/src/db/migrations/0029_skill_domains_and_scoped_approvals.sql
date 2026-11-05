-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Dimension-constrained approvals (generic kernel primitive) + skill domains
-- (its first user).
--
-- Skills get an optional `domain` (e.g. "shipping", "finance"). Approval rows
-- get two new columns so the approve-audience for a gated tool is no longer
-- hardwired to `split_part(tool_name,':',1) || ':approve'`:
--
--   * `approve_scope`        — the CUSTOM scope that decides this approval, when
--     the tool declares one (e.g. skills mutations require `kernel:skills:approve`
--     rather than the derived `kernel:approve`). NULL keeps today's derived scope.
--   * `dimension_constraint` — an optional { key, values } grant the decider (and
--     the notified audience) must cover on that dimension to see/decide the row
--     (e.g. `kernel:skills_domain = ["shipping"]`). NULL = unconstrained (today).
--
-- The SELECT policy's approver branch is recreated so a holder of a CUSTOM
-- approve scope (`kernel:skills:approve`) actually SEES the rows they can decide:
-- the derived `<app>:approve` scope becomes
--   COALESCE(approve_scope, split_part(tool_name, ':', 1) || ':approve').
-- Everything else in 0028's policy is kept byte-identical (the personal-resource
-- branch, the generic admin branches, and the tickets/mail shared-surface
-- branches). The dimension filter is enforced in application code (decide.ts /
-- execute-tool.ts eligible-approver audience), NOT in RLS: RLS keeps letting a
-- custom-approve-scope holder READ the row (so they can find + open it), and the
-- decide path denies the actual decision when their dimension grant does not
-- cover the constraint.
--
-- 0000 is FROZEN; this is a new forward migration, safe on existing data
-- (both columns nullable, no backfill; existing rows read as unconstrained with
-- the derived approve scope, exactly as before).

ALTER TABLE kernel.skills
  ADD COLUMN IF NOT EXISTS domain text;

ALTER TABLE kernel.approval_requests
  ADD COLUMN IF NOT EXISTS approve_scope text;

ALTER TABLE kernel.approval_requests
  ADD COLUMN IF NOT EXISTS dimension_constraint jsonb;

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
              FROM (SELECT COALESCE(approve_scope, split_part(tool_name, ':', 1) || ':approve') AS scope) AS required
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
