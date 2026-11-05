// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { boolean, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * A needed-template rule (migration 0256): records of `record_type` whose facts
 * satisfy `when` need the templates in `templateIds`. `when` is read by the
 * matcher in modules/documents/rules.ts (only the keys sku, countryIso2,
 * carrier count). Org-scoped under FORCE RLS; changed by an org admin through
 * /api/document-template-rules (modules/documents/rules-routes.ts).
 */
export const documentTemplateRules = kernel.table(
  "document_template_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    recordType: text("record_type").notNull(),
    name: text("name").notNull(),
    when: jsonb("when").$type<Record<string, unknown>>().notNull().default({}),
    templateIds: uuid("template_ids").array().notNull().default(sql`'{}'::uuid[]`),
    note: text("note"),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("document_template_rules_org_record_type_idx").on(table.orgId, table.recordType),
    index("document_template_rules_created_by_fk_idx")
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
    index("document_template_rules_updated_by_fk_idx")
      .on(table.updatedBy)
      .where(sql`${table.updatedBy} IS NOT NULL`),
  ],
)

export type DocumentTemplateRuleRow = typeof documentTemplateRules.$inferSelect
