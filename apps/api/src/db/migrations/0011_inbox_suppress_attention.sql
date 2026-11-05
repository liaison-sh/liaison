-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-inbox "monitoring inbox" switch. Tickets arriving through a flagged
-- inbox (e.g. automated bug reports posted to an API inbox) are telemetry,
-- not conversations: they almost never need an agent reply, so they must not
-- raise attention-feed items (sla_risk / awaiting_agent / unassigned /
-- nudge_due) or count in awaiting-reply style aggregates (backlog health,
-- needs-attention sweeps). Explicit agent-set follow-ups still surface: an
-- agent snoozing a follow-up on a monitoring ticket asked for that reminder.
-- Configured in Tickets settings > Inboxes.

ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS suppress_attention BOOLEAN NOT NULL DEFAULT false;
