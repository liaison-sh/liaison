// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

/** The moves of an org this instance took part in (migration 0270, modules/org/transfer/). */
export const orgTransferLedger = kernel.table(
  "org_transfer_ledger",
  {
    transferId: uuid("transfer_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    direction: text("direction").notNull(),
    arrivedVia: uuid("arrived_via"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("org_transfer_ledger_org_idx").on(table.orgId, table.createdAt)],
)

export type OrgTransferLedgerRow = typeof orgTransferLedger.$inferSelect
