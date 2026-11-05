-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Slack-style reply threads: a sub-conversation hanging off one ROOT message
-- of a channel.
--
-- A REPLY is a message whose `reply_root_id` names its root. It is never a root
-- itself, and it lives in the SAME kernel.threads row as its root: a reply
-- thread is a view over one channel's messages, not a second room, so every
-- existing gate (thread membership, the messages SELECT policy, the scope tag)
-- applies to it unchanged.
--
-- `parent_message_id` (0087) is NOT reused. That column is the agent chain
-- every dispatch guard walks (hop depth, root turn, per root cap, dedupe);
-- folding a human-facing reply structure into it would change what those
-- guards count. The two are orthogonal: an agent exchange inside a reply
-- thread carries both.
--
-- The key into the root is COMPOSITE, (reply_root_id, thread_id) ->
-- messages(id, thread_id), so a reply can never name a root in another room:
-- the database refuses it, whatever the writer checked. That needs a UNIQUE
-- (id, thread_id) on messages, which the primary key already implies and
-- Postgres still wants spelled out. ON DELETE CASCADE: a hard-deleted root
-- takes its replies with it (a soft delete, the product's only delete, leaves
-- them readable under "message deleted").
--
-- `also_in_channel` is the "Also send to channel" tick: the reply stays in the
-- reply thread AND shows in the channel list. False on every existing row, and
-- only a reply may carry it (the CHECK below).
--
-- kernel.reply_thread_followers holds who follows a reply thread (the root's
-- author, every replier, every participant mentioned in a reply) and how far
-- each has read it. Its RLS is modelled on user_thread_state: a follower row is
-- about a conversation, so only a member of that conversation may create one,
-- and only for another member.
--
-- Every statement is re-runnable, following the 0094/0109 convention.

ALTER TABLE kernel.messages ADD COLUMN IF NOT EXISTS reply_root_id uuid;
--> statement-breakpoint
ALTER TABLE kernel.messages ADD COLUMN IF NOT EXISTS also_in_channel boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_id_thread_uk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.messages ADD CONSTRAINT messages_id_thread_uk UNIQUE (id, thread_id);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_reply_root_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.messages
      ADD CONSTRAINT messages_reply_root_fk
      FOREIGN KEY (reply_root_id, thread_id) REFERENCES kernel.messages (id, thread_id)
      ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_reply_root_not_self' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.messages
      ADD CONSTRAINT messages_reply_root_not_self CHECK (reply_root_id IS NULL OR reply_root_id <> id);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_also_in_channel_needs_root' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.messages
      ADD CONSTRAINT messages_also_in_channel_needs_root
      CHECK (NOT also_in_channel OR reply_root_id IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint
-- The replies of one root in thread order, and the per-root counts the channel
-- list shows under each root. Partial: the channel rows (reply_root_id NULL),
-- which are nearly every row, are served by messages_thread_created_idx.
CREATE INDEX IF NOT EXISTS messages_thread_reply_root_created_idx
  ON kernel.messages (thread_id, reply_root_id, created_at)
  WHERE reply_root_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.reply_thread_followers (
  root_message_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  -- Null until the follower opens the reply thread: every reply is then unread.
  last_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, user_id),
  -- Composite for the same reason as messages_reply_root_fk: the thread_id the
  -- policies below test membership on is the root's own, never a claim.
  CONSTRAINT reply_thread_followers_root_fk
    FOREIGN KEY (root_message_id, thread_id) REFERENCES kernel.messages (id, thread_id)
    ON DELETE CASCADE
);
--> statement-breakpoint
-- The "followed threads" list: one user's rows in one org.
CREATE INDEX IF NOT EXISTS reply_thread_followers_org_user_idx
  ON kernel.reply_thread_followers (org_id, user_id);
--> statement-breakpoint
ALTER TABLE kernel.reply_thread_followers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.reply_thread_followers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.reply_thread_followers TO liaison_rls, liaison_app;
--> statement-breakpoint
-- A member of the room may see who follows its reply threads (the same room
-- roster they can already read); anyone may always see their own rows.
DROP POLICY IF EXISTS rtf_select ON kernel.reply_thread_followers;
--> statement-breakpoint
CREATE POLICY rtf_select ON kernel.reply_thread_followers FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR EXISTS (
        SELECT 1 FROM kernel.thread_participants tp
         WHERE tp.thread_id = kernel.reply_thread_followers.thread_id
           AND tp.org_id = kernel.reply_thread_followers.org_id
           AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
    )
  );
--> statement-breakpoint
-- The writer is a member of the room, and so is the user it makes a follower:
-- a mention of somebody outside the room never makes them follow it.
DROP POLICY IF EXISTS rtf_insert ON kernel.reply_thread_followers;
--> statement-breakpoint
CREATE POLICY rtf_insert ON kernel.reply_thread_followers FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.reply_thread_followers.thread_id
         AND tp.org_id = kernel.reply_thread_followers.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp2
       WHERE tp2.thread_id = kernel.reply_thread_followers.thread_id
         AND tp2.org_id = kernel.reply_thread_followers.org_id
         AND tp2.user_id = kernel.reply_thread_followers.user_id
    )
  );
--> statement-breakpoint
-- Only the follower moves their own read mark.
DROP POLICY IF EXISTS rtf_update ON kernel.reply_thread_followers;
--> statement-breakpoint
CREATE POLICY rtf_update ON kernel.reply_thread_followers FOR UPDATE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS rtf_delete ON kernel.reply_thread_followers;
--> statement-breakpoint
CREATE POLICY rtf_delete ON kernel.reply_thread_followers FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR EXISTS (
        SELECT 1 FROM kernel.thread_participants tp
         WHERE tp.thread_id = kernel.reply_thread_followers.thread_id
           AND tp.org_id = kernel.reply_thread_followers.org_id
           AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
    )
  );
