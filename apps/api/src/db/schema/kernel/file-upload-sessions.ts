// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.file_upload_sessions — staging parent for files uploaded before their
 * final message exists (composer drafts, mail drafts, ticket replies).
 *
 * Sessions store the validated target (`target_app` / `target_entity_type` /
 * optional `target_entity_id`) plus the owner. `authorizeUpload` recognises
 * (`app="kernel"`, `entityType="file_upload_session"`) and re-runs the parent
 * write-scope check against the stored target; `moveFilesToParent` then
 * reparents the staged files only if the caller still owns the session and
 * the requested final target matches.
 *
 * Owner-RLS policy (`file_upload_sessions_owner`) keeps each session visible
 * only to its creator within its org.
 */
export const fileUploadSessions = kernel.table(
  "file_upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetApp: text("target_app").notNull(),
    targetEntityType: text("target_entity_type").notNull(),
    targetEntityId: text("target_entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Matches the DDL default in 0000_initial.sql so an INSERT may omit it.
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (table) => [
    index("idx_file_upload_sessions_owner").on(table.orgId, table.createdBy, table.expiresAt),
  ],
)

export type FileUploadSession = typeof fileUploadSessions.$inferSelect
export type NewFileUploadSession = typeof fileUploadSessions.$inferInsert
