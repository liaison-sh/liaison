// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * kernel.import_runs rows. Written through the privileged connection by the
 * runner, the job and the routes (the table has no RLS write policy); every
 * query is pinned to the org it is given AND filtered on it.
 */
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  type ImportRunCounts,
  type ImportRunRow,
  type ImportRunStatus,
  importLedger,
  importRuns,
} from "~/db/schema/kernel"
import { type AppEvent, broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"

export const MAX_RUN_ERRORS = 200

const log = rootLogger.child({ module: "imports-runs" })

/**
 * The event a run's status change queues (in the transaction that changes
 * it), followed by its progress card and the Imports view. It carries the
 * run's id and status only: a reader re-reads the row under its own RLS.
 */
export function importRunEvent(
  orgId: string,
  id: string,
  status: ImportRunStatus,
  action: "create" | "update" = "update",
): AppEvent {
  return {
    app: "kernel",
    entity: "import_run",
    action,
    entityId: id,
    orgId,
    actorType: "system",
    data: { id, status },
  }
}

export const FINAL_STATUSES: ReadonlySet<ImportRunStatus> = new Set(["done", "failed", "cancelled"])

export interface NewImportRun {
  orgId: string
  kinds: string[]
  sourceLabel: string
  source: Record<string, unknown>
  mode: "api" | "cli"
  dryRun: boolean
  placeholders: boolean
  startedBy: string | null
  approvalRequestId?: string | null
  status?: ImportRunStatus
}

export async function createImportRun(run: NewImportRun): Promise<ImportRunRow> {
  return withPrivilegedDb(run.orgId, "imports-create-run", async (tx) => {
    const [row] = await tx
      .insert(importRuns)
      .values({
        orgId: run.orgId,
        kindSet: run.kinds,
        sourceLabel: run.sourceLabel,
        source: run.source,
        mode: run.mode,
        dryRun: run.dryRun,
        placeholders: run.placeholders,
        startedBy: run.startedBy,
        approvalRequestId: run.approvalRequestId ?? null,
        status: run.status ?? "queued",
      })
      .returning()
    if (!row) throw new Error("import run insert returned no row")
    await tx.queueEvent(importRunEvent(run.orgId, row.id, row.status, "create"))
    return row
  })
}

export async function readImportRun(
  tx: PrivilegedDb,
  orgId: string,
  runId: string,
): Promise<ImportRunRow | null> {
  const [row] = await tx
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId)))
    .limit(1)
  return row ?? null
}

export async function getImportRun(orgId: string, runId: string): Promise<ImportRunRow | null> {
  return withPrivilegedDb(orgId, "imports-read-run", (tx) => readImportRun(tx, orgId, runId))
}

/**
 * Mark a run running and stamp started_at. With `onlyIfQueued` (a queued run
 * the job executes) it is a claim: false when another worker already took
 * the run, so the same run never executes twice.
 */
export async function markRunRunning(
  orgId: string,
  runId: string,
  onlyIfQueued: boolean,
): Promise<boolean> {
  return withPrivilegedDb(orgId, "imports-run-start", async (tx) => {
    const claimed = await tx
      .update(importRuns)
      .set({
        status: "running",
        startedAt: drizzleSql`COALESCE(${importRuns.startedAt}, now())`,
        heartbeatAt: drizzleSql`now()`,
      })
      .where(
        and(
          eq(importRuns.orgId, orgId),
          eq(importRuns.id, runId),
          ...(onlyIfQueued ? [eq(importRuns.status, "queued")] : []),
        ),
      )
      .returning({ id: importRuns.id })
    if (claimed.length === 0) return false
    await tx.queueEvent(importRunEvent(orgId, runId, "running"))
    return true
  })
}

/** A running run stopped by a shutdown goes back to `queued`, for the job's re-run to claim. */
export async function requeueRun(orgId: string, runId: string): Promise<void> {
  await withPrivilegedDb(orgId, "imports-run-requeue", async (tx) => {
    const back = await tx
      .update(importRuns)
      .set({ status: "queued" })
      .where(
        and(
          eq(importRuns.orgId, orgId),
          eq(importRuns.id, runId),
          eq(importRuns.status, "running"),
        ),
      )
      .returning({ id: importRuns.id })
    if (back.length > 0) await tx.queueEvent(importRunEvent(orgId, runId, "queued"))
  })
}

