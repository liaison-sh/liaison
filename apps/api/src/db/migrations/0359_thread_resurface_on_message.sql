-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A new message brings an archived conversation back to its members' lists.
--
-- Archiving a thread (`user_thread_state.is_archived`) took it out of the member's thread list
-- for good: nothing put it back, so a channel archived months ago stayed out of sight while its
-- members kept writing in it, and its member only found it again through a link. Archive now
-- means "out of my list until something new happens", as in a chat app: the send path calls this
-- function in the transaction that wrote the message, and it clears the archive flag of every
-- member of that thread. A member who MUTED the thread keeps it archived (mute is the "do not
-- bring this to me" switch, and an archived muted thread stays quiet).
--
-- Row level security lets a writer change only their own `user_thread_state` row, hence a
-- SECURITY DEFINER function. It acts only for a transaction that has just written a message in
-- that thread, in the transaction's own organization: a live (not deleted) channel line by a
-- person or an agent, stamped with this transaction's start time (the column default). Writing
-- that line already passed the messages insert policy, so the function grants nothing a writer
-- of the thread did not hold. A reply the channel does not show and a system line resurface
-- nothing. It changes `is_archived` only, and answers the members it changed with their flags
-- so the caller can tell their devices.
--
-- Additive: a new function and its grants. Re-runnable.

CREATE OR REPLACE FUNCTION kernel.resurface_thread_for_members(p_thread_id uuid)
RETURNS TABLE (user_id uuid, is_muted boolean, is_pinned boolean, notify_all_posts boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_org uuid := NULLIF(rls_ctx.org_id(), '')::uuid;
BEGIN
  IF v_org IS NULL OR p_thread_id IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kernel.messages m
     WHERE m.thread_id = p_thread_id
       AND m.org_id = v_org
       AND m.author_type IN ('user', 'agent')
       AND m.deleted_at IS NULL
       AND (m.reply_root_id IS NULL OR m.also_in_channel)
       AND m.created_at = now()
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
    UPDATE kernel.user_thread_state s
       SET is_archived = false
     WHERE s.thread_id = p_thread_id
       AND s.org_id = v_org
       AND s.is_archived
       AND NOT s.is_muted
       AND EXISTS (
         SELECT 1 FROM kernel.thread_participants tp
          WHERE tp.thread_id = s.thread_id AND tp.user_id = s.user_id
       )
    RETURNING s.user_id, s.is_muted, s.is_pinned, s.notify_all_posts;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.resurface_thread_for_members(uuid) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.resurface_thread_for_members(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE, no dynamic SQL
GRANT EXECUTE ON FUNCTION kernel.resurface_thread_for_members(uuid) TO liaison_rls, liaison_admin;
--> statement-breakpoint
GRANT SELECT ON kernel.thread_participants TO liaison_definer;
--> statement-breakpoint
GRANT SELECT, UPDATE (is_archived) ON kernel.user_thread_state TO liaison_definer;
--> statement-breakpoint
GRANT SELECT ON kernel.messages TO liaison_definer;
