-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4a-T09: threads_select gains a DISCOVERABLE branch.
-- Journal high-water when this file was written: 1900000060000
-- (0076_threads_discoverable_messages_author_agent); this migration takes
-- 1900000061000.
--
-- A channel has to be listable before it can be joined: thread reads are
-- membership-gated today, which makes the opt-in join flow unimplementable. Any
-- member of the org may now read the ROW of a discoverable thread (handle,
-- title, participant count).
--
-- What does NOT change, deliberately (spec-home.md "Discoverable channels and
-- read access"): messages_select and user_thread_state stay gated on
-- participation, so a non-member listing a channel receives metadata and no
-- message content. threads_update keeps its participant-only USING clause, so
-- discoverability grants READ and nothing else. The org predicate is unchanged
-- and still first: this widens a thread within one org, never across orgs.
--
-- Re-runnable: the policy is dropped IF EXISTS and recreated.
DROP POLICY IF EXISTS threads_select ON kernel.threads;
--> statement-breakpoint
CREATE POLICY threads_select ON kernel.threads FOR SELECT TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND (
    discoverable = true
    OR EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = threads.id
        AND tp.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
);
