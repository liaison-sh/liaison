// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cell side of auto top-up (spec S22, A34). After a metered deduction, if
// the org's stored auto top-up (the control plane's billing push,
// `kernel.org_billing_state.auto_top_up`) is on and the org's credits
// (included + purchased) are below the threshold after it, the cell asks the
// control plane for a top-up: one signed `billing.auto_topup_request` through
// the outbox (retried until delivered), whose `crossingId` is the deduction's
// transaction id. A level check, not a crossing: an org turned on while
// already below, a request Control refused within its hour, or one lost to a
// crash before it was queued, asks again on its next deduction. The cell asks
// at most once per ASK_INTERVAL_MS per org; Control dedupes on the id and
// allows one top-up per org per hour.

import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { orgBillingState } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { enqueue } from "~/modules/liaison-team/outbox"

const log = rootLogger.child({ module: "auto-topup-trigger" })

export interface DeductionOutcome {
  orgId: string
  /** The usage row's id: the crossing's id. */
  transactionId: string
  /** Credits left after the deduction (included + purchased). */
  balanceAfter: number
  /** Credits the deduction took. */
  amount: number
}

/** The cell's own spacing of an org's requests; Control enforces the hour. */
export const ASK_INTERVAL_MS = 10 * 60_000

/** Is the org below its threshold after this deduction? */
export function belowThreshold(d: DeductionOutcome, thresholdCredits: number): boolean {
  return d.amount > 0 && d.balanceAfter < thresholdCredits
}

/**
 * Queue the auto top-up request when the org is below its threshold after
 * this deduction and asked no more recently than ASK_INTERVAL_MS. Returns
 * whether a request was queued. Never throws: a failure is logged and the
 * next deduction asks again.
 */
export async function maybeRequestAutoTopUp(d: DeductionOutcome): Promise<boolean> {
  if (!isManagedEdition()) return false
  try {
    return await withSystemDb("cloud-auto-topup-trigger", async (db) => {
      const [row] = await db
        .select({ autoTopUp: orgBillingState.autoTopUp })
        .from(orgBillingState)
        .where(eq(orgBillingState.orgId, d.orgId))
      const auto = row?.autoTopUp
      if (!auto?.enabled || !belowThreshold(d, auto.thresholdCredits)) return false
      const since = new Date(Date.now() - ASK_INTERVAL_MS).toISOString()
      const recent = extractRows(
        await db.execute(drizzleSql`
          SELECT 1 FROM ${drizzleSql.raw(`"${schemaRef("kernel")}"`)}.control_plane_outbox
           WHERE type = 'billing.auto_topup_request' AND data->>'orgId' = ${d.orgId}
             AND created_at > ${since}::timestamptz
           LIMIT 1`),
      )
      if (recent.length > 0) return false
      await enqueue(db, "billing.auto_topup_request", {
        requestId: randomUUID(),
        orgId: d.orgId,
        crossingId: d.transactionId,
      })
      log.info({ orgId: d.orgId, crossingId: d.transactionId }, "auto top-up requested")
      return true
    })
  } catch (err) {
    log.error({ err, orgId: d.orgId }, "auto top-up request could not be queued")
    return false
  }
}
