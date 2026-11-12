// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B14 — Admin-gated staff-overrides upsert + delete.
//
// The manifest declares both tools as
//   scope: "shopify:admin:identity_map", gated: true, trustBoundary: "user"
// so the kernel blocks callers without the scope before this code ever runs.
// The body assumes the call is authorised.
//
// Upsert semantics: a row keyed by `liaisonUserId` is upserted. Two different
// users → two different rows. Re-upserting the same Liaison user replaces the
// existing `shopifyStaffId` + `reason` (admin moved Marie from one staff
// identity to another).
import type { AppContext } from "@liaison/app-sdk"
import { runUserId } from "../lib/run-identity"

interface OverrideError extends Error {
  code: string
}

function makeError(code: string, message: string): OverrideError {
  const e = new Error(message) as OverrideError
  e.code = code
  return e
}

interface ExistingRow {
  id: string
  liaisonUserId: string
  shopifyStaffId: string
  reason?: string | null
  createdBy?: string | null
}

type PreflightResult = { ok: true } | { error: { code: string; message: string } }

/**
 * The whole stage-time-knowable validation of a staff_overrides_upsert call: both ids present, and
 * the requested Shopify staff id not already mapped to a DIFFERENT Liaison user. READ ONLY. Called by
 * BOTH the handler and the manifest preflight so the two can never drift.
 */
async function preflightStaffOverridesUpsertParams(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  const liaisonUserId = params.liaisonUserId
  const shopifyStaffId = params.shopifyStaffId
  if (typeof liaisonUserId !== "string" || !liaisonUserId) {
    return { error: { code: "INVALID_ARG", message: "liaisonUserId is required" } }
  }
  if (typeof shopifyStaffId !== "string" || !shopifyStaffId) {
    return { error: { code: "INVALID_ARG", message: "shopifyStaffId is required" } }
  }
  // I10 — surface staff-id conflicts explicitly (no opaque DB constraint
  // error). If a different Liaison user is already mapped to the requested
  // Shopify staff id, refuse and let the admin resolve manually.
  const staffIdHolders = (await ctx.db.findMany("staff_overrides", {
    where: { shopifyStaffId },
    limit: 2,
  })) as ExistingRow[]
  const conflicting = staffIdHolders.find((r) => r.liaisonUserId !== liaisonUserId)
  if (conflicting) {
    return {
      error: {
        code: "STAFF_ID_CONFLICT",
        message: `Shopify staff id ${shopifyStaffId} is already mapped to a different Liaison user; resolve the existing mapping first.`,
      },
    }
  }
  return { ok: true }
}

/**
 * STAGE-TIME preflight for the gated `staff_overrides_upsert` (manifest `preflight`). A gated call must
 * not be parked for a human when the data it needs is missing or conflicting: an admin asked to approve
 * a mapping whose staff id already belongs to someone else can do nothing with the failure.
 */
export async function staff_overrides_upsert_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  return preflightStaffOverridesUpsertParams(params, ctx)
}

export async function staff_overrides_upsert(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ id: string }> {
  const pre = await preflightStaffOverridesUpsertParams(params, ctx)
  if (!("ok" in pre)) throw makeError(pre.error.code, pre.error.message)
  const liaisonUserId = params.liaisonUserId as string
  const shopifyStaffId = params.shopifyStaffId as string
  const reason = (params.reason as string | undefined) ?? null
  const existing = (await ctx.db.findMany("staff_overrides", {
    where: { liaisonUserId },
    limit: 1,
  })) as ExistingRow[]
  if (existing.length > 0) {
    const row = existing[0]!
    await ctx.db.update("staff_overrides", row.id, {
      shopifyStaffId,
      reason,
    })
    return { id: row.id }
  }
  // created_at is kernel-managed; passing it here is an undeclared field and
  // the sandbox rejects it, so the first-mapping insert path throws.
  const ins = await ctx.db.insert("staff_overrides", {
    liaisonUserId,
    shopifyStaffId,
    reason,
    createdBy: await runUserId(ctx),
  })
  return { id: ins.id }
}

export async function staff_overrides_delete(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<void> {
  const id = params.id
  if (typeof id !== "string" || !id) {
    throw makeError("INVALID_ARG", "id is required")
  }
  const row = await ctx.db.findOne("staff_overrides", id)
  if (!row) return
  await ctx.db.delete("staff_overrides", id)
}
