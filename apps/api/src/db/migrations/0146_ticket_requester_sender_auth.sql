-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Ticket requester and participants, per-message sender authentication verdict,
-- and received time.
--
-- requester_email: who the ticket is for. A reply goes to the requester (plus
--   participants), never to "whoever wrote last". Backfilled from the earliest
--   inbound message; new tickets set it at creation.
-- participant_emails: further addresses on the thread that a trusted sender
--   copied in. Lowercased, de-duplicated.
-- related_ticket_id: set when a message that only matched an existing ticket by
--   subject handle or external reference came from a stranger and was opened as
--   a NEW ticket instead of joining the thread.
-- messages.sender_auth: the receiving provider's SPF/DKIM/DMARC verdict for the
--   From address (pass, fail, none). 'none' = no trusted verdict.
-- messages.received_at: when WE stored the message. The Date header (sent_at) is
--   chosen by the sender and must never decide trust or ordering of "latest".
ALTER TABLE app_tickets.tickets
  ADD COLUMN IF NOT EXISTS requester_email text,
  ADD COLUMN IF NOT EXISTS participant_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS related_ticket_id uuid REFERENCES app_tickets.tickets(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE app_tickets.messages
  ADD COLUMN IF NOT EXISTS sender_auth text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz;
--> statement-breakpoint
UPDATE app_tickets.messages SET received_at = created_at WHERE received_at IS NULL;
--> statement-breakpoint
ALTER TABLE app_tickets.messages
  ALTER COLUMN received_at SET DEFAULT now(),
  ALTER COLUMN received_at SET NOT NULL;
--> statement-breakpoint
ALTER TABLE app_tickets.messages DROP CONSTRAINT IF EXISTS messages_sender_auth_check;
--> statement-breakpoint
ALTER TABLE app_tickets.messages
  ADD CONSTRAINT messages_sender_auth_check CHECK (sender_auth IS NULL OR sender_auth IN ('pass', 'fail', 'none'));
--> statement-breakpoint
UPDATE app_tickets.tickets t
SET requester_email = lower(m.from_email)
FROM (
  SELECT DISTINCT ON (ticket_id) ticket_id, from_email
  FROM app_tickets.messages
  WHERE kind = 'inbound' AND from_email IS NOT NULL AND from_email <> ''
  ORDER BY ticket_id, created_at ASC, id ASC
) m
WHERE m.ticket_id = t.id AND t.requester_email IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_app_tickets_messages_ticket_received
  ON app_tickets.messages (org_id, ticket_id, received_at DESC);
