// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  index,
  integer,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { bytea } from "./mailbox-keys"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.files — metadata for objects stored externally (S3-compatible).
 * The actual bytes live in object storage; this row tracks the parent entity
 * (`(app, entity_type, entity_id)`) so RLS can be projected from manifest
 * `fileParent` declarations.
 */
export const files = kernel.table(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // I-DB-4 — org referential integrity + cascade.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull().unique(),
    thumbnailKey: text("thumbnail_key"),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    disposition: text("disposition").notNull().default("attachment"),
    contentId: text("content_id"),
    originalContentId: text("original_content_id"),
    ordinal: integer("ordinal").notNull().default(0),
    /**
     * When this row is a copy of another file (an agent attaching an existing
     * file onto a new entity via `attachFileToParent`), points at the source
     * file's id. Null for originally-uploaded files. Used for copy provenance
     * and idempotency (re-running a gated handler must not duplicate the copy).
     */
    copiedFromId: uuid("copied_from_id"),
    /**
     * Media-analysis columns — nullable, async-populated by the `analyze_media`
     * kernel tool / slow-path job. Absence (all null) means "never analyzed".
     * Precedent for a nullable async-populated column: `thumbnailKey`.
     */
    analysisStatus: text("analysis_status"),
    analysisSummary: text("analysis_summary"),
    analysisModel: text("analysis_model"),
    analysisAt: timestamp("analysis_at", { withTimezone: true }),
    analysisError: text("analysis_error"),
    analysisContextHash: text("analysis_context_hash"),
    /**
     * Attachment sealing (spec section 3.5 and 5.8). The bytes in object
     * storage are STREAM ciphertext when `encVersion > 0`; `0` means the object
     * is stored as-is. Everything else is nullable because a normal file has no
     * key material at all.
     *
     * Filename and MIME type are deliberately NOT here: they stay cleartext,
     * because they are envelope level and the list UI needs them.
     */
    encVersion: smallint("enc_version").notNull().default(0),
    /** AES-KW wrapped per-file content key. */
    contentKeyWrapped: bytea("content_key_wrapped"),
    /** SPKI of the ephemeral public key the wrap was derived against. */
    contentKeyEpk: bytea("content_key_epk"),
    /** The identity key id the content key was sealed to. One byte. */
    encKeyId: smallint("enc_key_id"),
    /** STREAM chunk size in bytes, 64 KiB today. */
    chunkSize: integer("chunk_size"),
    /** Authenticated chunk count. Bound into chunk 0's AAD. */
    chunkCount: integer("chunk_count"),
    /** Authenticated total plaintext length. Bound into chunk 0's AAD. */
    plaintextLength: bigint("plaintext_length", { mode: "number" }),
    /** The 7 byte per-file STREAM nonce prefix. */
    noncePrefix: bytea("nonce_prefix"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The key id is a single byte in the ciphertext blob header: a value above
    // 255 is a schema error, never something to truncate at read time.
    check("files_enc_key_id_byte", sql`${table.encKeyId} BETWEEN 0 AND 255`),
    index("idx_files_parent").on(table.orgId, table.app, table.entityType, table.entityId),
    index("idx_files_org_created").on(table.orgId, table.createdAt.desc()),
    index("idx_files_parent_ordinal").on(
      table.orgId,
      table.app,
      table.entityType,
      table.entityId,
      table.ordinal,
      table.createdAt,
      table.id,
    ),
    // Partial UNIQUE — makes `attachFileToParent`'s idempotency race-proof:
    // two concurrent gated-handler retries copying the same source onto the
    // same parent cannot both insert; the loser hits a unique violation and
    // re-reads the winner. Partial (copied_from_id IS NOT NULL) so it never
    // constrains originally-uploaded files.
    uniqueIndex("idx_files_copied_from")
      .on(table.orgId, table.app, table.entityType, table.entityId, table.copiedFromId)
      .where(sql`${table.copiedFromId} IS NOT NULL`),
  ],
)

export type File = typeof files.$inferSelect
export type NewFile = typeof files.$inferInsert
