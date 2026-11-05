-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Reconcile the divergent-deployment migration histories (a deployment branch
-- rebased onto main, 2026-07-06).
--
-- Both live deployments applied a DIFFERENT migration under the 0009/0010
-- slots — and, because both journals used the same synthetic day-spaced
-- timestamps, both databases share the same last-applied `created_at`
-- (1783382400000). Drizzle's migrator only applies entries with a NEWER
-- timestamp than the last applied one, so:
--
--   * a database migrated from main never ran the branch's
--     projects/trgm migrations → they were renumbered 0012/0013 with fresh
--     timestamps and made idempotent, so they apply there and no-op on the
--     branch's deployment;
--   * a database migrated from the branch never ran main's
--     0009_inbox_email_identity / 0010_message_ack_marker and NEVER WILL via
--     their original entries (timestamps are not newer than its last applied).
--     THIS migration re-executes their DDL idempotently: it creates the
--     missing columns on a branch-migrated database and no-ops on a
--     main-migrated one.
--
-- Deliberately OMITTED from the re-run: 0009's deployment-specific backfill
-- (an `UPDATE app_tickets.inboxes SET from_display_name=..., reply_to_email=...
-- WHERE is_default_for_create` with one organisation's own values). That
-- backfill belongs to that one deployment only — replaying it here would
-- stamp its identity onto every other deployment's default inbox.
-- Databases that need an inbox identity set it via the inbox admin ops / CLI.

-- 0009_inbox_email_identity (DDL only, idempotent)
ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS reply_to_email TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS signature_html TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS signature_text TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS ack_enabled BOOLEAN NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS ack_body_text TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS sla_promise_phrase TEXT NOT NULL DEFAULT 'within 2 business days';
--> statement-breakpoint
ALTER TABLE app_tickets.tickets ADD COLUMN IF NOT EXISTS ack_sent_at TIMESTAMPTZ;
--> statement-breakpoint
-- 0010_message_ack_marker (idempotent)
ALTER TABLE app_tickets.messages ADD COLUMN IF NOT EXISTS is_acknowledgement BOOLEAN NOT NULL DEFAULT false;
