-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Indexes that let a person's own activity be read without scanning the org's.
--
-- The projects "Recently involved" view (apps/projects/service/
-- recently-involved.ts) lists the tasks a person commented on or was
-- mentioned in over the last N days (at most 90). Its other sources already
-- have an index on the person (audit_log_org_actor_idx, tasks created_by and
-- assignee_id). These two did not:
-- - kernel.messages by author: the comments a person wrote were found by
--   scanning every message of the org in the window, each through the
--   message SELECT policy (50 000 rows checked to find a few hundred on a
--   seeded org);
-- - kernel.attention_events by recipient: only unread rows had an index on the
--   user, so a person's read mentions were a sequential scan of the table.
--   The same index also serves the user_id foreign key (ON DELETE CASCADE).
--
-- Additive: indexes only, no data change. The migrator runs each file in one
-- transaction, so CONCURRENTLY is unavailable; each build blocks writes to its
-- table while it runs. Build times measured for a btree on (uuid, timestamptz) over that many rows on a laptop Postgres (rows, ms): about half a second per 500 000 messages.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- index-build: kernel.messages 500000 540
CREATE INDEX IF NOT EXISTS messages_author_created_idx ON kernel.messages (author_id, created_at);
--> statement-breakpoint
-- index-build: kernel.attention_events 50000 25
CREATE INDEX IF NOT EXISTS attention_events_user_occurred_idx ON kernel.attention_events (user_id, occurred_at);
