// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

export type OrgExportStatus = "queued" | "running" | "completed" | "failed" | "expired"

/**
 * kernel.org_exports (migration 0232): one row per whole-org export archive
 * (modules/export/org-archive). Readable by the row's org for holders of
 * `kernel:org:admin`; written only through the privileged connection.
 */
export const orgExports = kernel.table(
  "org_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").$type<OrgExportStatus>().notNull().default("queued"),
    /** The token of the run holding a running row; a new one at each claim. */
    runId: uuid("run_id"),
    /** The admin who asked; null for an operator's CLI run. */
    requestedBy: uuid("requested_by"),
    requestedVia: text("requested_via").$type<"settings" | "cli">().notNull().default("settings"),
    objectKey: text("object_key"),
    bytes: bigint("bytes", { mode: "number" }),
    error: text("error"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Heartbeat: a running export writes it at least every minute. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** First download (the download audit); org deletion's export gate reads it. */
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
  },
  (t) => [
    index("org_exports_org_created_idx").on(t.orgId, t.createdAt),
    uniqueIndex("org_exports_one_active_idx")
      .on(t.orgId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("org_exports_completed_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'completed'`),
    check(
      "org_exports_status_chk",
      sql`${t.status} IN ('queued','running','completed','failed','expired')`,
    ),
    check("org_exports_via_chk", sql`${t.requestedVia} IN ('settings','cli')`),
  ],
)

export type OrgExportRow = typeof orgExports.$inferSelect
