// SPDX-License-Identifier: FSL-1.1-ALv2
import { integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.import_transforms: versioned import transforms (migration 0204).
 * A save adds the next version of a name; versions never change.
 */
export const importTransforms = kernel.table(
  "import_transforms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    source: text("source").notNull(),
    kinds: text("kinds").array().notNull().default([]),
    sourceType: text("source_type").$type<"upload" | "api">().notNull(),
    connectionIdentifier: text("connection_identifier"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("import_transforms_org_name_version_idx").on(
      table.orgId,
      table.name,
      table.version,
    ),
  ],
)

export type ImportTransform = typeof importTransforms.$inferSelect
