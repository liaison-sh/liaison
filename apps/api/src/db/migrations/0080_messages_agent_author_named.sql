-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4b carry-in H1: arm the SECOND half of 0076's attribution guard (A8). 0076
-- armed only "a row naming an agent is agent-authored", because no writer set
-- author_agent_id yet. Every agent-authored writer now names its agent
-- (modules/threads/message.ts resolveActingAgentIdForWrite is the single
-- funnel), so the converse can be enforced: an agent-authored row NAMES the
-- speaking agent, which is what lets the front end resolve the speaker from
-- the row instead of a client-side sentinel.
--
-- BEFORE INSERT ONLY. The composite foreign key is ON DELETE SET NULL
-- (author_agent_id): a hard-deleted agent (its owner's erasure) nulls the
-- column on rows that already exist, and that UPDATE must pass. A message is
-- history; losing the agent's name never costs the row.
--
-- Re-runnable: the backfill only touches rows that are still null, and the
-- function is CREATE OR REPLACE with the trigger dropped first.

-- Legacy attribution, by the same rule the agent_chat collapse used: the
-- author's own personal agent, and only when exactly one is unambiguous.
UPDATE kernel.messages m
   SET author_agent_id = a.id
  FROM kernel.agents a
 WHERE m.author_type = 'agent'
   AND m.author_agent_id IS NULL
   AND a.org_id = m.org_id
   AND a.owner_user_id = m.author_id
   AND a.kind = 'personal'
   AND a.archived_at IS NULL
   AND (
     SELECT count(*) FROM kernel.agents a2
      WHERE a2.org_id = m.org_id AND a2.owner_user_id = m.author_id
        AND a2.kind = 'personal' AND a2.archived_at IS NULL
   ) = 1;
--> statement-breakpoint
DO $$
DECLARE unattributed bigint;
BEGIN
  SELECT count(*) INTO unattributed
    FROM kernel.messages
   WHERE author_type = 'agent' AND author_agent_id IS NULL;
  IF unattributed > 0 THEN
    -- Named, never guessed: these rows predate the writers and their author has
    -- no single live personal agent. They stay null (the trigger below is
    -- INSERT-only, so they are legal) and render as an unattributed agent.
    RAISE NOTICE 'kernel.messages: % agent-authored rows could not be attributed', unattributed;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.messages_agent_author_named()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.author_type = 'agent' AND NEW.author_agent_id IS NULL THEN
    RAISE EXCEPTION
      'messages.author_type = agent requires author_agent_id to name the speaking agent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_agent_author_named ON kernel.messages;
--> statement-breakpoint
-- A SEPARATE trigger from 0076's, not a replacement of its function: replaying
-- 0076 on a database that already has this one (the per-file idempotency
-- replay does exactly that) would otherwise silently disarm this half.
CREATE TRIGGER messages_agent_author_named
  BEFORE INSERT ON kernel.messages
  FOR EACH ROW EXECUTE FUNCTION kernel.messages_agent_author_named();
