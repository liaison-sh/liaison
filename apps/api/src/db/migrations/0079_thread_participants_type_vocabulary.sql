-- SPDX-License-Identifier: FSL-1.1-ALv2
-- FX3 item 2: kernel.thread_participants.participant_type is a closed
-- vocabulary, not free text.
-- Journal high-water when this file was written: 1900000062000
-- (0078_thread_participants_type_matches_ids); this migration takes
-- 1900000063000.
--
-- 0078 tied the discriminator to the id columns, which closed the two lies it
-- was written for. It left a third: any value that is not 'user' passes that
-- equivalence on an agent row, so a seat stored at 'bot' satisfies every
-- constraint on the table and is still invisible to every read, all of which
-- filter on participant_type = 'agent'. The same row on the human side is
-- caught by 0078, but only as a side effect of the id rule.
--
-- Two values, stated once. Plain text with a CHECK rather than a Postgres
-- enum, matching threads.type and messages.author_type in this schema: adding
-- a third participant kind later is a migration either way, and a CHECK is the
-- one that does not need ALTER TYPE.
--
-- Named to sort AFTER thread_participants_one_of_user_or_agent and BEFORE
-- thread_participants_type_matches_ids: Postgres evaluates a table's CHECK
-- constraints in constraint-NAME order, and 0075's suite pins the error a row
-- violating the exactly-one rule reports.
--
-- The constraint is added VALIDATED: every existing row is checked as part of
-- this statement, so a database already carrying an off-vocabulary seat fails
-- the migration loudly instead of shipping a table that disagrees with its
-- reads.
--
-- Re-runnable: the ADD CONSTRAINT is guarded by a catalog lookup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'thread_participants_participant_type_vocabulary'
       AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.thread_participants
      ADD CONSTRAINT thread_participants_participant_type_vocabulary
      CHECK (participant_type IN ('user', 'agent'));
  END IF;
END $$;
