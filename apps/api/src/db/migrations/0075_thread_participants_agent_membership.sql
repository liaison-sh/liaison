-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4a-T07: kernel.thread_participants seats agents in the SAME table as humans.
-- Journal high-water when this file was written: 1900000058000
-- (0074_agent_runs_agent_id); this migration takes 1900000059000.
--
-- spec-home.md "One channel type": agent and human membership stay one
-- row-shape, so user_id becomes NULLABLE and a nullable agent_id joins it, with
-- a CHECK asserting EXACTLY ONE of the two is set. participant_type ('user' |
-- 'agent') is the readable discriminator, defaulting to 'user' so every
-- pre-existing row is correct without a backfill.
--
-- TWO PARTIAL unique indexes, not one index over both columns: Postgres does
-- not treat two NULLs as equal, so a single (thread_id, user_id, agent_id)
-- unique index would admit the same agent twice on one thread (both rows carry
-- user_id NULL and so never collide). The human index keeps its name and its
-- meaning, now predicated on user_id IS NOT NULL.
--
-- The foreign key is COMPOSITE (agent_id, org_id) -> kernel.agents (id, org_id),
-- per the class 0072 closed: thread_participants carries an org_id, so a
-- single-column key would seat an org-B agent in an org-A thread. It reuses the
-- shared agents_id_org_uk unique key.
--
-- ON DELETE CASCADE, a BINDING row (0073's reading) rather than history: a
-- hard-deleted agent (a personal agent's erasure) leaves no membership behind.
-- SET NULL is not available here in any case: it would leave a row with neither
-- a user nor an agent, which the CHECK above refuses.
--
-- Re-runnable: IF NOT EXISTS throughout, the key and the check guarded by a
-- catalog lookup, the index swap by DROP INDEX IF EXISTS.
ALTER TABLE kernel.thread_participants ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE kernel.thread_participants
  ADD COLUMN IF NOT EXISTS participant_type text NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE kernel.thread_participants
  ADD COLUMN IF NOT EXISTS agent_id uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'thread_participants_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.thread_participants
      ADD CONSTRAINT thread_participants_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'thread_participants_one_of_user_or_agent'
       AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.thread_participants
      ADD CONSTRAINT thread_participants_one_of_user_or_agent
      CHECK ((user_id IS NOT NULL) <> (agent_id IS NOT NULL));
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "kernel"."thread_participants_thread_user_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_participants_thread_user_idx"
  ON "kernel"."thread_participants" USING btree ("thread_id","user_id")
  WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_participants_thread_agent_idx"
  ON "kernel"."thread_participants" USING btree ("thread_id","agent_id")
  WHERE agent_id IS NOT NULL;
