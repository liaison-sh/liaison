// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { check, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

// Durable record of every row the one-off agent-roster migration created,
// re-keyed or updated. The rollback
// touches only rows recorded here, restoring each re-keyed row's previous
// owner and each updated agent's previous values, and deleting each created
// row, and refuses when a recorded row changed after it was recorded. A run that hard-stops undoes its own recorded rows, keyed by
// `runId`.
//
// `rowId`, `previousOwnerAgentId` and `newOwnerAgentId` carry no foreign key:
// the rows they name are deleted or restored by the rollback itself, and a
// ledger row must be able to outlive them long enough to be read.
//
// Reached only through the privileged (BYPASSRLS) connection. FORCE RLS with
// a deny-all SELECT policy for liaison_rls, so no RLS actor can read or write
// it.
export const agentMigrationLedger = kernel.table(
  "agent_migration_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    step: text("step").notNull(),
    tableName: text("table_name").notNull(),
    rowId: uuid("row_id").notNull(),
    previousOwnerAgentId: uuid("previous_owner_agent_id"),
    newOwnerAgentId: uuid("new_owner_agent_id"),
    /**
     * Set on an `agents` row the migration UPDATED rather than created: the
     * columns as they were before the first run that changed them (column
     * name -> value). A rollback writes them back instead of deleting the
     * agent. NULL means a created (or, on other tables, re-keyed) row.
     */
    previousValues: jsonb("previous_values").$type<Record<string, unknown>>(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_migration_ledger_table_row_idx").on(t.tableName, t.rowId),
    index("agent_migration_ledger_org_run_idx").on(t.orgId, t.runId),
    check(
      "agent_migration_ledger_table_chk",
      sql`${t.tableName} IN ('agents','skills','routines','agent_memory','agent_knowledge_pointers')`,
    ),
  ],
)

export type AgentMigrationLedgerRow = typeof agentMigrationLedger.$inferSelect
