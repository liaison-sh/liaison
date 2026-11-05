// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Manual (non-platform) spend ledger — feeds blended MER's total-spend
// denominator (e.g. specialized-site placements, dealer co-op spend that
// never appears in Meta/Google insights). `manual_spend_add` is gated
// (a spend record affects blended metrics that justify further spend
// decisions); `manual_spend_list` is an ungated read.
//
// All handlers use (params, ctx) — the kernel convention.

import type { AppCtx } from "../lib/ctx-types"

function requireString(p: Record<string, unknown>, field: string): string {
  const v = p[field]
  if (typeof v !== "string" || !v) {
    throw new Error(`${field} is required`)
  }
  return v
}

function requireNumber(p: Record<string, unknown>, field: string): number {
  const v = p[field]
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${field} is required`)
  }
  return v
}

// ─── manual_spend_add (gated) ─────────────────────────────────────────────────

export async function manual_spend_add(params: unknown, ctx: AppCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  if (!ctx.db) throw new Error("manual_spend_add: ctx.db is required (app DB not available)")

  const channel = requireString(p, "channel")
  const periodStart = requireString(p, "period_start")
  const periodEnd = requireString(p, "period_end")
  const amount = requireNumber(p, "amount")
  const currency = requireString(p, "currency")

  const row: Record<string, unknown> = {
    channel,
    period_start: periodStart,
    period_end: periodEnd,
    amount,
    currency,
    created_by: ctx.actorId ?? "agent",
  }
  if (typeof p.site === "string") row.site = p.site
  if (typeof p.notes === "string") row.notes = p.notes

  const inserted = await ctx.db.insert("manual_spend", row)
  const readBack = await ctx.db.findOne("manual_spend", inserted.id)

  return { id: inserted.id, row: readBack }
}

// ─── manual_spend_list (ungated read) ─────────────────────────────────────────

export async function manual_spend_list(params: unknown, ctx: AppCtx): Promise<unknown> {
  if (!ctx.db) throw new Error("manual_spend_list: ctx.db is required (app DB not available)")
  const p = (params ?? {}) as Record<string, unknown>

  const where: Record<string, unknown> = {}
  if (typeof p.channel === "string" && p.channel) where.channel = p.channel

  const rows = await ctx.db.findMany("manual_spend", {
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { period_start: "desc" },
    limit: typeof p.limit === "number" ? p.limit : undefined,
  })

  return {
    entries: rows,
    count: rows.length,
    note:
      rows.length > 0
        ? undefined
        : "Manual spend ledger is unseeded (no rows yet). This is not necessarily zero non-platform spend, note the ledger is unseeded rather than assuming zero.",
  }
}
