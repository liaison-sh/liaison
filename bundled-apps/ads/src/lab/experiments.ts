// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Experiment ledger handlers — the ads lab's "private bookkeeping" table.
// `experiment_open` moves no money and is ALWAYS ungated (spec: "a private
// bookkeeping insert"). `experiment_update`/`experiment_close`/`experiment_list`
// are also ungated bookkeeping. The refuse-early-winner semantics ("do not
// declare a winner before decision_date AND minimum_sample are both reached")
// is an AGENT-INSTRUCTION doctrine (agentInstructions block G), not enforced
// by these handlers — experiment_close records whatever verdict the agent
// (or a human override) supplies.
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

// ─── experiment_open (UNGATED) ────────────────────────────────────────────────

export async function experiment_open(params: unknown, ctx: AppCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  if (!ctx.db) throw new Error("experiment_open: ctx.db is required (app DB not available)")

  const title = requireString(p, "title")
  const hypothesis = requireString(p, "hypothesis")
  const metricTier = requireString(p, "metric_tier")
  const primaryMetric = requireString(p, "primary_metric")

  const validTiers = ["upper_funnel", "purchase", "blended"]
  if (!validTiers.includes(metricTier)) {
    throw new Error(`experiment_open: metric_tier must be one of ${validTiers.join(", ")}`)
  }

  const status = typeof p.status === "string" && p.status ? p.status : "draft"
  const validStatuses = ["draft", "running", "decided", "abandoned"]
  if (!validStatuses.includes(status)) {
    throw new Error(`experiment_open: status must be one of ${validStatuses.join(", ")}`)
  }

  const row: Record<string, unknown> = {
    title,
    hypothesis,
    metric_tier: metricTier,
    primary_metric: primaryMetric,
    status,
    created_by: ctx.actorId ?? "agent",
  }
  if (typeof p.platforms === "string") row.platforms = p.platforms
  if (typeof p.variants === "string") row.variants = p.variants
  if (typeof p.start_date === "string") row.start_date = p.start_date
  if (typeof p.decision_date === "string") row.decision_date = p.decision_date
  if (typeof p.minimum_sample === "number") row.minimum_sample = p.minimum_sample
  if (typeof p.linked_campaign_ids === "string") row.linked_campaign_ids = p.linked_campaign_ids

  const inserted = await ctx.db.insert("experiments", row)
  const readBack = await ctx.db.findOne("experiments", inserted.id)

  return { id: inserted.id, row: readBack }
}

// ─── experiment_update (ungated) ──────────────────────────────────────────────

export async function experiment_update(params: unknown, ctx: AppCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  if (!ctx.db) throw new Error("experiment_update: ctx.db is required (app DB not available)")

  const experimentId = requireString(p, "experiment_id")
  const existing = await ctx.db.findOne("experiments", experimentId)
  if (!existing) throw new Error(`experiment_update: experiment ${experimentId} not found`)

  const patch: Record<string, unknown> = {}
  const stringFields = [
    "title",
    "hypothesis",
    "platforms",
    "primary_metric",
    "variants",
    "start_date",
    "decision_date",
    "linked_campaign_ids",
    "verdict",
    "learnings",
  ]
  for (const field of stringFields) {
    if (typeof p[field] === "string") patch[field] = p[field]
  }
  if (typeof p.minimum_sample === "number") patch.minimum_sample = p.minimum_sample
  if (typeof p.status === "string") {
    const validStatuses = ["draft", "running", "decided", "abandoned"]
    if (!validStatuses.includes(p.status)) {
      throw new Error(`experiment_update: status must be one of ${validStatuses.join(", ")}`)
    }
    patch.status = p.status
  }

  await ctx.db.update("experiments", experimentId, patch)
  const readBack = await ctx.db.findOne("experiments", experimentId)
  return { id: experimentId, row: readBack }
}

// ─── experiment_close (ungated) ───────────────────────────────────────────────

export async function experiment_close(params: unknown, ctx: AppCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  if (!ctx.db) throw new Error("experiment_close: ctx.db is required (app DB not available)")

  const experimentId = requireString(p, "experiment_id")
  const verdict = requireString(p, "verdict")
  const existing = await ctx.db.findOne("experiments", experimentId)
  if (!existing) throw new Error(`experiment_close: experiment ${experimentId} not found`)

  const patch: Record<string, unknown> = { status: "decided", verdict }
  if (typeof p.learnings === "string") patch.learnings = p.learnings

  await ctx.db.update("experiments", experimentId, patch)
  const readBack = await ctx.db.findOne("experiments", experimentId)
  return { id: experimentId, row: readBack }
}

// ─── experiment_list (ungated read) ───────────────────────────────────────────

export async function experiment_list(params: unknown, ctx: AppCtx): Promise<unknown> {
  if (!ctx.db) throw new Error("experiment_list: ctx.db is required (app DB not available)")
  const p = (params ?? {}) as Record<string, unknown>

  const where: Record<string, unknown> = {}
  if (typeof p.status === "string" && p.status) where.status = p.status

  const rows = await ctx.db.findMany("experiments", {
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { createdAt: "desc" },
    limit: typeof p.limit === "number" ? p.limit : undefined,
  })

  return {
    experiments: rows,
    count: rows.length,
    note:
      "Consult this list before proposing a new test (doctrine block G): do not re-run something already in flight or just concluded.",
  }
}
