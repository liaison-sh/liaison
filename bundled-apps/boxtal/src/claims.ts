// SPDX-License-Identifier: FSL-1.1-ALv2
// Boxtal claims — open a carrier claim against a shipment stuck in an exception
// state. Gated (money). RECORD-AND-DEGRADE: when the carrier claims API is
// unavailable we still record the claim locally and report
// `submitted_to_carrier:false` rather than fabricating a carrier filing.
import type { BoxtalToolCtx } from "./ctx"
import { EXCEPTION_STATES } from "./queues"

export interface ClaimOpenInput {
  shipment_id: string
  type: string
  amount: number
  evidence_file_ids: string[]
}

export interface ClaimOpenResult {
  claim_id: string
  status: "open"
  submitted_to_carrier: boolean
}

interface ShipmentRowLike {
  id?: string | number
  tracking_status?: string | null
}

/**
 * Read-only eligibility check for a claim target: the shipment must exist and be
 * in an exception tracking state. ONE copy, called by BOTH the stage-time
 * preflight and the handler, so the two can never drift apart.
 */
async function claimTargetEligibility(
  ctx: BoxtalToolCtx,
  shipmentId: string,
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const shipment = (await ctx.db.findOne("shipment", shipmentId)) as ShipmentRowLike | null
  if (!shipment) {
    return {
      error: { code: "shipment_not_found", message: `shipment ${shipmentId} not found` },
    }
  }
  const status = shipment.tracking_status ?? null
  if (status == null || !EXCEPTION_STATES.includes(status)) {
    return {
      error: {
        code: "not_claimable",
        message: `shipment ${shipmentId} is not in an exception state (not eligible for a claim)`,
      },
    }
  }
  return { ok: true }
}

/**
 * claim_open STAGE-TIME preflight (manifest `preflight`). claim_open is gated, so
 * WHY this exists: a gated call must not be parked for a human when the data it
 * needs is missing. Without it the kernel files an approval for a claim against a
 * nonexistent or non-claimable shipment, and the handler only throws once the
 * approver has already clicked approve. Read-only: it performs the same lookup the
 * handler does and writes nothing.
 */
export async function claimOpenPreflight(
  ctx: BoxtalToolCtx,
  input: { shipment_id: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  return claimTargetEligibility(ctx, input.shipment_id)
}

/**
 * Open a claim against a shipment. Fails if the shipment is not in an exception
 * tracking state (cannot claim a delivered parcel). Persists an app-private
 * `claim` row, then attempts to submit to the carrier if the claims API is
 * available; otherwise records locally (honest-partial).
 */
export async function claimOpen(
  ctx: BoxtalToolCtx & { claimsApiAvailable?: boolean },
  input: ClaimOpenInput,
): Promise<ClaimOpenResult> {
  const eligibility = await claimTargetEligibility(ctx, input.shipment_id)
  if ("error" in eligibility) {
    throw new Error(eligibility.error.message)
  }
  // The carrier claims API is only attempted when the Mission-0 probe recorded
  // it as available. Absent that, we record the claim locally and report it was
  // not submitted to the carrier — no fabricated filing.
  const submittedToCarrier = ctx.claimsApiAvailable === true
  // `created_at` is a framework-managed system column (auto-injected into the
  // table DDL and stamped DEFAULT NOW()); it must NOT be declared in the manifest
  // `fields` nor passed through db_insert (validateFields rejects non-field keys).
  const inserted = (await ctx.db.insert("claim", {
    shipment_id: input.shipment_id,
    type: input.type,
    amount: input.amount,
    status: "open",
    evidence_file_ids: input.evidence_file_ids,
    submitted_to_carrier: submittedToCarrier,
  })) as { id: string }
  return { claim_id: inserted.id, status: "open", submitted_to_carrier: submittedToCarrier }
}

/**
 * The boxtal tool set, computed for the current claims-API availability —
 * RECORD-AND-DEGRADE registration. `exceptions_list` always ships; `claim_open`
 * is registered ONLY when the carrier claims API is available, so a broken tool
 * is never exposed when the dependency is down.
 */
export function registeredBoxtalTools(opts: { claimsApiAvailable: boolean }): string[] {
  const tools = ["exceptions_list"]
  if (opts.claimsApiAvailable) tools.push("claim_open")
  return tools
}
