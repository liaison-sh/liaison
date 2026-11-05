-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-routine agent model + reasoning level override. Both nullable — null means
-- "no routine-level override", falling through to the routine's output thread
-- setting and finally to the org auto-select / off (see agent-service.ts
-- resolveRoutineTickModelOverride). Settable at create/update time and from the
-- routine detail UI so a routine can be pinned to a model BEFORE its output
-- thread is lazily created on first tick.

ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS agent_model_id TEXT;
ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS agent_reasoning_level TEXT;

ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_agent_reasoning_level_chk;
ALTER TABLE kernel.routines ADD CONSTRAINT routines_agent_reasoning_level_chk
  CHECK (agent_reasoning_level IS NULL OR agent_reasoning_level IN ('off','low','medium','high'));
