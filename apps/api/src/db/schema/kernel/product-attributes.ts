// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * A fact an organisation keeps about one product it sells, keyed by SKU
 * (migration 0254). Keys are free-form lowercase identifiers; `short_code`
 * (the short code a product reads as in a cart summary, "E2") is the first
 * documented one. Provider-neutral: a store app reads it, a shipping app
 * reads and writes it, and neither imports the other. Org-scoped under FORCE
 * RLS; reached through the `product_attributes_list` / `_upsert` kernel tools.
 */
export const productAttributes = kernel.table(
  "product_attributes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_attributes_org_sku_key_idx").on(table.orgId, table.sku, table.key),
    index("product_attributes_org_key_idx").on(table.orgId, table.key),
  ],
)

export type ProductAttributeRow = typeof productAttributes.$inferSelect
