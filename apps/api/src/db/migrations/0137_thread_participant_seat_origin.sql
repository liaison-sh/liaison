-- SPDX-License-Identifier: FSL-1.1-ALv2
-- How an agent seat came to be: seat_origin = 'mention' when an @mention
-- seated it (D23a, 2026-10-12).
--
-- The DM between two people is identified by those two people. An agent a
-- person (or another agent) @mentioned in the DM keeps a seat there, and that
-- seat must not turn the DM into a group: "Message X" has to keep opening the
-- same room. Only an agent added on purpose ("Add people", an invite, the agent
-- a chat was created with) makes it a group. NULL = added on purpose, or a
-- person's seat.
--
-- Backfill: an agent seat in an untitled plain room of two people that a
-- message mentioning that agent summoned (the mention came before the seat, or
-- the seat is anchored at the reply root the mention was made under) was a
-- mention seat. A promoted agent chat's seat (created with the chat) and an
-- agent added with "Add people" have no such message and stay NULL.
-- Re-runnable.

ALTER TABLE kernel.thread_participants ADD COLUMN IF NOT EXISTS seat_origin text;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE kernel.thread_participants
    ADD CONSTRAINT thread_participants_seat_origin_vocabulary
    CHECK (seat_origin IS NULL OR seat_origin = 'mention');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
UPDATE kernel.thread_participants tp
   SET seat_origin = 'mention'
  FROM kernel.threads t
 WHERE t.id = tp.thread_id
   AND tp.participant_type = 'agent'
   AND tp.seat_origin IS NULL
   AND tp.role <> 'guest'
   AND t.type = 'thread'
   AND t.title IS NULL
   AND t.created_from IS NULL
   AND t.is_pinned = false
   AND (SELECT COUNT(*) FROM kernel.thread_participants h
         WHERE h.thread_id = t.id AND h.participant_type = 'user') = 2
   AND EXISTS (
     SELECT 1 FROM kernel.messages m
      WHERE m.thread_id = t.id
        AND m.org_id = t.org_id
        AND jsonb_typeof(m.mentions) = 'array'
        AND m.mentions @> jsonb_build_array(jsonb_build_object('type', 'agent', 'id', tp.agent_id::text))
        AND (
          m.created_at <= tp.created_at
          OR EXISTS (SELECT 1 FROM kernel.messages r
                      WHERE r.id = m.reply_root_id AND r.created_at = tp.created_at)
        )
   );
