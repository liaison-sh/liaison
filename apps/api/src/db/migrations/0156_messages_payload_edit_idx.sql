-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The approvals list shows each approval's last payload edit, read from the
-- system message the edit path posts into the approval's thread. Many
-- approvals share one thread (an MCP connection's or a routine's), and those
-- threads hold thousands of messages, while payload edits are a few hundred
-- rows in the whole table. Through (thread_id, created_at) alone the lookup
-- visited every message of the thread once per approval and ran the messages
-- RLS policy (thread participant probe plus the required-scopes match) on each:
-- 100k+ buffer touches for one list call, past the statement timeout under load.
--
-- This partial index holds only the payload-edit rows, so the newest edit of a
-- thread is one index probe and the policy runs on the rows actually returned.
-- The predicate must stay byte-identical to the one in
-- modules/approvals/list.ts or the planner cannot use it.
--
-- Locking: the migrator runs each file in one transaction, so CONCURRENTLY is
-- unavailable. CREATE INDEX takes SHARE (reads continue, writes wait); at
-- production's size (22k rows, 9 MB heap) the build is well under a second, and
-- lock_timeout makes a deploy that cannot get the lock fail cleanly instead of
-- queueing every message insert behind it. Idempotent: IF NOT EXISTS.
SELECT set_config('lock_timeout', '30s', true);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_payload_edit_idx
  ON kernel.messages (thread_id, created_at)
  WHERE author_type = 'system' AND (metadata ->> 'type') = 'payload-edit';
