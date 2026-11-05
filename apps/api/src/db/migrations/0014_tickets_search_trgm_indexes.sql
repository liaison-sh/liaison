-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Tickets free-text search (U4.16 finding 2): at 4,730-ticket / ~30,235-message
-- corpus scale, `tickets:search`'s free-text predicate (searchTickets in
-- apps/tickets/search.ts) does `subject ILIKE '%term%' OR handle ILIKE '%term%'
-- OR EXISTS (... m.text_body ILIKE '%term%')` -- a leading-wildcard ILIKE has no
-- btree support, so every one of these predicates forces a sequential scan, and
-- the EXISTS is a CORRELATED subquery re-scanning app_tickets.messages once per
-- ticket row. A multi-term query runs this shape THREE times per call (the
-- always-on COUNT(*) total, the precise AND page query, and -- when the AND page
-- underfills -- the OR recall-widening fallback), so the real query cost scales
-- with tickets x messages-per-ticket x terms x 3. That is the mechanism behind
-- the observed intermittent 500s on tickets:search under real corpus load
-- (confirmed live on staging 2026-07-06: "App execution timed out" at
-- executeInSandbox for tickets:search, first domino in the sandbox-wedge
-- incident -- see rls.ts's new acquire-timeout guard for the reclaim half of
-- that fix).
--
-- Fix: pg_trgm GIN indexes on the three ILIKE targets. `%term%` (both sides
-- wildcarded) cannot use a btree index but CAN use a trigram GIN index via the
-- `gin_trgm_ops` operator class, which indexes 3-character substrings and lets
-- Postgres answer a leading-wildcard ILIKE with an index scan instead of a full
-- table scan. This does not change the query text (searchTickets already emits
-- plain `ILIKE`) or any result semantics -- it is a pure index addition;
-- `pg_trgm` is a standard, bundled Postgres extension (contrib), not a new
-- third-party dependency.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_subject_trgm
  ON app_tickets.tickets USING GIN (subject gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_handle_trgm
  ON app_tickets.tickets USING GIN (handle gin_trgm_ops);
--> statement-breakpoint
-- Messages: the EXISTS subquery filters `m.ticket_id = tickets.id AND m.org_id =
-- :orgId AND m.text_body ILIKE '%term%'` -- index the trigram body text; the
-- planner combines it with the existing ticket_id/org_id predicates via a
-- bitmap index scan instead of scanning every message row per ticket.
CREATE INDEX IF NOT EXISTS idx_app_tickets_messages_text_body_trgm
  ON app_tickets.messages USING GIN (text_body gin_trgm_ops);
