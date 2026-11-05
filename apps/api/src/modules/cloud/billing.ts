// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The billing push of the managed edition (`POST /api/cloud/orgs/:id/billing`,
// spec S16) and the state the cell serves from it.
//
// One statement decides: `INSERT … ON CONFLICT (org_id) DO UPDATE … WHERE the
// stored version < the pushed one`. A push that loses (an older version,
// delivered late or concurrently) changes nothing and answers `applied: false`
// with the version the cell holds. A push that wins also sets, in the same
// transaction, the org's kernel tier (preview→starter, base→team,
// pro→business, so existing tier reads keep working) and its caps. The row
// lock of the upsert orders concurrent pushes: the tier and caps written last
// are always those of the newest version.
//
// Payment resumed (P3R-18): while an org is past_due or suspended its side
// calls are refused (D17), embeddings included, so its new messages were
// indexed keyword only. The push that takes it from past_due|suspended back
// to active starts its embedding backfill, once. The previous status is read
// under the same row lock as the upsert, so only the transition starts it. The
// same push starts the one-shot routines that came due while it was unpaid. Both
// wait out STATUS_TTL_MS: another process may still read the old status for that
// long, skip the job as "suspended" and complete it, and the push never repeats.

import {
  CLOUD_ERROR_CODES,
  CLOUD_PLAN_TIERS,
  type CloudBillingPushReply,
  type CloudBillingPushRequest,
  type CloudErrorReply,
  type ManagedBillingState,
} from "@liaison/control-plane-contract"
import type { OrgCaps } from "@liaison/shared"
import { and, sql as drizzleSql, eq, isNull, lte, or } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations, orgBillingState, routines } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { invalidateOrgBillingStatus, STATUS_TTL_MS } from "./billing-status"

export type BillingPushResult =
  | { status: 200; reply: CloudBillingPushReply }
  | { status: 404; reply: CloudErrorReply }

const log = rootLogger.child({ module: "cloud-billing" })

/** The statuses whose side calls are refused (D17); leaving them for active resumes them. */
const PAYMENT_REQUIRED_STATUSES = new Set(["past_due", "suspended"])

/** A job started on resume, past the time every process may still read the old status. */
const RESUME_DELAY_MS = STATUS_TTL_MS + 1000

export interface BillingPushDeps {
  /** The org went from past_due or suspended back to active (after commit). */
  onPaymentResumed: (orgId: string) => Promise<void>
}

/**
 * Embeddings were refused while payment was required: drop the memoised
 * embedder and start (or join) the org's backfill chain, which gives the
 * messages indexed keyword only meanwhile their vectors.
 */
async function resumeEmbeddings(orgId: string): Promise<void> {
  const [{ invalidateOrgEmbedder }, { enqueueEmbeddingBackfill }] = await Promise.all([
    import("~/modules/search/message-indexer"),
    import("~/infra/jobs/embedding-backfill"),
  ])
  invalidateOrgEmbedder(orgId)
  await enqueueEmbeddingBackfill(orgId, undefined, { delay: RESUME_DELAY_MS })
}

/**
 * A suspended org's jobs are skipped with their schedulers kept, so a recurring routine fires on its
 * next tick. A one-shot has no next tick: one that came due while suspended stays "active" and never
 * ran, and one that came due during past_due ran its tick into the credit gate and stays paused
 * (its tick resumes it). Both run now. A pause always precedes the run, so a paused one never ran;
 * its lastRunAt only dates the refusal. Returns how many were started.
 */
export async function rerunMissedOneShots(
  orgId: string,
  enqueue?: (routineId: string) => Promise<void>,
  now: Date = new Date(),
): Promise<number> {
  const missed = await withPrivilegedDb(orgId, "cloud-resume-routines", (tx) =>
    tx
      .select({ id: routines.id })
      .from(routines)
      .where(
        and(
          eq(routines.orgId, orgId),
          eq(routines.kind, "scheduled"),
          eq(routines.enabled, true),
          lte(routines.runAt, now),
          or(
            and(eq(routines.status, "active"), isNull(routines.lastRunAt)),
            eq(routines.status, "paused_no_credits"),
          ),
        ),
      ),
  )
  const start =
    enqueue ??
    (async (routineId: string) => {
      const { enqueueAppJobForServer } = await import("~/infra/jobs/jobs")
      await enqueueAppJobForServer(
        "kernel",
        "routine-tick",
        { routineId, orgId, scheduledAt: now.toISOString() },
        {
          jobId: `routine-oneshot:${routineId}:resumed:${now.getTime()}`,
          delay: RESUME_DELAY_MS,
        },
      )
    })
  let started = 0
  for (const { id } of missed) {
    try {
      await start(id)
      started += 1
    } catch (err) {
      log.error({ err, orgId, routineId: id }, "Could not restart a one-shot routine after payment")
    }
  }
  return started
}

