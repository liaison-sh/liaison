-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Message edit/delete was strictly author-only (see the comment on
-- deleteMessage in modules/threads/message.ts) — including for agent-authored
-- messages, where author_id is already the human user who triggered that
-- agent turn (sendMessage persists authorId = the initiating userId for
-- authorType='agent' too; the agent has no separate identity). That gave org
-- admins no way to moderate/correct an agent reply. This adds a scoped admin
-- override — kernel:threads:admin or '*' — to messages_update / messages_delete,
-- mirroring the saved_views admin-override pattern. The author-only rule is
-- otherwise unchanged: a non-admin, non-author participant still cannot touch
-- someone else's (or another user's agent-authored) message.
DROP POLICY IF EXISTS messages_update ON kernel.messages;
--> statement-breakpoint
CREATE POLICY messages_update ON kernel.messages FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      author_id = current_setting('app.current_user_id', true)::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:threads:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = messages.thread_id
        AND tp.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS messages_delete ON kernel.messages;
--> statement-breakpoint
CREATE POLICY messages_delete ON kernel.messages FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      author_id = current_setting('app.current_user_id', true)::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:threads:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = messages.thread_id
        AND tp.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
