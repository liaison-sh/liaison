-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Durable marker distinguishing the ticket-creation acknowledgement message
-- from every other outbound message on a ticket. The ack email (Task 1's
-- sendTicketAcknowledgement) is inserted through the same `messages` row as a
-- normal reply/nudge/close send, so there was previously no stored way to
-- tell them apart after the fact — the frontend needs this to hide the ack
-- message from the rendered conversation (contract: `isAcknowledgement` on
-- the message DTO).

ALTER TABLE app_tickets.messages ADD COLUMN is_acknowledgement BOOLEAN NOT NULL DEFAULT false;
