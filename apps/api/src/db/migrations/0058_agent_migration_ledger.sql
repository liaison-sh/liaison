-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_migration_ledger: the durable record of every row the
-- agent-roster migration (scripts/migrate-agents.ts) created or re-keyed.
--
-- The migration's rollback touches only rows recorded here: it restores each
-- re-keyed skill/routine/memory row to its recorded previous owner, deletes
-- each recorded agent and knowledge pointer, and refuses when a recorded row
-- changed after it was recorded (owner moved, or updated_at past recorded_at),
-- or when an unrecorded row now depends on a migration-created agent. An
-- --apply run that hard-stops undoes its own rows, keyed by run_id. This
-- replaces the earlier createdAt anchor, which an admin-created role agent
-- could predate.
--
-- row_id and the two owner columns carry no foreign key: the rows they name
-- are deleted or restored by the rollback itself.
--
-- RLS: reached only through the privileged (liaison_admin, BYPASSRLS)
-- connection. FORCE RLS plus a deny-all SELECT policy for liaison_rls, and no
-- write policy, so no RLS actor can read or write it. Grants mirror 0050.
--
-- Every statement is RE-RUNNABLE, following 0033/0045/0049/0050.
-- Journal `when` 1900000042000: strictly above the ledger high-water mark
-- (1900000041000, 0057) checked before authoring.

CREATE TABLE IF NOT EXISTS kernel.agent_migration_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  step text NOT NULL,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  previous_owner_agent_id uuid,
  new_owner_agent_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_migration_ledger_table_chk CHECK (
    table_name IN ('agents','skills','routines','agent_memory','agent_knowledge_pointers')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_migration_ledger_table_row_idx
  ON kernel.agent_migration_ledger (table_name, row_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_migration_ledger_org_run_idx
  ON kernel.agent_migration_ledger (org_id, run_id);
--> statement-breakpoint
ALTER TABLE kernel.agent_migration_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agent_migration_ledger FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.agent_migration_ledger TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS agent_migration_ledger_select ON kernel.agent_migration_ledger;
CREATE POLICY agent_migration_ledger_select ON kernel.agent_migration_ledger FOR SELECT TO liaison_rls
  USING (false);
