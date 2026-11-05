// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `org-delete` kernel job: the server side of `liaison org delete` (D10,
// A14). The CLI checks the gates, writes the ledger, marks the org deleting
// (step 1) and hands this job to the server's worker; it never registers org
// apps in its own process. The job then, recording every step on the ledger:
//
//   1  marks the org deleting when the CLI did not (atomically with the run
//      still holding the deletion, so an `--abort` cannot be undone by it);
//   -  waits until every process has seen the deleting state
//      (ORG_DELETING_SETTLE_MS after the mark), so a legal record written by
//      work admitted just before the mark is in the archive;
//   2  writes the legal-retention archive (legal-archive.ts), skipped when the
//      ledger already names one or the operator waived it;
//   -  records `purge` on the ledger (an `--abort` is refused from here on);
//   3+ runs the org purge core (modules/org/purge/purge-org.ts): disconnect,
//      rows, search, objects, Redis, schedulers, verify, the org row, release.
//
// The payload names the org `targetOrgId`, never `orgId`: the job dispatch
// drops a job whose `data.orgId` is an org being deleted, and this job is the
// one that must run for it. Resumable: a run that crashed leaves the ledger
// `running` (taken over once its heartbeat is stale) or `failed`; the next run
// skips what the ledger says is done and the purge's own steps are idempotent.
import { enqueueAppJob, enqueueAppJobForServer, registerJobWorker } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import {
  claimOrgDeletion,
  claimPurgeStart,
  finishOrgDeletion,
  getOrgDeletion,
  heartbeatOrgDeletion,
  markOrgDeletingForRun,
  PURGE_STARTED_STEP,
  recordOrgDeletionStep,
} from "~/modules/org/delete/ledger"
import {
  deleteLegalArchive,
  type LegalRetentionManifest,
  recordLegalArchive,
  reserveLegalArchive,
  writeLegalArchive,
} from "~/modules/org/delete/legal-archive"
import {
  announceOrgDeleting,
  readOrgDeletion,
  waitForOrgDeletingToSettle,
} from "~/modules/org/purge/deleting"
import type { OrgExternalStateDeps } from "~/modules/org/purge/external"
import { type OrgPurgeStep, purgeOrg } from "~/modules/org/purge/purge-org"

const log = rootLogger.child({ module: "org-delete-job" })

export const ORG_DELETE_JOB = "org-delete"
export const MARK_STEP = "mark"
export const LEGAL_ARCHIVE_STEP = "legal-archive"
const HEARTBEAT_EVERY_MS = 30_000

export interface OrgDeleteJobPayload {
  deletionId: string
  /** The org being deleted. Deliberately not `orgId` (see the header). */
  targetOrgId: string
}

/** Test seams. */
export interface OrgDeleteJobOptions {
  sleep?: (ms: number) => Promise<void>
  externalDeps?: OrgExternalStateDeps
  manifests?: readonly LegalRetentionManifest[]
  heartbeatMs?: number
  /** Called after each purge step, once the ledger recorded it (a test crashes here). */
  onPurgeStep?: (step: OrgPurgeStep) => Promise<void> | void
  /** Called once the legal archive is recorded, before the purge starts (a test crashes here). */
  onArchived?: () => Promise<void> | void
}

export async function enqueueOrgDelete(
  payload: OrgDeleteJobPayload,
  opts: { forServer?: boolean } = {},
): Promise<string> {
  const enqueue = opts.forServer ? enqueueAppJobForServer : enqueueAppJob
  return enqueue("kernel", ORG_DELETE_JOB, payload, {
    attempts: 1,
    // One BullMQ id per hand-off: a re-run after a failure is a new job.
    jobId: `${ORG_DELETE_JOB}-${payload.deletionId}-${Date.now()}`,
  })
}

