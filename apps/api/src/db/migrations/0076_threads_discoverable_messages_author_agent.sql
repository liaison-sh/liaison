-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4a-T08: threads.discoverable (a channel) and messages.author_agent_id (A8).
-- Journal high-water when this file was written: 1900000059000
-- (0075_thread_participants_agent_membership); this migration takes
-- 1900000060000.
--
-- discoverable = a channel: org-wide listable and joinable (spec-home.md "One
-- channel type"). threads.type gains NO new value; the flag is orthogonal to it
-- and defaults to false, so no pre-existing thread becomes public.
--
-- author_agent_id names the SPEAKING agent, so the front end resolves a name
-- and an avatar from the row instead of a client-side sentinel.
--
-- The foreign key is COMPOSITE (author_agent_id, org_id) -> kernel.agents
-- (id, org_id), per the class 0072 closed. ON DELETE SET NULL, a HISTORY row
-- (0070's audit_log reading, not 0075's binding one): a hard-deleted agent must
-- cost the NAME on a finished message, never the message and the conversation
-- around it. The column list, SET NULL (author_agent_id), is what keeps the
-- cascade from also nulling the NOT NULL org_id half of the key.
--
-- What this migration does NOT enforce, and why. A8 reads "NOT NULL whenever
-- author_type = 'agent'", and that half cannot arrive before the WRITERS name
-- the speaking agent (the dispatch slice): every agent message the product
-- persists today carries author_type = 'agent' with no agent id, so enforcing
-- it here would refuse every agent reply in the running system, and a CHECK
-- constraint would also refuse to validate against the rows already in the
-- table. It cannot be a CHECK even later: the composite key's ON DELETE SET
-- NULL must be able to clear attribution when a personal agent is hard-deleted
-- (the GDPR erasure cascade deletes the agent and deliberately RETAINS its
-- messages), and a CHECK would turn that cascade into a 23514 and block the
-- erasure outright. A write-time TRIGGER is the shape that survives both, so
-- the guard is a trigger here and gains the "an agent row names an agent" half
-- in the slice that makes the writers set the column.
--
-- What the trigger DOES enforce today is the other direction, which is true of
-- every row already in the table: attribution and authorship must agree, so a
-- message that NAMES an agent must be agent-authored. That is what stops a
-- human message from being rendered as the agent speaking.
--
-- Re-runnable: IF NOT EXISTS throughout, the key guarded by a catalog lookup,
-- the function CREATE OR REPLACE and the trigger dropped first.
ALTER TABLE kernel.threads
  ADD COLUMN IF NOT EXISTS discoverable boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE kernel.messages
  ADD COLUMN IF NOT EXISTS author_agent_id uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_author_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.messages
      ADD CONSTRAINT messages_author_agent_org_fk
      FOREIGN KEY (author_agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE SET NULL (author_agent_id);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_author_agent_idx"
  ON "kernel"."messages" USING btree ("author_agent_id")
  WHERE author_agent_id IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.messages_agent_author_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.author_agent_id IS NOT NULL AND NEW.author_type <> 'agent' THEN
    RAISE EXCEPTION
      'messages.author_agent_id may only name an agent on an agent-authored message'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_agent_author_guard ON kernel.messages;
--> statement-breakpoint
CREATE TRIGGER messages_agent_author_guard
  BEFORE INSERT OR UPDATE ON kernel.messages
  FOR EACH ROW EXECUTE FUNCTION kernel.messages_agent_author_guard();
