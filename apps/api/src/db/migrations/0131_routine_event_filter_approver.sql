-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Routine settings of the sales base (S26, S29, A32, A33, A52).
--
--  - routines.event_filter: the optional sender filter of a
--    `mail:message:create` routine, {fromContactIds?, fromGroupIds?}. The
--    event routine subscriber evaluates it as the routine owner, under RLS,
--    before any tick is enqueued. NULL = every mail the owner can read.
--  - routines.approver: who decides the gated drafts the routine raises.
--    'default' = the tool's deciding-scope audience (every routine today);
--    'owner' = the routine owner alone, granted only while the owner holds the
--    deciding scope (checked when saved and again when each approval row is
--    created).
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS event_filter jsonb;
--> statement-breakpoint
ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS approver text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_approver_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_approver_chk CHECK (approver IN ('default', 'owner'));
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_event_filter_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_event_filter_chk CHECK (
    event_filter IS NULL OR (jsonb_typeof(event_filter) = 'object' AND event = 'mail:message:create')
  );