/** Run the deletion. Never throws for a deletion failure: the ledger records it. */
export async function processOrgDeleteJob(
  payload: OrgDeleteJobPayload,
  opts: OrgDeleteJobOptions = {},
): Promise<void> {
  const { deletionId, targetOrgId } = payload
  const claimed = await claimOrgDeletion(deletionId)
  if (!claimed) {
    const row = await getOrgDeletion(deletionId)
    log.info(
      { deletionId, orgId: targetOrgId, status: row?.status ?? "missing" },
      "org deletion not claimed (closed, or another run holds it)",
    )
    return
  }
  const { runId, row } = claimed
  if (row.deletedOrgId !== targetOrgId) {
    await finishOrgDeletion(deletionId, runId, {
      status: "failed",
      error: `job payload names org ${targetOrgId}, the ledger ${row.deletedOrgId}`,
    })
    return
  }
  const timer = setInterval(() => {
    heartbeatOrgDeletion(deletionId, runId).catch((err: unknown) =>
      log.warn({ err, deletionId }, "org deletion heartbeat failed"),
    )
  }, opts.heartbeatMs ?? HEARTBEAT_EVERY_MS)
  // An archive uploaded by this run and not yet recorded: deleted if the run fails.
  let unrecordedArchive: string | null = null
  try {
    const steps = new Set(row.stepsDone)
    const stored = await readOrgDeletion(targetOrgId)

    if (stored && !steps.has(MARK_STEP)) {
      if (!(await markOrgDeletingForRun(deletionId, runId, targetOrgId, MARK_STEP))) {
        log.warn({ deletionId, orgId: targetOrgId }, "org deletion lost its run before the mark")
        return
      }
      await announceOrgDeleting(targetOrgId)
    }

    if (!steps.has(PURGE_STARTED_STEP)) {
      // Before the archive: work admitted just before the mark may still write
      // legal records; they must be in it.
      const now = await readOrgDeletion(targetOrgId)
      if (now?.deletingAt) {
        await waitForOrgDeletingToSettle(now.deletingAt, opts.sleep ? { sleep: opts.sleep } : {})
      }
    }

    if (stored && !steps.has(LEGAL_ARCHIVE_STEP)) {
      if (row.archiveKey || !row.legalArchiveRecipient) {
        // Written by an earlier run, or waived (the waiver is on the ledger).
        await recordOrgDeletionStep(deletionId, LEGAL_ARCHIVE_STEP, { runId })
      } else {
        const recipient = row.legalArchiveRecipient
        const archive = await writeLegalArchive({
          org: { id: targetOrgId, name: row.orgName, slug: row.orgSlug },
          recipient,
          ...(opts.manifests ? { manifests: opts.manifests } : {}),
          beforeUpload: async ({ objectKey, retainUntil }) => {
            await reserveLegalArchive({
              org: { id: targetOrgId, slug: row.orgSlug },
              recipient,
              objectKey,
              retainUntil,
            })
            unrecordedArchive = objectKey
          },
        })
        const recorded = await recordLegalArchive({
          deletionId,
          runId,
          org: { id: targetOrgId, slug: row.orgSlug },
          recipient,
          archive,
          step: LEGAL_ARCHIVE_STEP,
        })
        if (!recorded) {
          await deleteLegalArchive(archive.objectKey).catch(() => undefined)
          unrecordedArchive = null
          log.warn({ deletionId, orgId: targetOrgId }, "org deletion lost its run (aborted?)")
          return
        }
        unrecordedArchive = null
        log.info(
          { deletionId, orgId: targetOrgId, objectKey: archive.objectKey, bytes: archive.bytes },
          "legal archive written",
        )
      }
      await opts.onArchived?.()
    }

    if (!steps.has(PURGE_STARTED_STEP)) {
      if (!(await claimPurgeStart(deletionId, runId))) {
        log.warn({ deletionId, orgId: targetOrgId }, "org deletion lost its run before the purge")
        return
      }
    }

    const result = await purgeOrg(targetOrgId, {
      reason: "org-delete",
      // Waited above, before the purge step was recorded.
      settle: false,
      ...(opts.externalDeps ? { externalDeps: opts.externalDeps } : {}),
      onStep: async (step, detail) => {
        await recordOrgDeletionStep(deletionId, step, {
          runId,
          ...(step === "verify" ? { counts: { residue: detail.residue } } : {}),
        })
        await opts.onPurgeStep?.(step)
      },
    })
    await finishOrgDeletion(deletionId, runId, {
      status: "completed",
      counts: { deleted: result.deleted, orgRowDeleted: result.orgRowDeleted },
    })
    log.warn({ deletionId, orgId: targetOrgId, slug: row.orgSlug }, "organization deleted")
  } catch (err) {
    if (unrecordedArchive) {
      // Uploaded (or partly) and never recorded: not kept unindexed. A failed
      // delete leaves the pending row for the daily sweep.
      await deleteLegalArchive(unrecordedArchive).catch((e: unknown) =>
        log.warn({ err: e, deletionId }, "unrecorded legal archive not deleted; the sweep will"),
      )
    }
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    log.error({ err, deletionId, orgId: targetOrgId }, "org deletion failed; re-run to resume")
    await finishOrgDeletion(deletionId, runId, { status: "failed", error: detail }).catch(
      (e: unknown) => log.error({ err: e, deletionId }, "org deletion failure not recorded"),
    )
  } finally {
    clearInterval(timer)
  }
}

/** The server's worker. `opts` are test seams only. */
export function registerOrgDeleteJobWorker(opts: OrgDeleteJobOptions = {}): void {
  registerJobWorker<OrgDeleteJobPayload>(
    "kernel",
    ORG_DELETE_JOB,
    (payload) => processOrgDeleteJob(payload, opts),
    { txMode: "session" },
  )
}
