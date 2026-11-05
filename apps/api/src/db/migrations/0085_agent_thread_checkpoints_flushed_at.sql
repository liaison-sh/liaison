-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4m-T17: the memory flush is tracked PER CHECKPOINT VERSION.
--
-- The flush runs once per advance, before the summary, and must be impossible
-- to fire twice for one advance or to skip when the summary is about to run
-- (OpenClaw's once per cycle rule, spec-memory.md L4). The marker therefore
-- lives on the version row itself rather than in a side table: the row IS the
-- advance, so "was this advance flushed" is answered by reading it.
--
-- The column is NOT in the immutability trigger's guarded set (summary,
-- upto_message_id, version, required_scopes), which is deliberate and needs no
-- change there: a version row records whether its own flush ran, and a repair
-- that re-runs a missed flush must be able to say so.
ALTER TABLE kernel.agent_thread_checkpoints
  ADD COLUMN IF NOT EXISTS flushed_at timestamptz;
