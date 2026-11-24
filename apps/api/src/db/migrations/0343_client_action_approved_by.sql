-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who approved the send of a client action.
--
-- A send is a person's decision: their approval of the app's send, or their own click on it.
-- `approved_by_user_id` records that person (the approval's decider, or the person who clicked)
-- on every action the send made. A call the app declares, chained from that approved send (a
-- signed proposal's project and its time plan), runs as that person on their own act. NULL is a
-- send no person approved (or one made before this column): its calls stay the system's. Re-runnable.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a nullable column with no default (no rewrite); the previous release never names it
ALTER TABLE kernel.client_actions ADD COLUMN IF NOT EXISTS approved_by_user_id uuid;
