-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The conversation a routine reports to.
--
-- A routine works in its own output thread (output_thread_id), which nobody
-- reads while it runs: "send me a message in one minute" ran on time and its
-- answer sat in a thread the person never opened. report_thread_id names the
-- conversation the routine was asked for in; at the end of each tick the
-- routine's final message is posted there, as the routine, through the normal
-- message path (unread state, attention, push).
--
-- NULL = no report conversation: the routine only writes its output thread, as
-- before. A deleted conversation clears it. Additive, no backfill. Re-runnable.
ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS report_thread_id uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE kernel.routines ADD CONSTRAINT routines_report_thread_fk
    FOREIGN KEY (report_thread_id) REFERENCES kernel.threads(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
