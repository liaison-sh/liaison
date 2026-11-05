-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Tickets: first-class API inboxes (routing buckets), decoupled from reply-from.
--
-- Until now an `app_tickets.inboxes` row was ALWAYS a connected mailbox: it
-- conflated the receiving bucket, the send transport (connected_account), and
-- the reply-from identity (email_address). API-submitted tickets (bug reports,
-- website contact, per-tenant endpoints) had nowhere to land but the shared
-- default inbox. This adds a second inbox `kind`:
--
--   'mailbox' -- unchanged: backed by a connected account; receives + sends.
--   'api'     -- a receiving bucket only: no connected account, no mailbox.
--              Replies for its tickets are sent through a reply-via mailbox
--              (reply_via_inbox_id, default = the org's is_default_for_create
--              mailbox), so an org can "always reply from support@" regardless
--              of which bucket a ticket sits in. `reply_from_email` is an
--              optional per-source From override.
--
-- Postgres treats NULLs as DISTINCT in a UNIQUE constraint, so the existing
-- UNIQUE (org_id, email_address) already permits many NULL-email api inboxes
-- per org -- no unique-index rework is needed, only the NOT NULL drops.

ALTER TABLE app_tickets.inboxes ADD COLUMN kind TEXT NOT NULL DEFAULT 'mailbox';
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD CONSTRAINT inboxes_kind_check CHECK (kind IN ('mailbox', 'api'));
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ALTER COLUMN connected_account_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ALTER COLUMN email_address DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN reply_via_inbox_id UUID REFERENCES app_tickets.inboxes(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD COLUMN reply_from_email TEXT;
--> statement-breakpoint
ALTER TABLE app_tickets.inboxes ADD CONSTRAINT inboxes_kind_shape_check CHECK (
  (kind = 'mailbox' AND connected_account_id IS NOT NULL AND email_address IS NOT NULL)
  OR
  (kind = 'api' AND connected_account_id IS NULL AND is_default_for_create = false)
);
--> statement-breakpoint
ALTER TABLE app_tickets.api_keys ADD COLUMN inbox_id UUID REFERENCES app_tickets.inboxes(id) ON DELETE CASCADE;
