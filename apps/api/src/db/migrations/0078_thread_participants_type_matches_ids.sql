-- SPDX-License-Identifier: FSL-1.1-ALv2
-- FX1 item 1: kernel.thread_participants.participant_type must agree with the
-- id columns it describes.
-- Journal high-water when this file was written: 1900000061000
-- (0077_threads_select_discoverable); this migration takes 1900000062000.
--
-- 0075 made participant_type a plain text discriminator with DEFAULT 'user' and
-- constrained only the pair of id columns (exactly one set). Nothing tied the
-- two together, so two lies were storable:
--   * a row with agent_id set left at the default 'user' is an INVISIBLE agent
--     seat: the FK and the partial unique index are satisfied, but every read
--     that filters on participant_type = 'agent' misses it;
--   * a human row claiming 'agent' is the same lie the other way round.
-- The equivalence below states it once, for both directions, and (agent_id is
-- the other half of 0075's exactly-one CHECK) needs no clause of its own.
--
-- The constraint is added VALIDATED: every existing row is checked as part of
-- this statement, so a database carrying one of those rows fails the migration
-- loudly instead of shipping a table that silently disagrees with its reads.
--
-- Named to sort AFTER thread_participants_one_of_user_or_agent: Postgres
-- evaluates a table's CHECK constraints in constraint-NAME order, and 0075's
-- suite pins the error a row violating BOTH reports.
--
-- Re-runnable: the ADD CONSTRAINT is guarded by a catalog lookup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'thread_participants_type_matches_ids'
       AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.thread_participants
      ADD CONSTRAINT thread_participants_type_matches_ids
      CHECK ((participant_type = 'user') = (user_id IS NOT NULL));
  END IF;
END $$;
