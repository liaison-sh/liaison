// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Credit grants of the managed edition (`POST /api/cloud/orgs/:id/credits`,
// spec S17, S21, S22, S41): the only way credits reach an org on a cell.
//
// Idempotent on `grantId` (the paid invoice's id) through the outcome store:
// the claim binds the org, the kind and the amount, so a repeat returns the
// first reply and the same id with another org, kind or amount is 409
// `grant_conflict` with nothing credited. Below it, the credit ledger's own
// unique refs (`external_payment_ref` for a top-up, `cycle_id` for a period
// reset) keep a resumed attempt from crediting twice.
//
//   topup, auto_topup → purchased credits added (`top_up`, described manual/auto);
//   period_reset      → the included credits set to the period's amount (`monthly_reset`).

import {
  CLOUD_ERROR_CODES,
  type CloudCreditGrantReply,
  type CloudCreditGrantRequest,
  type CloudErrorReply,
} from "@liaison/control-plane-contract"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import {
  addCredits,
  broadcastBalanceUpdate,
  IdempotencyConflictError,
} from "~/modules/agent/credits/credit-service"
import { claimOutcome, completeOutcome, releaseClaim } from "./outcomes"

const ENDPOINT = "POST /orgs/:id/credits"
const log = rootLogger.child({ service: "cloud-credits" })

export type CreditGrantResult =
  | { status: 200; reply: CloudCreditGrantReply }
  | { status: 404 | 409 | 503; reply: CloudErrorReply }

/** `25` and `25.000` are one amount. */
const normalise = (credits: string) => Number.parseFloat(credits).toFixed(8)

export async function applyCreditGrant(req: CloudCreditGrantRequest): Promise<CreditGrantResult> {
  const binding = `${req.orgId}|${req.kind}|${normalise(req.credits)}`
  const claim = await claimOutcome(ENDPOINT, req.grantId, binding)
  if (claim.kind === "done") {
    return claim.status === 200
      ? { status: 200, reply: claim.reply as CloudCreditGrantReply }
      : { status: 409, reply: claim.reply as CloudErrorReply }
  }
  if (claim.kind === "mismatch") {
    return { status: 409, reply: { ok: false, code: CLOUD_ERROR_CODES.grantConflict } }
  }
  if (claim.kind === "busy") {
    return { status: 503, reply: { ok: false, code: CLOUD_ERROR_CODES.busy } }
  }

  const [org] = await withSystemDb("cloud-credits-org", (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, req.orgId))
      .limit(1),
  )
  if (!org) {
    await releaseClaim(ENDPOINT, req.grantId)
    return { status: 404, reply: { ok: false, code: CLOUD_ERROR_CODES.notFound } }
  }

  try {
    if (req.kind === "period_reset") {
      await addCredits(req.orgId, {
        amount: req.credits,
        type: "monthly_reset",
        cycleId: req.grantId,
        description: `period reset ${req.grantId}`,
      })
    } else {
      await addCredits(req.orgId, {
        amount: req.credits,
        type: "top_up",
        externalPaymentRef: req.grantId,
        description: req.kind === "auto_topup" ? "auto" : "manual",
      })
    }
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      // The ledger already holds this ref with another amount (written outside
      // this endpoint): refuse, and keep the refusal as the key's outcome.
      log.warn({ orgId: req.orgId, grantId: req.grantId, diff: err.diff }, "credit grant conflict")
      const reply: CloudErrorReply = { ok: false, code: CLOUD_ERROR_CODES.grantConflict }
      await completeOutcome(ENDPOINT, req.grantId, 409, reply)
      return { status: 409, reply }
    }
    log.error(
      { err, orgId: req.orgId, grantId: req.grantId, kind: req.kind },
      "credit grant failed",
    )
    await releaseClaim(ENDPOINT, req.grantId)
    throw err
  }

  const reply: CloudCreditGrantReply = { ok: true, grantId: req.grantId }
  await completeOutcome(ENDPOINT, req.grantId, 200, reply)
  await broadcastBalanceUpdate(req.orgId)
  return { status: 200, reply }
}