/** A running run says it is alive (the stale-run sweep fails one that stops). */
export async function touchRunHeartbeat(orgId: string, runId: string): Promise<void> {
  await withPrivilegedDb(orgId, "imports-run-heartbeat", (tx) =>
    tx
      .update(importRuns)
      .set({ heartbeatAt: drizzleSql`now()` })
      .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId))),
  )
}

/** Progress after a batch: counts, errors (capped), report. Returns the cancel flag. */
export async function writeRunProgress(
  orgId: string,
  runId: string,
  progress: {
    counts: ImportRunCounts
    errors: Array<Record<string, unknown>>
    report: Record<string, unknown>
  },
): Promise<{ cancelRequested: boolean }> {
  return withPrivilegedDb(orgId, "imports-run-progress", async (tx) => {
    const [row] = await tx
      .update(importRuns)
      .set({
        counts: progress.counts,
        errors: progress.errors.slice(0, MAX_RUN_ERRORS),
        report: progress.report,
        heartbeatAt: drizzleSql`now()`,
      })
      .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId)))
      .returning({ cancelRequested: importRuns.cancelRequested })
    return { cancelRequested: row?.cancelRequested ?? false }
  }).finally(() => {
    // Progress is not queued: the card re-reads the row on this ephemeral nudge.
    broadcastEphemeral({ ...importRunEvent(orgId, runId, "running"), action: "progress" }).catch(
      (err) => log.debug({ err, runId }, "import progress broadcast failed"),
    )
  })
}

export async function finishRun(
  orgId: string,
  runId: string,
  status: ImportRunStatus,
  progress: {
    counts: ImportRunCounts
    errors: Array<Record<string, unknown>>
    report: Record<string, unknown>
  },
): Promise<void> {
  await withPrivilegedDb(orgId, "imports-run-finish", (tx) =>
    tx
      .update(importRuns)
      .set({
        status,
        counts: progress.counts,
        errors: progress.errors.slice(0, MAX_RUN_ERRORS),
        report: progress.report,
        finishedAt: drizzleSql`now()`,
      })
      .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId)))
      .then(() => tx.queueEvent(importRunEvent(orgId, runId, status))),
  )
}

/** Fail a run that never got to stream (refused at execute time). */
export async function failRun(orgId: string, runId: string, message: string): Promise<void> {
  await withPrivilegedDb(orgId, "imports-run-fail", (tx) =>
    tx
      .update(importRuns)
      .set({
        status: "failed",
        errors: [{ error: message }],
        finishedAt: drizzleSql`now()`,
      })
      .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId)))
      .then(() => tx.queueEvent(importRunEvent(orgId, runId, "failed"))),
  )
}

/** Ask a run to stop between batches; a queued run is cancelled at once. */
export async function requestRunCancel(orgId: string, runId: string): Promise<ImportRunRow | null> {
  return withPrivilegedDb(orgId, "imports-run-cancel", async (tx) => {
    const row = await readImportRun(tx, orgId, runId)
    if (!row) return null
    if (row.status === "queued") {
      const [updated] = await tx
        .update(importRuns)
        .set({ status: "cancelled", cancelRequested: true, finishedAt: drizzleSql`now()` })
        .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId)))
        .returning()
      if (updated) await tx.queueEvent(importRunEvent(orgId, runId, "cancelled"))
      return updated ?? null
    }
    if (row.status === "running") {
      const [updated] = await tx
        .update(importRuns)
        .set({ cancelRequested: true })
        .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId)))
        .returning()
      return updated ?? null
    }
    return row
  })
}

/** Merge `patch` into a run's report (a preview's hash, written once it is final). */
export async function mergeRunReport(
  orgId: string,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await withPrivilegedDb(orgId, "imports-run-report", (tx) =>
    tx
      .update(importRuns)
      .set({ report: drizzleSql`${importRuns.report} || ${JSON.stringify(patch)}::jsonb` })
      .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId))),
  )
}

/** How many rows a run's ledger holds (what an undo would remove at most). */
export async function countRunLedger(orgId: string, runId: string): Promise<number> {
  const [row] = await withPrivilegedDb(orgId, "imports-ledger-count", (tx) =>
    tx
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(importLedger)
      .where(and(eq(importLedger.orgId, orgId), eq(importLedger.runId, runId))),
  )
  return Number(row?.n ?? 0)
}
