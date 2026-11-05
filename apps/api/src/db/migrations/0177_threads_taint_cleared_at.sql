-- SPDX-License-Identifier: FSL-1.1-ALv2
-- When a person last cleared the conversation's outside-text mark (the approved
-- kernel:outside_text_clear): the creation time of the approval card they
-- decided, by the database clock. History rows written at or before it no
-- longer mark a later turn that replays them
-- (modules/agent/scopes/replayed-outside-text.ts): the person decided that text
-- may be acted on. Anything read after it marks the conversation again. NULL:
-- never cleared.
--
-- tainted_at: when the conversation was last marked, by the database clock (a
-- replayed mark carries the time its newest source row was written). A clear
-- leaves a mark set after its card was created in place. Re-runnable.
ALTER TABLE kernel.threads ADD COLUMN IF NOT EXISTS taint_cleared_at timestamptz;
ALTER TABLE kernel.threads ADD COLUMN IF NOT EXISTS tainted_at timestamptz;
