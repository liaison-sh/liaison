// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

export type ImportRunStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "undoing"
  | "undone"

/** Per kind: how many records were created, skipped and failed. */
export type ImportRunCounts = Record<string, { created: number; skipped: number; failed: number }>

/**
 * kernel.import_runs (migration 0207): one row per import run (modules/imports).
 * Readable by the run's org for holders of `kernel:imports:read`; written only
 * through the privileged connection by the runner and the `imports-run` job.
 */
export const importRuns = kernel.table(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kindSet: text("kind_set").array().notNull().default(sql`'{}'`),
    sourceLabel: text("source_label").notNull().default(""),
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
    mode: text("mode").$type<"api" | "cli">().notNull().default("api"),
    status: text("status").$type<ImportRunStatus>().notNull().default("queued"),
    dryRun: boolean("dry_run").notNull().default(false),
    placeholders: boolean("placeholders").notNull().default(false),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    counts: jsonb("counts").$type<ImportRunCounts>().notNull().default({}),
    errors: jsonb("errors").$type<Array<Record<string, unknown>>>().notNull().default([]),
    report: jsonb("report").$type<Record<string, unknown>>().notNull().default({}),
    startedBy: uuid("started_by"),
    approvalRequestId: uuid("approval_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Written by a running run (and an undo) at least every minute; the sweep
     *  fails a run whose heartbeat stopped (a crashed worker). */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("import_runs_org_created_idx").on(t.orgId, t.createdAt),
    check(
      "import_runs_status_chk",
      sql`${t.status} IN ('queued','running','done','failed','cancelled','undoing','undone')`,
    ),
    check("import_runs_mode_chk", sql`${t.mode} IN ('api','cli')`),
  ],
)

/**
 * kernel.import_ledger (migration 0207): every row an import run created, in
 * creation order. Undo touches only rows recorded here. Reached only through
 * the privileged connection (FORCE RLS, deny-all SELECT for liaison_rls).
 * `rowId` carries no foreign key: undo deletes the rows it names.
 */
export const importLedger = kernel.table(
  "import_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    /** The record's dedup key: undo keeps or deletes a record's rows together. */
    recordKey: text("record_key").notNull().default(""),
    tableName: text("table_name").notNull(),
    rowId: uuid("row_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("import_ledger_table_row_run_idx").on(t.tableName, t.rowId, t.runId),
    index("import_ledger_org_run_seq_idx").on(t.orgId, t.runId, t.seq),
    index("import_ledger_row_idx").on(t.rowId),
  ],
)

export type ImportRunRow = typeof importRuns.$inferSelect
export type ImportLedgerRow = typeof importLedger.$inferSelect
