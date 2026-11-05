-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-inbox ("virtual mailbox") email identity, signature, and acknowledgement
-- config. Until now the customer-facing email identity was effectively
-- hardcoded: from-name fell back to the agent's own name, there was no
-- per-inbox signature, and NOTHING sent an acknowledgement on ticket
-- creation. This makes those knobs first-class per `app_tickets.inboxes` row
-- (both `mailbox` and `api` inboxes), editable via the admin ops
-- (inboxesCreate/inboxesUpdate), the Liaison web settings panel, and the CLI
-- (`liaison tickets inbox create/update`).
--
-- Schema defaults: ack enabled, "within 2 business days" SLA promise phrase.
-- The identity columns start NULL. At send time a NULL reply_to_email falls
-- back to the inbox's own address and a NULL from_display_name to the org's
-- name (apps/tickets/render.ts), so no install inherits another org's identity.

ALTER TABLE app_tickets.inboxes ADD COLUMN reply_to_email TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN signature_html TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN signature_text TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN ack_enabled BOOLEAN NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN ack_body_text TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN sla_promise_phrase TEXT NOT NULL DEFAULT 'within 2 business days';
--> statement-breakpoint
-- This migration once backfilled the default-for-create inbox with one
-- deployment's own identity. That backfill is removed: databases that already
-- applied 0009 keep the values it wrote (the migrator skips applied entries by
-- their journal timestamp and never re-reads the file), and every other
-- database leaves the identity unset for the org to configure.
-- Send-once dedup for the acknowledgement email: a ticket may only ever
-- acknowledge once, even under a retried post-commit hook (e.g. a job retry
-- after a crash between commit and send, or the webhook + inbound path both
-- racing on the same ticket via a duplicate delivery).
ALTER TABLE app_tickets.tickets ADD COLUMN ack_sent_at TIMESTAMPTZ;
