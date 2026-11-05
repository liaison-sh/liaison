-- SPDX-License-Identifier: FSL-1.1-ALv2
-- tickets:search free-text under RLS (follow-up to 0014's trigram indexes).
--
-- The trigram indexes fixed the INDEX problem; this fixes the POLICY problem.
-- Measured live on staging (2026-07-07, quiet box, jit off): the search's
-- per-term `EXISTS (SELECT 1 FROM app_tickets.messages m WHERE m.ticket_id =
-- t.id AND m.text_body ILIKE '%term%')` runs in 59ms as a superuser but
-- 3,786ms under liaison_rls. Why: the RLS policy on app_tickets.messages
-- re-proves PARENT TICKET visibility (an index scan into tickets plus the full
-- scope/team/sensitivity jsonb filter) for EVERY candidate message row, and the
-- search runs this shape up to three times per call (COUNT total, precise AND
-- page, OR recall fallback). At corpus scale that is the mechanism behind
-- "tickets:search always times out" (App execution timed out via MCP).
--
-- Fix: a narrow SECURITY DEFINER helper that answers exactly one question --
-- "which ticket ids in MY org have a message whose text matches this pattern"
-- -- without re-proving ticket visibility per message. Ticket visibility is
-- NOT weakened: the caller's outer query still selects from app_tickets.tickets
-- under the full ticket RLS policy, so a ticket id returned here that the
-- caller cannot see never leaves the database.
--
-- Security posture (reviewed tradeoff): the function bypasses the MESSAGES
-- policy only, is locked to the caller's org via the app.current_org_id GUC
-- (never a parameter, so no cross-org probing), and returns opaque ticket ids.
-- Residual oracle: a caller running raw SQL as liaison_rls could learn whether
-- some message in their org matches a pattern even when the parent ticket is
-- team/sensitivity-restricted for them (existence only, never content or ids
-- they can read). No user-facing surface exposes raw SQL as liaison_rls; app
-- and sandbox query surfaces are curated. Accepted in exchange for making the
-- primary support-search path work at all under load.
--
-- p_schema exists for test worlds (w<id>_app_tickets clones); it is validated
-- against a strict identifier pattern and must end in app_tickets. Production
-- always passes 'app_tickets'.
CREATE OR REPLACE FUNCTION app_tickets.ticket_ids_matching_text(p_schema text, p_like text)
RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
BEGIN
  IF v_org IS NULL THEN
    RETURN; -- no org context, no rows
  END IF;
  IF p_schema !~ '^[a-z0-9_]*app_tickets$' THEN
    RAISE EXCEPTION 'ticket_ids_matching_text: invalid schema %', p_schema;
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT DISTINCT m.ticket_id FROM %I.messages m WHERE m.org_id = $1 AND m.text_body ILIKE $2',
    p_schema
  ) USING v_org, p_like;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app_tickets.ticket_ids_matching_text(text, text) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_tickets.ticket_ids_matching_text(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_tickets.ticket_ids_matching_text(text, text) TO liaison_rls;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_tickets.ticket_ids_matching_text(text, text) TO liaison_admin;
