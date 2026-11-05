// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  index,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export type OrgDeletionStatus =
  | "started"
  | "queued"
  | "running"
  | "failed"
  | "completed"
  | "aborted"

/** A gate the operator waived, recorded on the ledger. */
export interface OrgDeletionWaiver {
  kind: "no-legal-archive" | "without-export"
  at: string
  /** Why the gate was waived, when no operator did it by hand (managed deletion, D24). */
  reason?: string
}

/** How the export gate was met. */
export interface OrgDeletionExport {
  exportId: string | null
  completedAt?: string | null
  downloadedAt?: string | null
  savedTo?: string | null
  bytes?: number | null
}

/**
 * kernel.org_deletions (migration 0236): the ledger of an operator's org
 * deletion (modules/org/delete). It survives the org: no foreign key and no
 * `org_id` column (the purge empties every kernel table that has one), the
 * org is `deleted_org_id`. Privileged pool only.
 */
export const orgDeletions = kernel.table(
  "org_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deletedOrgId: uuid("deleted_org_id").notNull(),
    orgSlug: text("org_slug").notNull(),
    orgName: text("org_name").notNull(),
    /** Who ran the command: the operating-system account and host (the CLI has no Liaison user). */
    operator: text("operator").notNull(),
    status: text("status").$type<OrgDeletionStatus>().notNull().default("started"),
    stepsDone: text("steps_done").array().notNull().default(sql`'{}'::text[]`),
    waivers: jsonb("waivers").$type<OrgDeletionWaiver[]>().notNull().default(sql`'[]'::jsonb`),
    export: jsonb("export").$type<OrgDeletionExport>(),
    /** The age recipient (a public key) the legal archive is encrypted to; null when waived. */
    legalArchiveRecipient: text("legal_archive_recipient"),
    archiveKey: text("archive_key"),
    counts: jsonb("counts").$type<Record<string, unknown>>(),
    error: text("error"),
    /** The token of the purge job run holding the row. */
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("org_deletions_one_open_idx")
      .on(t.deletedOrgId)
      .where(sql`${t.status} NOT IN ('completed','aborted')`),
    index("org_deletions_slug_idx").on(t.orgSlug, t.createdAt),
    check(
      "org_deletions_status_chk",
      sql`${t.status} IN ('started','queued','running','failed','completed','aborted')`,
    ),
  ],
)

export type OrgDeletionRow = typeof orgDeletions.$inferSelect

/**
 * kernel.legal_archives (migration 0236): one legal-retention archive of a
 * deleted org, encrypted to the operator's age recipient (the instance never
 * holds the identity), kept until `retain_until`. Survives the org like the
 * ledger. Privileged pool only.
 */
export const legalArchives = kernel.table(
  "legal_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deletedOrgId: uuid("deleted_org_id").notNull(),
    orgSlug: text("org_slug").notNull(),
    objectKey: text("object_key").notNull(),
    recipient: text("recipient").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    counts: jsonb("counts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    /** Null while pending: written before the upload, set when the run records the archive. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("legal_archives_object_key_uq").on(t.objectKey),
    index("legal_archives_due_idx").on(t.retainUntil).where(sql`${t.deletedAt} IS NULL`),
  ],
)

export type LegalArchiveRow = typeof legalArchives.$inferSelect
