-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A member's per-channel notification level. By default a channel interrupts
-- (push, desktop banner) its members only for a mention, a reply in a reply
-- thread they follow, or a direct room; every other post goes to the inbox
-- quietly. `notify_all_posts` is the member's opt-in to be interrupted by every
-- post of that one channel (notifications/router.ts reads it). Re-runnable.

-- A busy table fails the migration fast instead of queueing every reader behind it.
SET LOCAL lock_timeout = '30s';

ALTER TABLE "kernel"."user_thread_state"
  ADD COLUMN IF NOT EXISTS "notify_all_posts" boolean DEFAULT false NOT NULL;
