// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Worker modules of code that runs without an installed app version
// (migration 0299, modules/apps/workers/adhoc-module.ts): a draft's preview,
// an import transform, a PDF template. System data: written and read through
// the privileged connection only (FORCE RLS, no liaison_rls policy).

import { index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { bytea } from "./mailbox-keys"
import { kernel, organizations } from "./organizations"

export type AppCodeModuleOrigin = "draft" | "import-transform" | "pdf-template"

export const appCodeModules = kernel.table(
  "app_code_modules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The org whose code it is; null for an installed app's (instance-wide) PDF template. */
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    origin: text("origin").$type<AppCodeModuleOrigin>().notNull(),
    /** sha256 of what the module was built from; `draft:<sha256>` for a draft's worker.js. */
    sourceKey: text("source_key").notNull(),
    /** sha256 of `bytes`. */
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("app_code_modules_org_source_idx")
      .on(table.orgId, table.sourceKey)
      .nullsNotDistinct(),
    index("app_code_modules_sha256_idx").on(table.sha256),
    index("app_code_modules_last_used_idx").on(table.lastUsedAt),
  ],
)

export type AppCodeModuleRow = typeof appCodeModules.$inferSelect
