-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4m-T23: an episode built from a message a human later deleted is STALE.
--
-- `kernel.agent_thread_checkpoints` already carries `stale_at` (0082, with the
-- immutability trigger carving it out). Episodes live in `kernel.agent_memory`
-- as rows of type 'episode' carrying the message range they summarize, and had
-- nowhere to record the same fact, so the delete path could mark a checkpoint
-- and not the episode built from the same messages.
--
-- Mutable in BOTH directions, like the checkpoint column: the delete path sets
-- it and the next consolidation run clears it after rebuilding the artefact
-- without the message.
ALTER TABLE kernel.agent_memory
  ADD COLUMN IF NOT EXISTS stale_at timestamptz;
