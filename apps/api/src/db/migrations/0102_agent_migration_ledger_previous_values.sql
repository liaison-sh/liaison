-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The agent migration ledger can record an UPDATE to an agent it did not create.
--
-- Until now every `agents` ledger row meant "this run created the agent" and a
-- rollback deleted it. migrate-agents now also writes attributes onto agents
-- that already exist (a role agent's model preference from the roster), and a
-- rollback must put those back rather than delete the agent. `previous_values`
-- holds the columns as they were before the first run that changed them
-- (column name -> value); NULL keeps the old meaning, a created row.
--
-- Additive and nullable: every existing ledger row is a created or re-keyed
-- row and reads exactly as before.
ALTER TABLE kernel.agent_migration_ledger
  ADD COLUMN IF NOT EXISTS previous_values jsonb;
