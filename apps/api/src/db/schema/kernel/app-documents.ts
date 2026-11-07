// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  bigint,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * A JSON document an app keeps for its org (migration 0275), keyed by
 * (app, collection, doc_id). `app` owns the collection (`agent` is the agent's
 * own namespace). Org-scoped under FORCE RLS; read and written through
 * modules/data-store/service.ts, which keeps an app inside its own collections
 * and maintains `app_document_usage` in the same transaction.
 */
export const appDocuments = kernel.table(
  "app_documents",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    collection: text("collection").notNull(),
    docId: text("doc_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.app, table.collection, table.docId] }),
    index("app_documents_recent_idx").on(
      table.orgId,
      table.app,
      table.collection,
      table.updatedAt.desc(),
    ),
    index("app_documents_data_idx").using("gin", sql`${table.data} jsonb_path_ops`),
    index("app_documents_created_by_fk_idx")
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
    index("app_documents_updated_by_fk_idx")
      .on(table.updatedBy)
      .where(sql`${table.updatedBy} IS NOT NULL`),
  ],
)

export type AppDocumentRow = typeof appDocuments.$inferSelect

/**
 * Documents and bytes per (org, app, collection) (migration 0275), kept in step
 * with `app_documents` by every write of the data-store service, so the
 * per-collection limit holds without a scan.
 */
export const appDocumentUsage = kernel.table(
  "app_document_usage",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    collection: text("collection").notNull(),
    docs: integer("docs").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.app, table.collection] })],
)

export type AppDocumentUsageRow = typeof appDocumentUsage.$inferSelect
