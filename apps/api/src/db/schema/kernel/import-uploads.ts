// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { bigint, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { fileUploadSessions } from "./file-upload-sessions"
import { files } from "./files"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.import_uploads: a large import file's upload, as an S3 multipart
 * upload (or a relayed single PUT), until it becomes a kernel.files row
 * parented to the uploader's own upload session (migration 0203).
 */
export const importUploads = kernel.table(
  "import_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => fileUploadSessions.id, { onDelete: "set null" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    storageKey: text("storage_key").notNull(),
    mode: text("mode").$type<"multipart" | "relay">().notNull().default("multipart"),
    uploadId: text("upload_id"),
    partSize: bigint("part_size", { mode: "number" }).notNull().default(0),
    size: bigint("size", { mode: "number" }).notNull(),
    status: text("status")
      .$type<"uploading" | "complete" | "aborted">()
      .notNull()
      .default("uploading"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (table) => [
    uniqueIndex("import_uploads_storage_key_idx").on(table.storageKey),
    index("import_uploads_owner_idx").on(table.orgId, table.createdBy, table.createdAt),
  ],
)

export type ImportUpload = typeof importUploads.$inferSelect
