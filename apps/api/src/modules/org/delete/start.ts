// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The gate-free core of an org deletion, shared by the operator's CLI
// (`liaison org delete`, cli/org-delete.ts) and the control plane's signed
// `DELETE /api/cloud/orgs/:id` (modules/cloud/delete-org.ts), so there is one
// deletion path: the ledger row, step 1 (the org is marked deleting), and the
// `org-delete` job that writes the legal archive and runs the purge
// (job.ts). Each caller checks its own gates first.

import { and, eq, inArray } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { OrgDeletionRow } from "~/db/schema/kernel"
import { orgExports } from "~/db/schema/kernel"
import { markOrgDeleting } from "~/modules/org/purge/deleting"
import { enqueueOrgDelete, MARK_STEP, type OrgDeleteJobPayload } from "./job"
import {
  createOrgDeletion,
  failOrgDeletion,
  markOrgDeletionQueued,
  type NewOrgDeletion,
  ORG_DELETION_STALE_MS,
  recordOrgDeletionStep,
} from "./ledger"

/** The org's export that is queued or running, or null. */
export async function runningOrgExport(
  orgId: string,
): Promise<{ id: string; status: string } | null> {
  const [row] = await withSystemDb("org-delete-running-export", (tx) =>
    tx
      .select({ id: orgExports.id, status: orgExports.status })
      .from(orgExports)
      .where(and(eq(orgExports.orgId, orgId), inArray(orgExports.status, ["queued", "running"])))
      .limit(1),
  )
  return row ?? null
}

/**
 * Writes the ledger row and takes step 1: from here every request for the org
 * gets 410 and its jobs are dropped. Throws `OrgDeletionOpenError` when a
 * deletion of the org is already open.
 */
export async function beginOrgDeletion(input: NewOrgDeletion): Promise<OrgDeletionRow> {
  const row = await createOrgDeletion(input)
  await markOrgDeleting(input.orgId)
  await recordOrgDeletionStep(row.id, MARK_STEP)
  return row
}

/** A run holds the deletion right now (its heartbeat is fresh). */
export function orgDeletionRunIsLive(row: OrgDeletionRow): boolean {
  return row.status === "running" && Date.now() - row.updatedAt.getTime() < ORG_DELETION_STALE_MS
}

/**
 * Hands the deletion to the `org-delete` job, unless a live run holds it. A
 * queueing failure is recorded on the ledger (`failed`) and returned.
 */
export async function handOrgDeletionToWorker(
  row: OrgDeletionRow,
  // For the server's worker: the caller may be the CLI or an `api`-role
  // process, neither of which hosts the job's handler.
  enqueue: (payload: OrgDeleteJobPayload) => Promise<unknown> = (p) =>
    enqueueOrgDelete(p, { forServer: true }),
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (orgDeletionRunIsLive(row)) return { ok: true }
  await markOrgDeletionQueued(row.id)
  try {
    await enqueue({ deletionId: row.id, targetOrgId: row.deletedOrgId })
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await failOrgDeletion(row.id, `QUEUE_FAILED: ${detail}`)
    return { ok: false, detail }
  }
}
