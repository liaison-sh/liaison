-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-inbox SLA exemption. Some inboxes (bug-report / monitoring buckets) hold
-- telemetry that never awaits an agent reply, so their tickets should carry NO
-- SLA. This is a first-class, admin-configurable per-inbox toggle (a "virtual
-- box" setting), independent of suppress_attention: an operator flips it per
-- inbox in the inbox settings, it is not hardcoded to any other flag.
--
-- A ticket created in an sla_exempt inbox gets a NULL sla_deadline + NULL
-- sla_active_started_at, which reads as "no SLA" everywhere (every SLA predicate
-- is a comparison against sla_deadline that a NULL value never satisfies -- the
-- breach cron, needs-attention, backlog-health bySla, sla-report, and the
-- slaBreached search all skip NULL-deadline tickets), so no countdown/breach
-- ever surfaces. Make the deadline nullable to represent that. sla_target_seconds
-- stays NOT NULL (kept for reference); only the live deadline is nulled.
ALTER TABLE app_tickets.inboxes ADD COLUMN IF NOT EXISTS sla_exempt BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE app_tickets.tickets ALTER COLUMN sla_deadline DROP NOT NULL;
