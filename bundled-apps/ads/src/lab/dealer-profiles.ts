// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dealer profile handlers — wholesale/dealer relationship metadata used to
// inform dealer-sell-in sensing and B2B attribution (doctrine block E:
// B2B revenue must be split out before drawing DTC conclusions). A B2B order is
// recognised by the order itself (company order, B2B order tag, legacy B2B sku
// suffix), see metrics/sku-classing.ts.
// `dealer_profile_upsert` is gated; `dealer_profiles_list` is an ungated read.
//
// All handlers use (params, ctx) — the kernel convention.

import type { AppCtx } from "../lib/ctx-types"
import {
  type PreflightOutcome,
  refuse,
  throwIfRefused,
  toPreflightResult,
} from "../lib/preflight"

function checkString(p: Record<string, unknown>, field: string): PreflightOutcome<{ value: string }> {
  const v = p[field]
  if (typeof v !== "string" || !v) {
    return refuse("invalid_params", `${field} is required`)
  }
  return { ok: true, value: v }
}

/**
 * Shared checker for dealer_profile_upsert. The dealer_id existence check needs
 * a DB lookup, so it cannot live in the params schema: both the handler and the
 * manifest `preflight` run this one function. Read-only (findOne only).
 */
export async function preflightDealerProfileUpsertParams(
  p: Record<string, unknown>,
  ctx: AppCtx,
): Promise<PreflightOutcome<{ dealerName: string; dealerType: string; dealerId?: string }>> {
  if (!ctx.db) {
    return refuse(
      "invalid_params",
      "dealer_profile_upsert: ctx.db is required (app DB not available)",
    )
  }

  const nameCheck = checkString(p, "dealer_name")
  if (!("ok" in nameCheck)) return nameCheck
  const typeCheck = checkString(p, "dealer_type")
  if (!("ok" in typeCheck)) return typeCheck

  const validTypes = ["broadline", "boutique"]
  if (!validTypes.includes(typeCheck.value)) {
    return refuse(
      "invalid_params",
      `dealer_profile_upsert: dealer_type must be one of ${validTypes.join(", ")}`,
    )
  }

  const dealerId = typeof p.dealer_id === "string" && p.dealer_id ? p.dealer_id : undefined
  if (dealerId) {
    const existing = await ctx.db.findOne("dealer_profiles", dealerId)
    if (!existing) {
      return refuse("not_found", `dealer_profile_upsert: dealer ${dealerId} not found`)
    }
  }

  return { ok: true, dealerName: nameCheck.value, dealerType: typeCheck.value, dealerId }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. An update naming a dealer_id that does not exist used to be queued
// for approval and only then fail with a not-found the agent could have fixed.
export async function dealer_profile_upsert_preflight(
  params: unknown,
  ctx: AppCtx,
): Promise<unknown> {
  return toPreflightResult(
    await preflightDealerProfileUpsertParams((params ?? {}) as Record<string, unknown>, ctx),
  )
}

// ─── dealer_profile_upsert (gated) ────────────────────────────────────────────

export async function dealer_profile_upsert(params: unknown, ctx: AppCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  const checked = throwIfRefused(await preflightDealerProfileUpsertParams(p, ctx))
  if (!ctx.db) throw new Error("dealer_profile_upsert: ctx.db is required (app DB not available)")

  const dealerName = checked.dealerName
  const dealerType = checked.dealerType

  const patch: Record<string, unknown> = {
    dealer_name: dealerName,
    dealer_type: dealerType,
  }
  if (typeof p.sku_match_hints === "string") patch.sku_match_hints = p.sku_match_hints
  if (typeof p.coverage_area === "string") patch.coverage_area = p.coverage_area
  if (typeof p.notes === "string") patch.notes = p.notes
  if (typeof p.reorder_cadence === "string") patch.reorder_cadence = p.reorder_cadence

  const dealerId = typeof p.dealer_id === "string" && p.dealer_id ? p.dealer_id : undefined

  if (dealerId) {
    const existing = await ctx.db.findOne("dealer_profiles", dealerId)
    if (!existing) throw new Error(`dealer_profile_upsert: dealer ${dealerId} not found`)
    await ctx.db.update("dealer_profiles", dealerId, patch)
    const readBack = await ctx.db.findOne("dealer_profiles", dealerId)
    return { id: dealerId, row: readBack }
  }

  patch.created_by = ctx.actorId ?? "agent"
  const inserted = await ctx.db.insert("dealer_profiles", patch)
  const readBack = await ctx.db.findOne("dealer_profiles", inserted.id)
  return { id: inserted.id, row: readBack }
}

// ─── dealer_profiles_list (ungated read) ──────────────────────────────────────

export async function dealer_profiles_list(params: unknown, ctx: AppCtx): Promise<unknown> {
  if (!ctx.db) throw new Error("dealer_profiles_list: ctx.db is required (app DB not available)")
  const p = (params ?? {}) as Record<string, unknown>

  const where: Record<string, unknown> = {}
  if (typeof p.dealer_name === "string" && p.dealer_name) where.dealer_name = p.dealer_name

  const rows = await ctx.db.findMany("dealer_profiles", {
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { createdAt: "desc" },
    limit: typeof p.limit === "number" ? p.limit : undefined,
  })

  return {
    dealers: rows,
    count: rows.length,
  }
}
