// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `DELETE /api/cloud/orgs/:id {orgId, timerId}` (spec S26, §3.4, A43, D24):
// Control's delete timer deletes a closed managed org with the cell's one
// deletion core (modules/org/delete/start.ts, the same path as the operator's
// `liaison org delete`): the ledger row, the deleting mark, the `org-delete`
// job (legal archive step, then the purge with its settle wait).
//
// Fences, each a 409 `{ok:false, code}` that changes nothing:
//   operator_org         the cell's operator org is never deleted this way;
//   not_closed           the stored billing status is not `closed`;
//   closed_too_recently  `closedAt` (from the push) is less than 25 days ago;
//   export_running       an export of the org runs (Control retries later).
// The operator's export and legal-archive gates are waived and the waivers
// recorded on the ledger (D24): the customer had the 30-day export window and
// is the controller of its data.
//
// Asynchronous and idempotent on `timerId` (outcomes.ts): the first call queues
// the deletion and stores its ledger id; every repeat answers the ledger's
// current state (`queued|running|done|failed`). Control calls again until
// `done`. A repeat that finds the deletion `failed` hands it to the worker
// again (it resumes where it stopped) and answers `failed` this once.

import {
  CLOUD_ERROR_CODES,
  type CloudDeleteOrgReply,
  type CloudDeleteOrgState,
  type CloudErrorReply,
} from "@liaison/control-plane-contract"
import { desc, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { type OrgDeletionRow, organizations, orgDeletions } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { resolveOperatorOrgId } from "~/modules/apps/operator-org"
import {
  findOpenOrgDeletion,
  getOrgDeletion,
  ORG_DELETION_STALE_MS,
  OrgDeletionOpenError,
} from "~/modules/org/delete/ledger"
import {
  beginOrgDeletion,
  handOrgDeletionToWorker,
  runningOrgExport,
} from "~/modules/org/delete/start"
import { invalidateOrgBillingStatus, orgBillingStatus } from "./billing-status"
import { claimOutcome, completeOutcome, releaseClaim } from "./outcomes"

const log = rootLogger.child({ module: "cloud-delete-org" })

const ENDPOINT = "DELETE /orgs/:id"

/** How long after `closedAt` the cell accepts the deletion (Control asks at closed + 30 d). */
export const CLOSED_DELETION_DELAY_MS = 25 * 24 * 60 * 60 * 1000

/** The ledger operator of a deletion Control asked for. */
const operatorOf = (timerId: string) => `control-plane:${timerId}`

/** The waivers a managed deletion records (D24). */
export const MANAGED_DELETION_WAIVER_REASONS = {
  export: "export: customer had the 30-day export window",
  legalArchive:
    "legal_archive: waived (managed: the customer is the controller and had the export window)",
} as const

export type DeleteOrgResult =
  | { status: 200; reply: CloudDeleteOrgReply }
  | { status: 404 | 409 | 503; reply: CloudErrorReply }

const refuse = (status: 404 | 409 | 503, code: CloudErrorReply["code"]): DeleteOrgResult => ({
  status,
  reply: { ok: false, code },
})

function stateOf(row: OrgDeletionRow): CloudDeleteOrgState {
  switch (row.status) {
    case "completed":
      return "done"
    case "running":
      return "running"
    case "failed":
    case "aborted":
      return "failed"
    default:
      return "queued"
  }
}

/** The current state of a deletion, re-handing a failed or stalled one to the worker. */
async function currentState(row: OrgDeletionRow): Promise<CloudDeleteOrgState> {
  const state = stateOf(row)
  const stalledQueue =
    row.status === "queued" && Date.now() - row.updatedAt.getTime() > ORG_DELETION_STALE_MS
  if (row.status === "failed" || stalledQueue) {
    const handed = await handOrgDeletionToWorker(row)
    if (!handed.ok) log.error({ deletionId: row.id, detail: handed.detail }, "re-queue failed")
  }
  return state
}

async function replyFor(deletionId: string): Promise<DeleteOrgResult> {
  const row = await getOrgDeletion(deletionId)
  if (!row) return refuse(404, CLOUD_ERROR_CODES.notFound)
  return { status: 200, reply: { ok: true, state: await currentState(row) } }
}

/** The fences of a fresh request, or null when the org may be deleted. */
async function fence(orgId: string): Promise<DeleteOrgResult | null> {
  const operatorOrgId = await resolveOperatorOrgId({ fresh: true })
  if (operatorOrgId === orgId) return refuse(409, CLOUD_ERROR_CODES.operatorOrg)
  invalidateOrgBillingStatus(orgId)
  const billing = await orgBillingStatus(orgId)
  if (billing?.status !== "closed") return refuse(409, CLOUD_ERROR_CODES.notClosed)
  const closedAt = billing.closedAt === null ? Number.NaN : Date.parse(billing.closedAt)
  if (!(Date.now() - closedAt >= CLOSED_DELETION_DELAY_MS)) {
    return refuse(409, CLOUD_ERROR_CODES.closedTooRecently)
  }
  if (await runningOrgExport(orgId)) return refuse(409, CLOUD_ERROR_CODES.exportRunning)
  return null
}

export async function deleteCloudOrg(req: {
  orgId: string
  timerId: string
}): Promise<DeleteOrgResult> {
  const claim = await claimOutcome(ENDPOINT, req.timerId, req.orgId)
  if (claim.kind === "done") {
    return replyFor((claim.reply as { deletionId: string }).deletionId)
  }
  if (claim.kind === "mismatch") return refuse(409, CLOUD_ERROR_CODES.invalidRequest)
  if (claim.kind === "busy") return refuse(503, CLOUD_ERROR_CODES.busy)

  try {
    // A deletion already open for the org (another timer id, or this one's
    // attempt that died before storing its outcome): adopt it.
    const open = await findOpenOrgDeletion(req.orgId)
    if (open) {
      await completeOutcome(ENDPOINT, req.timerId, 200, { deletionId: open.id })
      return replyFor(open.id)
    }

    const [org] = await withSystemDb("cloud-delete-org-load", (db) =>
      db
        .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, req.orgId))
        .limit(1),
    )
    if (!org) {
      // Gone already: done when a deletion of it completed, else unknown.
      const [last] = await withSystemDb("cloud-delete-org-last", (db) =>
        db
          .select()
          .from(orgDeletions)
          .where(eq(orgDeletions.deletedOrgId, req.orgId))
          .orderBy(desc(orgDeletions.createdAt))
          .limit(1),
      )
      if (last?.status === "completed") {
        await completeOutcome(ENDPOINT, req.timerId, 200, { deletionId: last.id })
        return { status: 200, reply: { ok: true, state: "done" } }
      }
      await releaseClaim(ENDPOINT, req.timerId)
      return refuse(404, CLOUD_ERROR_CODES.notFound)
    }

    const refused = await fence(org.id)
    if (refused) {
      await releaseClaim(ENDPOINT, req.timerId)
      return refused
    }

    const at = new Date().toISOString()
    const row = await beginOrgDeletion({
      orgId: org.id,
      slug: org.slug,
      name: org.name,
      operator: operatorOf(req.timerId),
      waivers: [
        { kind: "without-export", at, reason: MANAGED_DELETION_WAIVER_REASONS.export },
        { kind: "no-legal-archive", at, reason: MANAGED_DELETION_WAIVER_REASONS.legalArchive },
      ],
      export: null,
      legalArchiveRecipient: null,
    })
    await completeOutcome(ENDPOINT, req.timerId, 200, { deletionId: row.id })
    log.warn(
      { orgId: org.id, slug: org.slug, deletionId: row.id, timerId: req.timerId },
      "managed org deletion started by the control plane",
    )
    const handed = await handOrgDeletionToWorker(row)
    if (!handed.ok) {
      log.error({ deletionId: row.id, detail: handed.detail }, "org deletion not queued")
      return { status: 200, reply: { ok: true, state: "failed" } }
    }
    return { status: 200, reply: { ok: true, state: "queued" } }
  } catch (err) {
    if (err instanceof OrgDeletionOpenError) {
      // Opened concurrently by another caller: the repeat adopts it.
      await releaseClaim(ENDPOINT, req.timerId)
      return refuse(503, CLOUD_ERROR_CODES.busy)
    }
    log.error({ err, orgId: req.orgId, timerId: req.timerId }, "managed org deletion failed")
    await releaseClaim(ENDPOINT, req.timerId).catch(() => undefined)
    throw err
  }
}
