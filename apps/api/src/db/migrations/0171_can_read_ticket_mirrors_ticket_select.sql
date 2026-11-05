-- SPDX-License-Identifier: FSL-1.1-ALv2
-- app_tickets.can_read_ticket() now grants exactly what the generated
-- tickets_rls_select policy grants.
--
-- The function gates ticket_reads (markRead), ticket messages and every file
-- reached through them. Its 0044 body diverged from the policy that decides
-- whether a ticket is visible at all:
--   - team: no `t.team IS NULL` branch, so a ticket with no team (unclassified)
--     was readable only with a tickets:team grant, although the policy shows
--     it to anyone holding the ticket read scope.
--   - sensitivity: no COALESCE on either side, so a viewer with no
--     tickets:sensitivity grant (MAX() over nothing is NULL) or a row with a
--     NULL level failed, although the policy treats both as the lowest band.
-- A member could open a ticket and then fail every markRead on it with 42501.
--
-- The body below is the policy's predicate (rls-generator.ts:
-- generateScopeCheck with the read alias, generateDimensionCondition for the
-- membership dimension `team` and the level dimension `sensitivity`), read
-- through the ticket row. Re-runnable.
CREATE OR REPLACE FUNCTION app_tickets.can_read_ticket(_ticket_id UUID) RETURNS boolean AS $FUNCTION_BODY$
  SELECT EXISTS (
    SELECT 1
    FROM app_tickets.tickets t
    WHERE t.id = _ticket_id
      AND t.org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND (
        current_setting('app.current_scopes', true) = '*'
        OR EXISTS (
          SELECT 1 FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
          WHERE g = '*'
            OR g = 'tickets:tickets'
            OR g = 'tickets:tickets:write'
            OR g = 'tickets:tickets:read'
            OR g = 'tickets:*'
            OR g = 'tickets'
            OR starts_with('tickets:tickets', g || ':')
        )
      )
      AND (
        (current_setting('app.current_dimensions', true)::jsonb ? '*' AND current_setting('app.current_dimensions', true)::jsonb->'*' @> '"*"'::jsonb)
        OR (current_setting('app.current_dimensions', true)::jsonb ? 'tickets:team' AND current_setting('app.current_dimensions', true)::jsonb->'tickets:team' @> '"*"'::jsonb)
        OR t.team IS NULL
        OR t.team = ANY(ARRAY(SELECT jsonb_array_elements_text(current_setting('app.current_dimensions', true)::jsonb->'tickets:team')))
      )
      AND (
        (current_setting('app.current_dimensions', true)::jsonb ? '*' AND current_setting('app.current_dimensions', true)::jsonb->'*' @> '"*"'::jsonb)
        OR (current_setting('app.current_dimensions', true)::jsonb ? 'tickets:sensitivity' AND current_setting('app.current_dimensions', true)::jsonb->'tickets:sensitivity' @> '"*"'::jsonb)
        OR COALESCE(CASE t.sensitivity WHEN 'internal' THEN 0 WHEN 'confidential' THEN 1 WHEN 'restricted' THEN 2 END, 0) <= COALESCE((
          SELECT MAX(CASE v WHEN 'internal' THEN 0 WHEN 'confidential' THEN 1 WHEN 'restricted' THEN 2 END)
          FROM jsonb_array_elements_text(current_setting('app.current_dimensions', true)::jsonb->'tickets:sensitivity') AS v
        ), 0)
      )
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
ALTER FUNCTION app_tickets.can_read_ticket(UUID) OWNER TO liaison_admin;
