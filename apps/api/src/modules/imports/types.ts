// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import framework contracts (modules/imports): what a kind handler receives
 * and returns, and what a run reports.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"

/** A row a handler created, schema-qualified (`app_tickets.tickets`). */
export interface ImportRowRef {
  table: string
  id: string
}

export type ImportRecordStatus = "created" | "skipped" | "failed"

/** What a host handler returns for one record it wrote (or found already there). */
export interface HostRecordOutcome {
  status: "created" | "skipped"
  /** Every row the record inserted, in creation order (the undo ledger). */
  rows: ImportRowRef[]
  /** Rows of the run's own (already ledgered, in one of the kind's
   *  `rollupTables`) this record UPDATED, a roll-up such as a counter: their
   *  ledger time moves to now, so undo does not read the run's own update as
   *  someone else's change. */
  touched?: ImportRowRef[]
  /** Per-record facts merged into the run report and handed to the client
   *  (counters such as `commentsImported`, named items such as unresolved
   *  people). Numbers are summed into the run report. */
  report?: Record<string, unknown>
}

/** The outcome of one record, as the runner records it. */
export interface ImportRecordResult {
  dedupKey: string
  status: ImportRecordStatus
  rows: ImportRowRef[]
  error?: string
  report?: Record<string, unknown>
}

/** Per-run context handed to a host handler. */
export interface HostImportContext {
  orgId: string
  runId: string
  /** Full kind name, `<app>.<kind>`. */
  kind: string
  /** The run's source label (`jira`); `""` for legacy CLI runs. */
  sourceLabel: string
  /** The user rows are attributed to when the record names nobody. */
  actorUserId: string
  /** The effective scopes of the person who started the run: a record that
   *  would carry a capability (a skill's or routine's scopes) stays within them. */
  actorScopes: string[]
  /** That person's dimension grants (for a service that applies its own
   *  dimension rules, such as the knowledge sensitivity ladder). */
  actorDimensionGrants: Record<string, string[]>
  /** Unknown people become deactivated placeholder users. */
  placeholders: boolean
  mode: "api" | "cli"
  /** Handler-owned cache that lives for the run (ids committed by earlier records). */
  cache: Map<string, unknown>
  /** A cache every kind of the run shares (a preview: the rows earlier kinds
   *  would have created, such as the categories a ticket names). */
  runCache?: Map<string, unknown>
  /** Client options for this kind (the CLI's lenient attachments, its indexer). */
  options: Record<string, unknown>
  /** Resolve an uploaded file a record references, under the PERSON's RLS
   *  (A9): another person's private file or another org's file is refused. */
  resolveFile(
    fileId: string,
  ): Promise<{ storageKey: string; filename: string; sizeBytes: number; mimeType: string }>
  /** Run a read under the PERSON's RLS (their org, scopes and grants), for a
   *  record that refers to a row the run did not create. */
  withActorRls<T>(fn: (tx: RlsClient) => Promise<T>): Promise<T>
  /** Does the person hold `value` on `dimension`? For a value only known
   *  after the write (a team inherited from the inbox default). */
  checkDimension(dimension: string, value: string): boolean
}

/** What `afterKind` created. */
export interface HostAfterKindOutcome {
  rows: ImportRowRef[]
  /** As `HostRecordOutcome.touched`. */
  touched?: ImportRowRef[]
  report?: Record<string, unknown>
}

/** The ledger record key of the rows a kind's `afterKind` created. */
export const AFTER_KIND_RECORD_KEY = "__after__"

/**
 * A built-in app's import kind, written on the host. `importRecord` runs inside
 * the record's own savepoint of a privileged transaction pinned to the run's
 * org; a throw fails only that record.
 */
export interface HostImportHandler {
  importRecord(
    tx: PrivilegedDb,
    ctx: HostImportContext,
    record: Record<string, unknown>,
    dedupValue: string,
  ): Promise<HostRecordOutcome>
  /**
   * Runs once after the kind's last batch, in its own privileged transaction
   * pinned to the run's org (links whose targets arrived in a later batch).
   * The rows it returns are ledgered under the record key `__after__`; its
   * report counters are added to the run's. Not called for a dry or a
   * cancelled run.
   */
  afterKind?(tx: PrivilegedDb, ctx: HostImportContext): Promise<HostAfterKindOutcome>
  /**
   * A preview's check of one record: what importRecord would do, writing
   * nothing ("created" or "skipped"; a refusal throws, as importRecord's does).
   * Called in a READ ONLY privileged transaction pinned to the run's org, with
   * the run's context; share the refusals with importRecord so a preview
   * refuses what the run would.
   */
  checkRecord?(
    tx: PrivilegedDb,
    ctx: HostImportContext,
    record: Record<string, unknown>,
    dedupValue: string,
  ): Promise<"created" | "skipped">
  /** Runs after a batch committed (search indexing); returns report counters. */
  afterCommit?(
    ctx: HostImportContext,
    results: ImportRecordResult[],
  ): Promise<Record<string, unknown> | undefined>
  /** The error text a failed record reports (default: the error's message). */
  formatError?(err: unknown): string
}

/** The dedup value stored in the app's external ref: `<source>:<key>`, or the
 *  bare key for a run with no source label (legacy CLI runs). */
export function dedupValueOf(sourceLabel: string, key: string): string {
  return sourceLabel ? `${sourceLabel}:${key}` : key
}

/** Values a dedup precheck matches: the prefixed value and, for rows imported
 *  earlier by the CLI without a source label, the bare key. */
export function dedupCandidates(sourceLabel: string, key: string): string[] {
  const value = dedupValueOf(sourceLabel, key)
  return value === key ? [key] : [value, key]
}

/** `<column> IN (<candidates>)`: the dedup precheck condition (R9). */
export function dedupMatchSql(column: SQL, sourceLabel: string, key: string): SQL {
  const values = dedupCandidates(sourceLabel, key).map((v) => drizzleSql`${v}`)
  return drizzleSql`${column} IN (${drizzleSql.join(values, drizzleSql`, `)})`
}

export class ImportError extends Error {
  constructor(
    readonly code:
      | "unknown_kind"
      | "forbidden"
      | "invalid_source"
      | "file_not_found"
      | "not_final"
      | "already_undone"
      | "not_found"
      | "locked"
      | "invalid_request",
    message: string,
    readonly status: 400 | 403 | 404 | 409 = code === "forbidden"
      ? 403
      : code === "file_not_found" || code === "not_found"
        ? 404
        : code === "not_final" || code === "locked" || code === "already_undone"
          ? 409
          : 400,
  ) {
    super(message)
    this.name = "ImportError"
  }
}
