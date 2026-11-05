-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Harden three more RLS sites against an EMPTY (not NULL) `app.current_org_id`
-- GUC, the same class of bug 0012 already fixed for
-- app_invoicing.deferred_events.
--
-- Root cause: `current_setting('app.current_org_id', true)` returns '' (empty
-- string), not NULL, when no RLS context is set. The generated policy cast
-- `''::uuid` is a HARD Postgres error (SQLSTATE 22P02, "invalid input syntax
-- for type uuid"), not a 0-row filter — so a caller with an empty orgId
-- (e.g. getTicket / markRead invoked outside a request's RLS context) gets a
-- thrown error instead of just seeing no rows.
--
-- Three sites were missed by 0012's sweep:
--   - policy contacts_org_rls on kernel.contacts (0000_initial.sql)
--   - policy categories_select on app_tickets.categories (0000_initial.sql)
--   - function app_tickets.can_read_ticket() (0000_initial.sql)
--
-- 0000_initial.sql is FROZEN — this reproduces each definition exactly,
-- replacing only the org-condition cast with
-- `NULLIF(current_setting('app.current_org_id', true), '')::uuid`.

DROP POLICY IF EXISTS contacts_org_rls ON kernel.contacts;
CREATE POLICY contacts_org_rls ON kernel.contacts
  FOR ALL TO liaison_rls
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS categories_select ON app_tickets.categories;
CREATE POLICY categories_select ON app_tickets.categories
  FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      current_setting('app.current_scopes', true) = '*'
      OR EXISTS (
        SELECT 1 FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
        WHERE g = '*'
          OR g = 'tickets'
          OR g = 'tickets:*'
          OR g = 'tickets:tickets'
          OR g = 'tickets:tickets:read'
          OR starts_with('tickets:tickets:read', g || ':')
      )
    )
  );
--> statement-breakpoint

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
        OR t.team = ANY(ARRAY(SELECT jsonb_array_elements_text(current_setting('app.current_dimensions', true)::jsonb->'tickets:team')))
      )
      AND (
        (current_setting('app.current_dimensions', true)::jsonb ? '*' AND current_setting('app.current_dimensions', true)::jsonb->'*' @> '"*"'::jsonb)
        OR (current_setting('app.current_dimensions', true)::jsonb ? 'tickets:sensitivity' AND current_setting('app.current_dimensions', true)::jsonb->'tickets:sensitivity' @> '"*"'::jsonb)
        OR (CASE t.sensitivity WHEN 'internal' THEN 0 WHEN 'confidential' THEN 1 WHEN 'restricted' THEN 2 END) <= (
          SELECT MAX(CASE v WHEN 'internal' THEN 0 WHEN 'confidential' THEN 1 WHEN 'restricted' THEN 2 END)
          FROM jsonb_array_elements_text(current_setting('app.current_dimensions', true)::jsonb->'tickets:sensitivity') AS v
        )
      )
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
ALTER FUNCTION app_tickets.can_read_ticket(UUID) OWNER TO liaison_admin;
