-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Tickets list query perf (D1): the hottest list endpoint (tickets:search /
-- the inbox UI) sorts by last_message_at (the default/activity_newest/
-- activity_oldest order) or by created_at (sort='oldest'/'newest'), and both
-- also drive the keyset-pagination cursor comparison. Neither column had a
-- dedicated index, so every list page and every COUNT(*) forced a sequential
-- scan once the org's ticket table grew past a small size. These mirror the
-- manifest-declared indexes (app.manifest.json `tickets.indexes`) so a DB that
-- was migrated forward (rather than re-registering the app, which runs the
-- runtime DDL) converges to the same index set.
--
-- The runtime DDL generator (modules/apps/ddl.ts) ALWAYS prepends `org_id` to
-- every manifest-declared index's column list (multi-tenant scans filter by
-- org_id first), so app.manifest.json's `["lastMessageAt"]` / `["createdAt"]`
-- entries actually produce the COMPOSITE indexes
-- `(org_id, last_message_at)` / `(org_id, created_at)` under these exact
-- names. This migration originally created BARE single-column indexes under
-- the SAME names — a DB that ran the runtime DDL (fresh org registration) and
-- a DB that only ran this migration therefore ended up with two different
-- index shapes sharing one name, and the bare shape does not serve the
-- org_id-prefixed queries the search path actually issues. DROP + recreate
-- as the composite shape so both provenances converge on the same index
-- regardless of which one a given DB took. `IF NOT EXISTS` (create) /
-- `IF EXISTS` (drop) keep this idempotent on every rerun.
DROP INDEX IF EXISTS idx_app_tickets_tickets_last_message_at;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_last_message_at
  ON app_tickets.tickets (org_id, last_message_at);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_app_tickets_tickets_created_at;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_created_at
  ON app_tickets.tickets (org_id, created_at);
