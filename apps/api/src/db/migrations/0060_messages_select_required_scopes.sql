-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P2b-T08: kernel.messages SELECT enforces read-time visibility in the database.
-- Replaces messages_select from 0000_initial.sql (the "Messages: org +
-- participant check" policy, never touched since). The org + room-membership
-- gate is kept exactly as it was; the visibility clause is ANDed onto it: the
-- viewer holds every scope in required_scopes (hasScope rules, wildcard and
-- parent aware) OR the viewer's user id is on disclosure_list. An empty
-- required_scopes is satisfied by every member, so existing rows read as before.
-- The clause is generateRequiredScopesVisibilityClause({ requiredScopesColumn:
-- "required_scopes", disclosureListColumn: "disclosure_list" }) verbatim
-- (modules/permissions/rls-generator.ts). messages_insert, messages_update and
-- messages_delete are unchanged. Re-runnable.
DROP POLICY IF EXISTS messages_select ON kernel.messages;
--> statement-breakpoint
CREATE POLICY messages_select ON kernel.messages FOR SELECT TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = messages.thread_id
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
  AND (
      (
        "required_scopes" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM unnest("required_scopes") AS req(scope)
          WHERE (
            req.scope <> ''
            AND EXISTS (
              SELECT 1
              FROM unnest(string_to_array(
                NULLIF(NULLIF(current_setting('app.current_scopes', true), ''), '__none__'), ','
              )) AS grant_row(scope)
              CROSS JOIN LATERAL (SELECT
                regexp_split_to_array(grant_row.scope, ':') AS gp,
                regexp_split_to_array(req.scope, ':') AS rp
              ) AS parts
              WHERE grant_row.scope = '*'
                OR (
                  cardinality(parts.gp) <= cardinality(parts.rp)
                  AND COALESCE(array_position(parts.gp, '*'), cardinality(parts.gp)) = cardinality(parts.gp)
                  AND NOT EXISTS (
                    SELECT 1 FROM generate_subscripts(parts.gp, 1) AS i
                    WHERE parts.gp[i] <> '*' AND parts.gp[i] IS DISTINCT FROM parts.rp[i]
                  )
                )
            )
          ) IS NOT TRUE
        )
      )
      OR COALESCE(NULLIF(current_setting('app.current_user_id', true), '') = ANY("disclosure_list"::text[]), false)
    )
);
