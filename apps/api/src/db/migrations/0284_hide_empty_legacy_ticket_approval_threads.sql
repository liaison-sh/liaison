-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Hides the empty "Ticket approval: <handle>" threads an earlier approval path
-- left in people's thread lists.
--
-- That path anchored a ticket's gated action to a plain thread: type 'thread',
-- created_from {"app":"tickets","entityType":"ticket",...}, a "Ticket approval:"
-- title (or its French copy, "Validation du ticket :"), shown in the list, and
-- never given a message. Gated actions now anchor to a hidden thread of type
-- 'approval' (execute-tool.ts), so nothing creates these any more, but the old
-- rows still sit in the sidebar and their participants leave them one by one.
--
-- The rows are hidden, not deleted: approval_requests.thread_id and the audit
-- trail keep pointing at them. Only a thread with no message at all (soft-deleted
-- ones count) is touched, so a conversation someone actually had stays visible.
-- updated_at is left alone. Re-runnable: a hidden row no longer matches.
--
-- kernel.threads forces row-level security and its policies name the runtime
-- roles only, so the UPDATE runs as liaison_admin (BYPASSRLS), which every
-- migration login is a member of (0000 grants it; see 0283).

-- The UPDATE takes row locks: fail the deploy cleanly behind a long transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
UPDATE kernel.threads t
SET hidden_from_list = true
WHERE t.type = 'thread'
  AND NOT t.hidden_from_list
  AND t.created_from->>'app' = 'tickets'
  AND t.created_from->>'entityType' = 'ticket'
  AND (t.title LIKE 'Ticket approval:%' OR t.title LIKE 'Validation du ticket :%')
  AND NOT EXISTS (SELECT 1 FROM kernel.messages m WHERE m.thread_id = t.id);
--> statement-breakpoint
RESET ROLE;
