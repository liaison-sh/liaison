// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The `org-export` kernel job (queue class `bulk`, session mode: each batch
 * opens its own short transaction). Builds the archive of one queued export
 * (writer.ts) and records the outcome on its row. Idempotent on a stalled
 * retry: a `running` row whose heartbeat stopped is taken over with a new run
 * token and rebuilt from the start under that run's own key; a final row is
 * left alone.
 *
 * The run writes its heartbeat on a timer for its whole length, whatever it is
 * doing (a long file, a slow upload), and stops as soon as a heartbeat finds
 * the row no longer held by its token.
 *
 * The `liaison` CLI never hosts this job: `liaison org export` enqueues it for
 * the server (`enqueueAppJobForServer`).
 */
import { enqueueAppJob, enqueueAppJobForServer, registerJobWorker } from "~/infra/jobs/jobs"
import { deleteObject } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import {
  claimOrgExport,
  completeOrgExport,
  failOrgExport,
  heartbeatOrgExport,
  type OrgExportFailure,
} from "~/modules/export/org-archive/store"
import {
  type BuildOrgArchiveOptions,
  buildOrgArchive,
  orgExportObjectKey,
} from "~/modules/export/org-archive/writer"
import { ExportTooLargeError } from "~/modules/export/org-archive/zip-stream"

const log = rootLogger.child({ module: "org-export-job" })

export const ORG_EXPORT_JOB = "org-export"
const HEARTBEAT_EVERY_MS = 30_000

export interface OrgExportJobPayload {
  orgId: string
  exportId: string
}

/** The run's row was taken over by another run (or failed as stalled). */
export class OrgExportSupersededError extends Error {
  constructor() {
    super("this run no longer holds the export")
    this.name = "OrgExportSupersededError"
  }
}

/** Tests: smaller zip limits, a faster heartbeat, a stand-in object reader. */
export interface OrgExportJobTestOptions {
  zip?: BuildOrgArchiveOptions["zip"]
  heartbeatMs?: number
  openObject?: BuildOrgArchiveOptions["openObject"]
}

export async function enqueueOrgExport(
  payload: OrgExportJobPayload,
  opts: { forServer?: boolean } = {},
): Promise<string> {
  const enqueue = opts.forServer ? enqueueAppJobForServer : enqueueAppJob
  return enqueue("kernel", ORG_EXPORT_JOB, payload, { attempts: 1, jobId: payload.exportId })
}

function failureOf(err: unknown): OrgExportFailure {
  const detail = err instanceof Error ? err.message : String(err)
  if (err instanceof ExportTooLargeError) {
    return { code: "EXPORT_TOO_LARGE", shown: detail.replace(/^EXPORT_TOO_LARGE:\s*/, ""), detail }
  }
  return { code: "INTERNAL", detail }
}

/** Run one export. Never throws for an export failure: the row records it. */
export async function processOrgExportJob(
  payload: OrgExportJobPayload,
  signal?: AbortSignal,
  test: OrgExportJobTestOptions = {},
): Promise<void> {
  const { orgId, exportId } = payload
  const row = await claimOrgExport(orgId, exportId)
  if (!row) return
  const { runId } = row
  const stop = new AbortController()
  const runSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  let beating = false
  const timer = setInterval(() => {
    if (beating || stop.signal.aborted) return
    beating = true
    heartbeatOrgExport(orgId, exportId, runId)
      .then((held) => {
        if (!held) stop.abort(new OrgExportSupersededError())
      })
      .catch((err) => {
        // A missed beat is not fatal: the stale window is many beats long.
        log.warn({ err, orgId, exportId }, "org export heartbeat failed")
      })
      .finally(() => {
        beating = false
      })
  }, test.heartbeatMs ?? HEARTBEAT_EVERY_MS)
  try {
    const result = await buildOrgArchive({
      orgId,
      exportId,
      runId,
      signal: runSignal,
      ...(test.zip ? { zip: test.zip } : {}),
      ...(test.openObject ? { openObject: test.openObject } : {}),
    })
    const done = await completeOrgExport(orgId, exportId, runId, {
      objectKey: result.objectKey,
      bytes: result.bytes,
      manifest: result.manifest as unknown as Record<string, unknown>,
    })
    if (!done) {
      // Taken over or failed as stale meanwhile: no row names this run's
      // object, so it goes now (the orphan GC would after its grace window).
      log.warn({ orgId, exportId, runId }, "org export finished after its run lost the row")
      await deleteObject(result.objectKey).catch(() => undefined)
    }
  } catch (err) {
    // This run's own object only: another run never writes under its key.
    await deleteObject(orgExportObjectKey(orgId, exportId, runId)).catch(() => undefined)
    if (stop.signal.aborted && stop.signal.reason instanceof OrgExportSupersededError) {
      log.warn({ orgId, exportId, runId }, "org export run stopped: another run holds the row")
      return
    }
    log.error({ err, orgId, exportId, runId }, "org export failed")
    await failOrgExport(orgId, exportId, failureOf(err), runId)
  } finally {
    clearInterval(timer)
  }
}

export function registerOrgExportJobWorker(): void {
  registerJobWorker<OrgExportJobPayload>(
    "kernel",
    ORG_EXPORT_JOB,
    (payload, ctx) => processOrgExportJob(payload, ctx?.signal),
    { txMode: "session" },
  )
}