/** Each part on its own: a lost backfill start must not cost a routine its run. */
async function resumeOrgWork(orgId: string): Promise<void> {
  await resumeEmbeddings(orgId).catch((err) =>
    log.error({ err, orgId }, "Could not start the embedding backfill"),
  )
  await rerunMissedOneShots(orgId).catch((err) =>
    log.error({ err, orgId }, "Could not restart the one-shot routines after payment"),
  )
}

export const defaultBillingPushDeps: BillingPushDeps = { onPaymentResumed: resumeOrgWork }

export async function applyBillingPush(
  req: CloudBillingPushRequest,
  caps: OrgCaps,
  deps: BillingPushDeps = defaultBillingPushDeps,
): Promise<BillingPushResult> {
  const [org] = await withSystemDb("cloud-billing-org", (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, req.orgId))
      .limit(1),
  )
  if (!org) return { status: 404, reply: { ok: false, code: CLOUD_ERROR_CODES.notFound } }

  const before: { status: string | null } = { status: null }
  const result = await withPrivilegedDb(req.orgId, "cloud-billing-push", async (tx) => {
    // Locked: a concurrent push waits here, so each sees the status the
    // other committed and only one of them sees the transition.
    const [prev] = await tx
      .select({ status: orgBillingState.status })
      .from(orgBillingState)
      .where(eq(orgBillingState.orgId, req.orgId))
      .for("update")
    before.status = prev?.status ?? null
    const values = {
      orgId: req.orgId,
      version: req.version,
      plan: req.plan,
      status: req.status,
      periodEnd: new Date(req.periodEnd),
      includedCredits: req.includedCredits,
      caps: req.caps,
      previewEndsAt: req.previewEndsAt === null ? null : new Date(req.previewEndsAt),
      autoTopUp: req.autoTopUp,
      // Absent from a Control that predates them: read as null (the contract).
      accessUntil: req.accessUntil ? new Date(req.accessUntil) : null,
      closedAt: req.closedAt ? new Date(req.closedAt) : null,
      billingContact: req.billingContact ?? null,
    }
    const { orgId: _orgId, ...update } = values
    const applied = await tx
      .insert(orgBillingState)
      .values(values)
      .onConflictDoUpdate({
        target: orgBillingState.orgId,
        set: { ...update, updatedAt: drizzleSql`now()` },
        setWhere: drizzleSql`${orgBillingState.version} < excluded.version`,
      })
      .returning({ version: orgBillingState.version })

    if (applied.length === 0) {
      const [held] = await tx
        .select({ version: orgBillingState.version })
        .from(orgBillingState)
        .where(eq(orgBillingState.orgId, req.orgId))
      return {
        status: 200 as const,
        reply: { ok: true as const, applied: false, version: held?.version ?? req.version },
      }
    }

    await tx
      .update(organizations)
      .set({ tier: CLOUD_PLAN_TIERS[req.plan], caps, updatedAt: new Date() })
      .where(eq(organizations.id, req.orgId))
    return {
      status: 200 as const,
      reply: { ok: true as const, applied: true, version: req.version },
    }
  })
  // Once committed: this process serves the new status at once, the others
  // within the status cache's TTL (billing-status.ts).
  if (result.reply.applied) {
    invalidateOrgBillingStatus(req.orgId)
    if (
      req.status === "active" &&
      before.status !== null &&
      PAYMENT_REQUIRED_STATUSES.has(before.status)
    ) {
      // Best effort: the push itself has landed; a lost backfill start costs
      // vectors on the gap's messages, never the billing state.
      await deps
        .onPaymentResumed(req.orgId)
        .catch((err) => log.error({ err, orgId: req.orgId }, "Could not resume the org's work"))
    }
  }
  return result
}

/** The org's stored billing state in the managed reply's shape, or null before the first push. */
export async function readManagedBillingState(orgId: string): Promise<ManagedBillingState | null> {
  const [row] = await withPrivilegedDb(orgId, "billing-state-read", (tx) =>
    tx.select().from(orgBillingState).where(eq(orgBillingState.orgId, orgId)).limit(1),
  )
  if (!row) return null
  const plan = row.plan as ManagedBillingState["plan"]
  return {
    mode: "managed",
    plan,
    tier: CLOUD_PLAN_TIERS[plan],
    status: row.status as ManagedBillingState["status"],
    periodEnd: row.periodEnd.toISOString(),
    includedCredits: trimDecimal(row.includedCredits),
    previewEndsAt: row.previewEndsAt === null ? null : row.previewEndsAt.toISOString(),
    autoTopUp: row.autoTopUp,
    accessUntil: row.accessUntil === null ? null : row.accessUntil.toISOString(),
    ...(row.billingContact !== null ? { billingContact: row.billingContact } : {}),
  }
}

/** `250.00000000` → `250`, `1.50000000` → `1.5`. */
function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value
}
