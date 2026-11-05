-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-inbox attention cutoff. Historical imports (Freshdesk) and full-mailbox
-- syncs create tickets whose last activity predates the inbox going live in
-- Liaison. Those tickets are real records but not live work, yet they satisfy
-- the attention rules (awaiting_agent / unassigned / nudge_due / sla_risk) and
-- flood the feed with hundreds of stale items on first login.
--
-- When set, tickets whose relevant activity timestamp is OLDER than the cutoff
-- are excluded from automatic attention rules. Rule 4 (followup_due) is not
-- filtered: a follow-up is an explicit agent-set reminder. Tickets that get
-- NEW activity after the cutoff qualify again (the rules compare the activity
-- timestamp, not created_at).
--
-- Import tooling sets this to the import time; also editable via the inbox
-- admin tools.

ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS attention_cutoff_at TIMESTAMPTZ;
