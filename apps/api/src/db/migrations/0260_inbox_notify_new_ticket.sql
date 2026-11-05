-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-inbox "Notify on new ticket" switch. A new ticket in a flagged inbox raises
-- an attention item for the holders of tickets:inboxes:admin (the tickets app's
-- translation of `ticket:create`). Off by default, so an existing inbox stays as
-- quiet as it was. A monitoring inbox (suppress_attention) stays silent either
-- way. Configured in Tickets settings > Inboxes. Re-runnable.

-- A busy table fails the migration fast instead of queueing every reader behind it.
SET LOCAL lock_timeout = '30s';

ALTER TABLE app_tickets.inboxes
  ADD COLUMN IF NOT EXISTS notify_new_ticket BOOLEAN NOT NULL DEFAULT false;
