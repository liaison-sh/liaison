// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The `imports-run` kernel job (queue class `bulk`, session mode): runs a
 * queued import run for the API. The CLI never hosts it; CLI importers call
 * the runner inline.
 *
 * At execute time the job rebuilds the person's permissions from the run's
 * `started_by` (never the enqueue-time snapshot), so a scope revoked between
 * the request and the run refuses the run. A run whose kinds another run holds
 * the lock of is delayed and retried, never dropped.
 */
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { liveActor } from "~/modules/imports/authority"
import { runImport } from "~/modules/imports/runner"
import { failRun, getImportRun } from "~/modules/imports/runs"
import type { ImportSource } from "~/modules/imports/source"
import { transformSourceOfRun } from "~/modules/imports/transform-run"
import { ImportError } from "~/modules/imports/types"

const log = rootLogger.child({ module: "imports-job" })

export const IMPORT_RUN_JOB = "imports-run"
const LOCKED_RETRY_MS = 30_000

export interface ImportRunJobPayload {
  orgId: string
  runId: string
}

export async function enqueueImportRun(payload: ImportRunJobPayload, delayMs?: number) {
  return enqueueAppJob("kernel", IMPORT_RUN_JOB, payload, {
    attempts: 1,
    ...(delayMs !== undefined ? { delay: delayMs } : {}),
  })
}

export async function processImportRunJob(
  payload: ImportRunJobPayload,
  signal?: AbortSignal,
): Promise<void> {
  const { orgId, runId } = payload
  const run = await getImportRun(orgId, runId)
  if (run?.status !== "queued") return
  let source: ImportSource | null
  try {
    source =
      transformSourceOfRun(run.source) ??
      (typeof run.source.fileId === "string"
        ? {
            type: "file",
            fileId: run.source.fileId,
            ...(run.source.format === "ics" ? { format: "ics" } : {}),
          }
        : null)
  } catch (err) {
    await failRun(orgId, runId, err instanceof Error ? err.message : String(err))
    return
  }
  if (!run.startedBy || !source) {
    await failRun(orgId, runId, "the run has no person or no source")
    return
  }
  const actor = await liveActor(orgId, run.startedBy)
  if (!actor) {
    await failRun(orgId, runId, "forbidden: the person who started the run is no longer active")
    return
  }
  try {
    const result = await runImport({
      orgId,
      actor,
      kinds: run.kindSet,
      source,
      sourceLabel: run.sourceLabel,
      mode: "api",
      placeholders: run.placeholders,
      dryRun: run.dryRun,
      runId,
      ...(signal ? { signal } : {}),
    })
    if (result.status === "deferred") {
      await enqueueImportRun(payload, LOCKED_RETRY_MS)
    }
  } catch (err) {
    if (err instanceof ImportError) {
      // Refused before any write (scope revoked, file gone): the run says why.
      await failRun(orgId, runId, `${err.code}: ${err.message}`)
      return
    }
    log.error({ err, orgId, runId }, "import run job failed")
    throw err
  }
}

export function registerImportJobWorker(): void {
  registerJobWorker<ImportRunJobPayload>(
    "kernel",
    IMPORT_RUN_JOB,
    // A shutdown stops the run after its batch and hands the job back.
    (payload, ctx) => processImportRunJob(payload, ctx?.signal),
    // Each batch opens its own short transactions: no ambient one.
    { txMode: "session" },
  )
}
