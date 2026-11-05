-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Drop the redundant (org_id, ticket_id, user_id) UNIQUE on ticket_reads.
--
-- The table's primary key is (ticket_id, user_id), which already makes the
-- wider tuple unique. App registration added the wider UNIQUE anyway (its
-- coverage check wanted the exact column set), and that second unique index is
-- not the arbiter of markRead's ON CONFLICT (ticket_id, user_id): two
-- concurrent first reads of one ticket by one user raced on it and one failed
-- with a unique violation (HTTP 409). Registration now treats a narrower
-- unique key as covering, so the index is not added back. Re-runnable.
ALTER TABLE app_tickets.ticket_reads
  DROP CONSTRAINT IF EXISTS ticket_reads_org_id_ticket_id_user_id_key;
